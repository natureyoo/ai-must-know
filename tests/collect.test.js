import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectItems, persistItems } from '../src/collect/index.js';
import { openDb, countSourceItems, getAllSourceItems } from '../src/db/index.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

const fixtureCountByType = (sourceType) => getFixtureItems().filter((i) => i.sourceType === sourceType).length;

test('collectItems falls back to fixtures for a source whose live fetch rejects, without affecting other sources', async () => {
  const liveGithubItem = {
    id: 'github-live-1',
    sourceType: 'github',
    source: 'GitHub',
    publisherType: 'community',
    category: 'open-source',
    title: 'Live repo',
    url: 'https://github.com/live/repo',
    summary: 'A live result.',
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    reactions: { stars: 5 },
  };
  const sources = [
    { label: 'RSS', sourceType: 'rss', fetchLive: async () => { throw new Error('network down'); } },
    { label: 'Hacker News', sourceType: 'hn', fetchLive: async () => [] },
    { label: 'GitHub', sourceType: 'github', fetchLive: async () => [liveGithubItem] },
  ];
  const logs = [];

  const items = await collectItems({ sources, log: (msg) => logs.push(msg) });

  const rssItems = items.filter((i) => i.sourceType === 'rss');
  const hnItems = items.filter((i) => i.sourceType === 'hn');
  const githubItems = items.filter((i) => i.sourceType === 'github');

  assert.equal(rssItems.length, fixtureCountByType('rss'), 'rejected RSS source must fall back to rss fixtures');
  assert.equal(hnItems.length, fixtureCountByType('hn'), 'empty-result HN source must fall back to hn fixtures');
  assert.deepEqual(githubItems, [liveGithubItem], 'GitHub live result must be used as-is, not replaced by fixtures');
  assert.ok(logs.some((l) => l.includes('fixture')), 'a fallback must be logged');
});

test('the fixture fallback still persists successfully through the real DB upsert path', async () => {
  const sources = [
    { label: 'RSS', sourceType: 'rss', fetchLive: async () => { throw new Error('network down'); } },
    { label: 'Hacker News', sourceType: 'hn', fetchLive: async () => { throw new Error('network down'); } },
    { label: 'GitHub', sourceType: 'github', fetchLive: async () => { throw new Error('network down'); } },
  ];

  const items = await collectItems({ sources, log: () => {} });
  assert.equal(items.length, getFixtureItems().length, 'total fallback item count must match the full fixture set when every live source fails');

  const db = openDb(':memory:');
  try {
    const total = persistItems(db, items);
    assert.equal(total, items.length);
    assert.equal(countSourceItems(db), items.length);
    assert.ok(getAllSourceItems(db).length > 0);
  } finally {
    db.close();
  }
});

test('collectItems includes fixture-sourceType items that have no live adapter, regardless of live outcomes', async () => {
  const sources = [
    { label: 'RSS', sourceType: 'rss', fetchLive: async () => [] },
    { label: 'Hacker News', sourceType: 'hn', fetchLive: async () => [] },
    { label: 'GitHub', sourceType: 'github', fetchLive: async () => [] },
  ];

  const items = await collectItems({ sources, log: () => {} });
  const fixtureOnly = items.filter((i) => i.sourceType === 'fixture');
  assert.equal(fixtureOnly.length, fixtureCountByType('fixture'));
});
