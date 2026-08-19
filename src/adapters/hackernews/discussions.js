// Live adapter: HN discussion lookup by URL (virality backfill).
//
// RSS feeds carry no engagement data — an OpenAI or DeepMind post arrives
// with `reactions: {}`, so the viral score has nothing to rank on and every
// company post lands on the same value. The signal exists, just not in the
// feed: it's on Hacker News, keyed by the same URL.
//
// This adapter looks up each primary-source URL on the HN Algolia search API
// and emits a normal `hn` SourceItem pointing at that same URL. Dedup then
// merges it with the primary item (same-URL rule), so the story inherits
// real points/comments and the cross-platform bonus — no mutation of the
// primary item, no special case in scoring.
//
// Verification is unaffected on purpose: a same-URL HN repost is not an
// independent source, and assessVerification already encodes that.
//
// Never throws — a failed lookup just yields no item for that URL.

import { createHash } from 'node:crypto';
import { assertValidSourceItem } from '../sourceItem.js';

const ALGOLIA_URL = 'https://hn.algolia.com/api/v1/search';

function idFor(url) {
  return `hn-discussion-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
}

// Algolia indexes the submitted URL verbatim; restricting the searchable
// attribute to `url` keeps a title-word match from returning an unrelated
// submission.
async function lookupOne(fetchImpl, url, timeoutMs, minPoints) {
  const query = `${ALGOLIA_URL}?query=${encodeURIComponent(url)}&restrictSearchableAttributes=url&hitsPerPage=5`;
  let payload;
  try {
    const res = await fetchImpl(query, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  // Algolia can return near-matches; keep only hits whose URL really is the
  // one we asked about (ignoring a trailing slash), then take the most
  // discussed submission — reposts of the same link are common.
  const norm = (u) => (u ?? '').replace(/\/+$/, '');
  // A 3-point thread is not a signal, but with 120 of them in the pool a
  // 70-point discussion rated the 90th percentile and a lab blog post with
  // that thread outranked a 1,354-point release. Below the floor the post
  // simply has no HN engagement, which is the truth.
  const exact = hits.filter((h) => norm(h.url) === norm(url) && (h.points ?? 0) >= minPoints);
  if (exact.length === 0) return null;
  return exact.reduce((a, b) => ((b.points ?? 0) > (a.points ?? 0) ? b : a));
}

export async function fetchHnDiscussions({
  urls = [],
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = 8000,
  concurrency = 6,
  minPoints = 20,
} = {}) {
  const unique = [...new Set(urls)];
  const items = [];

  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const hits = await Promise.all(batch.map((url) => lookupOne(fetchImpl, url, timeoutMs, minPoints)));

    for (const [j, hit] of hits.entries()) {
      if (!hit) continue;
      const url = batch[j];
      const points = hit.points ?? 0;
      const comments = hit.num_comments ?? 0;
      const item = {
        id: idFor(url),
        sourceType: 'hn',
        source: 'Hacker News',
        publisherType: 'community',
        category: null,
        title: hit.title || 'Hacker News discussion',
        url,
        summary: `Hacker News discussion of this link: ${points} points, ${comments} comments.`,
        publishedAt: hit.created_at ?? now.toISOString(),
        collectedAt: now.toISOString(),
        reactions: { points, comments },
      };
      try {
        assertValidSourceItem(item);
      } catch {
        continue;
      }
      items.push(item);
    }
  }

  return items;
}
