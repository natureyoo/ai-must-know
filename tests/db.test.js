import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertSourceItems, getAllSourceItems, countSourceItems } from '../src/db/index.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

test('a fresh DB plus one collect run stores all fixture items correctly', () => {
  const db = openDb(':memory:');
  const items = getFixtureItems();
  upsertSourceItems(db, items);

  assert.equal(countSourceItems(db), items.length);

  const stored = getAllSourceItems(db);
  const byId = new Map(stored.map((i) => [i.id, i]));
  for (const item of items) {
    const row = byId.get(item.id);
    assert.ok(row, `expected ${item.id} to be stored`);
    assert.equal(row.url, item.url);
    assert.equal(row.title, item.title);
    assert.equal(row.sourceType, item.sourceType);
    assert.equal(row.publisherType, item.publisherType);
    assert.equal(row.category, item.category);
    assert.equal(row.publishedAt, item.publishedAt);
    assert.equal(row.collectedAt, item.collectedAt);
    assert.deepEqual(row.reactions, item.reactions);
  }
  db.close();
});

test('running collect twice against the same DB does not duplicate any item', () => {
  const db = openDb(':memory:');
  const items = getFixtureItems();

  upsertSourceItems(db, items);
  const firstCount = countSourceItems(db);

  upsertSourceItems(db, getFixtureItems());
  const secondCount = countSourceItems(db);

  assert.equal(firstCount, items.length);
  assert.equal(secondCount, items.length, 'row count must not grow on a re-collect of the same items');
  db.close();
});

test('upsert updates fields in place when an item is re-collected with changed data', () => {
  const db = openDb(':memory:');
  const items = getFixtureItems();
  upsertSourceItems(db, items);

  const changed = items.map((i) => (i.id === items[0].id ? { ...i, title: 'UPDATED TITLE', reactions: { ...i.reactions, shares: 999999 } } : i));
  upsertSourceItems(db, changed);

  assert.equal(countSourceItems(db), items.length, 'update must not create a new row');
  const stored = getAllSourceItems(db).find((i) => i.id === items[0].id);
  assert.equal(stored.title, 'UPDATED TITLE');
  assert.equal(stored.reactions.shares, 999999);
  db.close();
});

test('a persisted DB file survives being reopened (real disk persistence, not just in-memory)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'ai-must-know-db-test-'));
  const dbPath = join(dir, 'nested', 'app.db');
  try {
    const items = getFixtureItems();

    const db1 = openDb(dbPath);
    upsertSourceItems(db1, items);
    db1.close();

    const db2 = openDb(dbPath);
    assert.equal(countSourceItems(db2), items.length);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
