import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';
import { validateSourceItem, CATEGORIES } from '../src/adapters/sourceItem.js';

const DEDUP_THRESHOLD = 0.5;

function wordsOf(title) {
  return new Set(title.toLowerCase().match(/[a-z0-9.]+/g) ?? []);
}

// Same tokenizer/ratio a real title-similarity dedup pass would plausibly use,
// so these tests double as proof the fixtures are mergeable at a defensible
// threshold (not just superficially similar).
function titleOverlapRatio(a, b) {
  const A = wordsOf(a);
  const B = wordsOf(b);
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.min(A.size, B.size);
}

// Approximate story clustering (same URL, or title overlap over threshold)
// via union-find, purely to sanity-check the fixture set has enough
// distinguishable stories — not a stand-in for the real dedup implementation.
function countStories(items, threshold = DEDUP_THRESHOLD) {
  const parent = items.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i, j) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].url === items[j].url || titleOverlapRatio(items[i].title, items[j].title) >= threshold) {
        union(i, j);
      }
    }
  }
  return new Set(items.map((_, i) => find(i))).size;
}

test('fixture loader returns a non-empty array of well-formed items', () => {
  const items = getFixtureItems();
  assert.ok(Array.isArray(items) && items.length > 0);
  for (const item of items) {
    assert.deepEqual(validateSourceItem(item), [], `item ${item.id} should be valid`);
  }
});

