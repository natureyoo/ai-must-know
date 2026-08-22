// Live adapter: Hugging Face Daily Papers (public JSON API, no key).
//
// Research was the one category with no source of its own. Papers reached
// the dashboard only when Hacker News happened to submit an arXiv link, so
// a week could pass with nothing in 연구 but a Terence Tao essay. The raw
// arXiv firehose is the obvious fix and the wrong one — cs.LG alone is
// hundreds of submissions a day, none of them ranked. Daily Papers is that
// firehose already filtered by people who read it, and the upvote count
// gives the viral score something real to rank on.
//
// Its own sourceType, not `hf`: viral and impact are percentiles *within a
// platform's* magnitude pool, and paper upvotes (tens) share no scale with
// model downloads (millions). Pooled together every paper would sit at the
// bottom percentile of `hf` forever.
//
// The item's URL is the arXiv abstract, not the Hugging Face page: that is
// the primary source, it is what HN submits (so dedup merges the two by
// canonical URL), and unlike most of the web it serves plain HTML that
// src/enrich/article.js can actually read.
//
// Never throws — an unreachable API or a shape change yields no items.

import { assertValidSourceItem } from '../sourceItem.js';

const API_URL = 'https://huggingface.co/api/daily_papers';

export async function fetchHuggingFacePapers({
  fetchImpl = fetch,
  now = new Date(),
  limit = 100,
  // A rank cap, not an upvote threshold: HF's absolute upvote numbers drift
  // with Hub traffic, so a fixed floor admits twenty papers one month and two
  // the next. Taking the most-upvoted N of the window holds research at
  // roughly a fifth of the page whatever the numbers do.
  //
  // The cap is doing more work than it looks like. Viral and impact are
  // percentiles *within a platform's own pool*, so a small pool of curated
  // papers puts its own best items at the 95th percentile no matter how they
  // compare to the week's model releases — and research carries the second
  // highest category weight on top of that. Left uncapped at 28 papers, this
  // source took ten of the top twenty-four slots and six of the top ten,
  // which is an arXiv digest, not a daily briefing.
  //
  // ponytail: bounds the count because the percentile model can't compare
  // across platforms — a real cross-platform calibration of viral would
  // remove the need for this knob.
  maxPapers = 12,
  // Below this a paper has one person's bookmark, not discussion. Only a
  // guard against a quiet day promoting noise; the cap is the real control.
  minUpvotes = 10,
  maxAgeDays = 30,
  timeoutMs = 10000,
} = {}) {
  let payload;
  try {
    const res = await fetchImpl(`${API_URL}?limit=${limit}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    payload = await res.json();
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const cutoff = now.getTime() - maxAgeDays * 24 * 3600 * 1000;
  const items = [];

  for (const entry of payload) {
    const paper = entry?.paper;
    if (!paper?.id || typeof paper.id !== 'string') continue;
    const upvotes = Number.isFinite(paper.upvotes) ? paper.upvotes : 0;
    if (upvotes < minUpvotes) continue;

    // submittedOnDailyAt is when it was surfaced to readers; paper.publishedAt
    // is when it hit arXiv. The second is the story's real date — the first
    // would date a month-old paper as today's news the day someone submits it.
    const publishedAt = Date.parse(paper.publishedAt ?? entry.publishedAt ?? '');
    if (!Number.isFinite(publishedAt) || publishedAt < cutoff) continue;

    const title = String(entry.title ?? paper.title ?? '').replace(/\s+/g, ' ').trim();
    const summary = String(paper.summary ?? entry.summary ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;

    const item = {
      id: `paper-${paper.id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`,
      sourceType: 'papers',
      // The publisher is arXiv, not Hugging Face: HF curated it, it did not
      // publish it. Verification counts independent *origins*, and calling
      // every paper "Hugging Face" would make two unrelated papers look like
      // one publisher corroborating itself.
      source: `arXiv:${paper.id}`,
      publisherType: 'research-org',
      category: 'research',
      title,
      url: `https://arxiv.org/abs/${paper.id}`,
      summary: summary.slice(0, 500) || title,
      publishedAt: new Date(publishedAt).toISOString(),
      collectedAt: now.toISOString(),
      reactions: {
        upvotes,
        comments: Number.isFinite(entry.numComments) ? entry.numComments : 0,
      },
    };

    try {
      assertValidSourceItem(item);
    } catch {
      continue;
    }
    items.push(item);
  }

  return items.sort((a, b) => b.reactions.upvotes - a.reactions.upvotes).slice(0, maxPapers);
}
