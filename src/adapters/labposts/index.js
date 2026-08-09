// Live adapter: primary-source posts from labs that publish no RSS feed.
//
// Not every lab exposes a feed — anthropic.com returns 404 for every common
// RSS path — so a feed-only collector can never carry their announcements,
// only other outlets' coverage of them. HN's search index is keyed by
// submitted URL, so searching it by domain surfaces the lab's own posts with
// their canonical URLs.
//
// This emits the *primary* item (the lab's post). The collect pipeline's HN
// backfill then attaches the matching discussion as a same-URL `hn` item, so
// these end up in exactly the same shape as feed-collected posts: company
// origin for verification, real engagement for the viral score.
//
// Never throws — an unreachable search just yields no items for that domain.

import { createHash } from 'node:crypto';
import { assertValidSourceItem } from '../sourceItem.js';

const ALGOLIA_URL = 'https://hn.algolia.com/api/v1/search_by_date';

// Labs with no public feed. Feed-published labs stay in rss/DEFAULT_FEEDS —
// a feed is authoritative and complete, this is discovery-by-proxy.
export const FEEDLESS_LABS = [
  { domain: 'anthropic.com', source: 'Anthropic', publisherType: 'company' },
  { domain: 'ai.meta.com', source: 'Meta AI', publisherType: 'company' },
  { domain: 'mistral.ai', source: 'Mistral AI', publisherType: 'company' },
  { domain: 'x.ai', source: 'xAI', publisherType: 'company' },
];

function idFor(url) {
  return `lab-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
}

async function searchDomain(fetchImpl, lab, { minPoints, hitsPerPage, timeoutMs }) {
  const query =
    `${ALGOLIA_URL}?query=${encodeURIComponent(lab.domain)}` +
    `&restrictSearchableAttributes=url&hitsPerPage=${hitsPerPage}` +
    `&numericFilters=${encodeURIComponent(`points>${minPoints}`)}`;
  try {
    const res = await fetchImpl(query, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const payload = await res.json();
    return Array.isArray(payload?.hits) ? payload.hits : [];
  } catch {
    return [];
  }
}

export async function fetchLabPosts({
  labs = FEEDLESS_LABS,
  fetchImpl = fetch,
  now = new Date(),
  minPoints = 20,
  hitsPerPage = 20,
  maxAgeDays = 30,
  timeoutMs = 8000,
} = {}) {
  const cutoff = now.getTime() - maxAgeDays * 24 * 3600 * 1000;
  const items = [];
  const seen = new Set();

  const perLab = await Promise.all(
    labs.map((lab) => searchDomain(fetchImpl, lab, { minPoints, hitsPerPage, timeoutMs })),
  );

  for (const [i, hits] of perLab.entries()) {
    const lab = labs[i];
    for (const hit of hits) {
      const url = hit?.url;
      // The index matches substrings, so a link merely *mentioning* the
      // domain elsewhere in its URL can come back — require the real host.
      if (!url || seen.has(url)) continue;
      let host;
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      if (host !== lab.domain && !host.endsWith(`.${lab.domain}`)) continue;

      const publishedAt = hit.created_at ? Date.parse(hit.created_at) : NaN;
      if (!Number.isFinite(publishedAt) || publishedAt < cutoff) continue;

      const item = {
        id: idFor(url),
        sourceType: 'rss',
        source: lab.source,
        publisherType: lab.publisherType,
        category: null,
        title: hit.title || lab.source,
        url,
        summary: `${lab.source} published this on ${lab.domain}.`,
        publishedAt: new Date(publishedAt).toISOString(),
        collectedAt: now.toISOString(),
        // Left empty on purpose: engagement is attached by the pipeline's HN
        // backfill, the same way it is for feed-collected posts.
        reactions: {},
      };

      try {
        assertValidSourceItem(item);
      } catch {
        continue;
      }
      seen.add(url);
      items.push(item);
    }
  }

  return items;
}