test('fixture ids are unique', () => {
  const items = getFixtureItems();
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('all seven categories are represented', () => {
  const items = getFixtureItems();
  const present = new Set(items.map((i) => i.category));
  for (const category of CATEGORIES) {
    assert.ok(present.has(category), `missing category: ${category}`);
  }
});

test('contains a same-URL duplicate pair (for future dedup)', () => {
  const items = getFixtureItems();
  const byUrl = new Map();
  for (const item of items) byUrl.set(item.url, (byUrl.get(item.url) ?? 0) + 1);
  const duplicated = [...byUrl.values()].some((count) => count >= 2);
  assert.ok(duplicated, 'expected at least one URL shared by two items');
});

test('contains a similar-title/claim duplicate pair with different URLs (for future dedup)', () => {
  const items = getFixtureItems();
  const a = items.find((i) => i.id === 'rss-mistral-series-c-official');
  const b = items.find((i) => i.id === 'rss-techcrunch-mistral-funding-report');
  assert.ok(a && b, 'expected the designated near-duplicate pair to exist');
  assert.notEqual(a.url, b.url);
  assert.ok(
    titleOverlapRatio(a.title, b.title) >= DEDUP_THRESHOLD,
    'expected title overlap at a defensible dedup threshold',
  );
});

test('contains a cross-platform overlap (same URL observed via two sourceTypes)', () => {
  const items = getFixtureItems();
  const byUrl = new Map();
  for (const item of items) {
    if (!byUrl.has(item.url)) byUrl.set(item.url, new Set());
    byUrl.get(item.url).add(item.sourceType);
  }
  const crossPlatform = [...byUrl.values()].some((types) => types.size >= 2);
  assert.ok(crossPlatform, 'expected one URL observed under two different sourceTypes');
});

test('contains both company press releases and independent reporting', () => {
  const items = getFixtureItems();
  const publisherTypes = new Set(items.map((i) => i.publisherType));
  assert.ok(publisherTypes.has('company'));
  assert.ok(publisherTypes.has('independent-media'));
});

test('reaction metrics vary by platform shape (hn vs github vs generic)', () => {
  const items = getFixtureItems();
  const hn = items.find((i) => i.sourceType === 'hn');
  const github = items.find((i) => i.sourceType === 'github');
  assert.ok(typeof hn.reactions.points === 'number' && typeof hn.reactions.comments === 'number');
  assert.ok(typeof github.reactions.stars === 'number' && typeof github.reactions.forks === 'number');
});

test('hn and github each have enough items for a meaningful platform percentile', () => {
  const items = getFixtureItems();
  const countBy = (type) => items.filter((i) => i.sourceType === type).length;
  assert.ok(countBy('hn') >= 3, 'expected at least 3 hn items');
  assert.ok(countBy('github') >= 3, 'expected at least 3 github items');
});

test('a cluster exists with a government primary source plus two independent outlets (strict Verified material)', () => {
  const items = getFixtureItems();
  const cluster = items.filter((i) => i.id.includes('eu-ai-act-guidance'));
  assert.equal(cluster.length, 3);
  const urls = new Set(cluster.map((i) => i.url));
  assert.equal(urls.size, 3, 'expected three distinct URLs');
  assert.ok(cluster.some((i) => i.publisherType === 'government'));
  const independentCount = cluster.filter((i) => i.publisherType === 'independent-media').length;
  assert.ok(independentCount >= 2, 'expected at least two independent-media sources');
});

test('contains a structural Disputed pair: a company claim and an independent report that it does not reproduce', () => {
  const items = getFixtureItems();
  const claim = items.find((i) => i.id === 'rss-neomind-benchmark-claim');
  const rebuttal = items.find((i) => i.id === 'hn-neomind-benchmark-disputed');
  assert.ok(claim && rebuttal, 'expected the designated disputed pair to exist');
  assert.equal(claim.publisherType, 'company');
  assert.notEqual(rebuttal.publisherType, 'company');
  assert.equal(claim.category, rebuttal.category);
  assert.notEqual(claim.url, rebuttal.url);
  assert.ok(
    titleOverlapRatio(claim.title, rebuttal.title) >= DEDUP_THRESHOLD,
    'the pair must actually be mergeable into one story, or Disputed can never fire',
  );
});

test('contains an Unverified candidate: a lone community claim with nothing to corroborate it', () => {
  const items = getFixtureItems();
  const claim = items.find((i) => i.id === 'hn-jailbreak-claim-unverified');
  assert.ok(claim);
  assert.equal(claim.publisherType, 'community');
  const others = items.filter((i) => i.id !== claim.id);
  assert.ok(others.every((i) => i.url !== claim.url), 'expected no same-URL corroboration');
  assert.ok(
    others.every((i) => titleOverlapRatio(claim.title, i.title) < DEDUP_THRESHOLD),
    'expected no near-duplicate corroboration either',
  );
});

test('today (last 24h) contains at least 5 distinct stories, enough to fill a top-5 home page', () => {
  const items = getFixtureItems();
  const nowMs = Date.now();
  const recent = items.filter((i) => nowMs - Date.parse(i.publishedAt) < 24 * 3600 * 1000);
  assert.ok(
    countStories(recent) >= 5,
    `expected >=5 distinct stories within 24h, got ${countStories(recent)} from ${recent.length} items`,
  );
});

test('getFixtureItems returns fresh copies (callers cannot mutate canonical data)', () => {
  const first = getFixtureItems();
  first[0].title = 'MUTATED';
  first[0].reactions.shares = -1;
  const second = getFixtureItems();
  assert.notEqual(second[0].title, 'MUTATED');
  assert.notEqual(second[0].reactions.shares, -1);
});

test('timestamps are computed relative to an injectable `now` (deterministic, and stay recent)', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  const items = getFixtureItems({ now });
  const gpt5 = items.find((i) => i.id === 'rss-openai-gpt5-2-launch');
  assert.equal(gpt5.publishedAt, new Date(now.getTime() - 8 * 3600 * 1000).toISOString());

  const liveItems = getFixtureItems();
  const nowMs = Date.now();
  for (const item of liveItems) {
    const publishedMs = Date.parse(item.publishedAt);
    assert.ok(publishedMs <= nowMs, `${item.id} publishedAt must not be in the future`);
    assert.ok(nowMs - publishedMs < 15 * 24 * 3600 * 1000, `${item.id} should still read as recent`);
  }
});
