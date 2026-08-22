import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertSourceItems } from '../src/db/index.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';
import { getStoryViews, sortStoryViews, filterByCategory, handleRequest, buildStoryView } from '../src/server/index.js';

function seededDb() {
  const db = openDb(':memory:');
  upsertSourceItems(db, getFixtureItems());
  return db;
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(status) {
      this.statusCode = status;
    },
    end(payload) {
      this.body = payload;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

const SORT_VALUE = {
  viral: (v) => v.scores.viral.value,
  credibility: (v) => v.scores.credibility.value,
  impact: (v) => v.scores.impact.value,
  recent: (v) => Date.parse(v.latestPublishedAt),
};

test('getStoryViews produces one view per deduped story with real computed scores', () => {
  const db = seededDb();
  const views = getStoryViews(db);
  db.close();

  assert.ok(views.length > 0);
  assert.ok(views.length < getFixtureItems().length, 'dedup must merge some near-duplicate items');
  for (const v of views) {
    assert.equal(typeof v.scores.viral.value, 'number');
    assert.equal(typeof v.scores.mustKnow.value, 'number');
    assert.ok(v.verification.status);
    assert.ok(v.sources.length > 0);
  }
});

for (const sortBy of ['viral', 'credibility', 'impact', 'recent']) {
  test(`sortStoryViews('${sortBy}') orders stories by real computed ${sortBy} value, descending`, () => {
    const db = seededDb();
    const views = getStoryViews(db);
    db.close();

    const sorted = sortStoryViews(views, sortBy);
    const values = sorted.map(SORT_VALUE[sortBy]);
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i - 1] >= values[i], `expected non-increasing ${sortBy} order at index ${i}`);
    }
    const expectedTop = [...views].sort((a, b) => SORT_VALUE[sortBy](b) - SORT_VALUE[sortBy](a))[0];
    assert.equal(sorted[0].id, expectedTop.id);
  });
}

test('different sort criteria produce different orderings (not all driven by one hardcoded field)', () => {
  const db = seededDb();
  const views = getStoryViews(db);
  db.close();

  const orders = ['viral', 'credibility', 'impact', 'recent'].map((k) => sortStoryViews(views, k).map((v) => v.id).join(','));
  assert.ok(new Set(orders).size > 1, 'expected at least two sort criteria to produce a different order');
});

test('filterByCategory excludes stories outside the requested category', () => {
  const db = seededDb();
  const views = getStoryViews(db);
  db.close();

  const filtered = filterByCategory(views, 'policy');
  assert.ok(filtered.length > 0);
  assert.ok(filtered.length < views.length);
  for (const v of filtered) assert.equal(v.category, 'policy');
});

test('GET /api/stories?category=... only returns matching stories via the real HTTP handler', () => {
  const db = seededDb();
  const res = mockRes();
  handleRequest({ method: 'GET', url: '/api/stories?category=funding' }, res, db);
  db.close();

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.stories.length > 0);
  for (const s of body.stories) assert.equal(s.category, 'funding');
});

test('GET /api/stories?sort=viral reorders results through the real HTTP handler', () => {
  const db = seededDb();
  const res = mockRes();
  handleRequest({ method: 'GET', url: '/api/stories?sort=viral' }, res, db);
  db.close();

  const { stories } = res.json();
  const values = stories.map((s) => s.scores.viral.value);
  for (let i = 1; i < values.length; i++) assert.ok(values[i - 1] >= values[i]);
});

test('GET /api/stories?category=bogus rejects an unknown category', () => {
  const db = seededDb();
  const res = mockRes();
  handleRequest({ method: 'GET', url: '/api/stories?category=bogus' }, res, db);
  db.close();
  assert.equal(res.statusCode, 400);
});

test('GET /api/stories/:id returns full detail with score breakdown and evidence links', () => {
  const db = seededDb();
  const listRes = mockRes();
  handleRequest({ method: 'GET', url: '/api/stories' }, listRes, db);
  const target = listRes.json().stories[0];

  const detailRes = mockRes();
  handleRequest({ method: 'GET', url: `/api/stories/${encodeURIComponent(target.id)}` }, detailRes, db);
  db.close();

  assert.equal(detailRes.statusCode, 200);
  const detail = detailRes.json();
  assert.equal(detail.id, target.id);
  assert.ok(detail.timeline.length > 0);
  assert.ok(detail.scores.viral.rationale.length > 0);
  assert.ok(detail.scores.credibility.rationale.length > 0);
  assert.ok(detail.scores.impact.rationale.length > 0);
  assert.ok(detail.scores.influence.rationale.length > 0);
  assert.ok(detail.sources.every((s) => typeof s.url === 'string' && s.url.startsWith('http')));
  assert.ok(Object.keys(detail.reactionsByPlatform).length > 0);
});

test('GET /api/stories/:id returns 404 for an unknown id', () => {
  const db = seededDb();
  const res = mockRes();
  handleRequest({ method: 'GET', url: '/api/stories/does-not-exist' }, res, db);
  db.close();
  assert.equal(res.statusCode, 404);
});

// Regression: the 최근 7일 tab filters on latestPublishedAt, and Hugging Face
// community re-uploads (GGUF quants, "abliterated" forks) keep arriving for
// weeks after a model ships. One of them held Qwen 3.8 27B at #1 of that tab
// nine days after release, with the card still reading "9일 전".
function hfItem(id, owner, publisherType, publishedAt) {
  return {
    id,
    source: owner,
    sourceType: 'hf',
    publisherType,
    url: `https://huggingface.co/${owner}/model`,
    title: `Model — ${owner}`,
    summary: '',
    publishedAt,
    collectedAt: publishedAt,
    reactions: {},
  };
}

const NO_SCORES = { verification: { status: 'official-claim' }, scores: {} };

test('a community re-upload does not refresh a story it was merged into', () => {
  const items = [
    hfItem('a', 'Qwen', 'company', '2026-08-13T00:00:00.000Z'),
    hfItem('b', 'unsloth', 'community', '2026-08-19T00:00:00.000Z'),
  ];
  const view = buildStoryView({ id: 's', title: items[0].title, items }, NO_SCORES);

  assert.equal(view.firstPublishedAt, '2026-08-13T00:00:00.000Z');
  assert.equal(view.latestPublishedAt, '2026-08-13T00:00:00.000Z', 're-upload must not count as coverage');
});

test('a community upload that is the whole story keeps its own date', () => {
  const items = [hfItem('a', 'unsloth', 'community', '2026-08-19T00:00:00.000Z')];
  const view = buildStoryView({ id: 's', title: items[0].title, items }, NO_SCORES);

  assert.equal(view.latestPublishedAt, '2026-08-19T00:00:00.000Z');
});

test('real follow-up coverage still refreshes the story', () => {
  const items = [
    hfItem('a', 'DeepSeek', 'company', '2026-08-13T00:00:00.000Z'),
    { ...hfItem('b', 'MarkTechPost', 'independent-media', '2026-08-17T00:00:00.000Z'), sourceType: 'rss' },
  ];
  const view = buildStoryView({ id: 's', title: items[0].title, items }, NO_SCORES);

  assert.equal(view.latestPublishedAt, '2026-08-17T00:00:00.000Z');
});
