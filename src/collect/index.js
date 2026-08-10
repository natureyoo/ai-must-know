// Collection pipeline: for each live source, run its adapter (src/adapters/*).
// Every live adapter already never throws (internal per-feed/per-item
// try/catch) and returns [] when its source is unreachable or empty — so a
// source with zero live results falls back to that source type's fixture
// items here, independently of the other sources. This keeps the app usable
// offline without masking which specific source actually failed.

import { getFixtureItems } from '../adapters/fixtures/index.js';
import { fetchRssItems } from '../adapters/rss/index.js';
import { fetchHackerNewsItems } from '../adapters/hackernews/index.js';
import { fetchHnDiscussions } from '../adapters/hackernews/discussions.js';
import { fetchGithubItems } from '../adapters/github/index.js';
import { fetchHuggingFaceModels } from '../adapters/huggingface/index.js';
import { fetchLabPosts } from '../adapters/labposts/index.js';
import { assertValidSourceItem } from '../adapters/sourceItem.js';
import { upsertSourceItems, countSourceItems } from '../db/index.js';

// Feed-published labs come from RSS; feedless ones (Anthropic et al.) are
// discovered by domain on HN. Both yield the same `rss`-bucket primary items,
// so they share one source entry and one fixture fallback.
async function fetchWebPosts() {
  const [feeds, labs] = await Promise.all([
    fetchRssItems().catch(() => []),
    fetchLabPosts().catch(() => []),
  ]);
  const seen = new Set(feeds.map((i) => i.url));
  return [...feeds, ...labs.filter((i) => !seen.has(i.url))];
}

const LIVE_SOURCES = [
  { label: 'RSS', sourceType: 'rss', fetchLive: fetchWebPosts },
  { label: 'Hacker News', sourceType: 'hn', fetchLive: fetchHackerNewsItems },
  { label: 'GitHub', sourceType: 'github', fetchLive: fetchGithubItems },
  { label: 'Hugging Face', sourceType: 'hf', fetchLive: fetchHuggingFaceModels },
];

async function collectSource({ label, sourceType, fetchLive }, fixtures, log) {
  let items = [];
  try {
    items = await fetchLive();
  } catch {
    items = [];
  }
  if (items.length > 0) {
    log(`${label}: collected ${items.length} live item(s).`);
    return items;
  }
  const fallback = fixtures.filter((item) => item.sourceType === sourceType);
  log(`${label}: live collection unavailable, using ${fallback.length} fixture item(s) instead.`);
  return fallback;
}

// Runs every configured source independently and returns the combined item
// list (live where possible, fixture fallback per-source otherwise), plus
// any fixture items whose sourceType has no live adapter at all (e.g. the
// 'fixture' sourceType). `sources`/`getFixtures`/`log` are overridable so
// tests can simulate a live-source failure without a real network call.
export async function collectItems({
  sources = LIVE_SOURCES,
  getFixtures = getFixtureItems,
  log = console.log,
  backfillDiscussions = fetchHnDiscussions,
} = {}) {
  const fixtures = getFixtures();
  const covered = new Set(sources.map((s) => s.sourceType));
  const results = await Promise.all(sources.map((source) => collectSource(source, fixtures, log)));
  const uncovered = fixtures.filter((item) => !covered.has(item.sourceType));

  const items = [...results.flat(), ...uncovered];

  // Virality backfill: RSS carries no engagement data, so a company/lab post
  // arrives with empty reactions and the viral score has nothing to rank on.
  // Look those URLs up on HN and add the discussion as its own same-URL item;
  // dedup merges the pair, so the story picks up real points/comments.
  const needsSignal = items
    .filter((i) => i.sourceType === 'rss' && Object.keys(i.reactions ?? {}).length === 0)
    .map((i) => i.url);
  if (needsSignal.length > 0) {
    let discussions = [];
    try {
      discussions = await backfillDiscussions({ urls: needsSignal });
    } catch {
      discussions = [];
    }
    log(`HN backfill: found discussions for ${discussions.length}/${needsSignal.length} link(s) with no feed engagement data.`);
    items.push(...discussions);
  }

  for (const item of items) assertValidSourceItem(item);
  return items;
}

export function persistItems(db, items) {
  upsertSourceItems(db, items);
  return countSourceItems(db);
}
