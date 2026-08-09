// Local persistence layer for collected SourceItems (src/adapters/sourceItem.js).
// Backed by node:sqlite (no dependency needed). Duplicate-collection prevention
// is a real DB-level uniqueness guarantee, not a clear-and-recreate hack:
// `id` is the primary key, and re-collecting the same item upserts in place
// instead of inserting a second row.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_items (
    id            TEXT PRIMARY KEY,
    sourceType    TEXT NOT NULL,
    source        TEXT NOT NULL,
    publisherType TEXT NOT NULL,
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL,
    publishedAt   TEXT NOT NULL,
    collectedAt   TEXT NOT NULL,
    category      TEXT,
    reactions     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS translations (
    id           TEXT PRIMARY KEY,
    hash         TEXT NOT NULL,
    titleKo      TEXT NOT NULL,
    summaryKo    TEXT NOT NULL,
    gistKo       TEXT NOT NULL,
    translatedAt TEXT NOT NULL
  );
`;

// Opens (creating if needed) the sqlite file at `path` and ensures the
// schema exists. Pass ':memory:' for an ephemeral DB (used by tests).
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

// Inserts or updates source items, keyed on `id` — running this twice with
// the same items leaves the row count unchanged (real duplicate prevention,
// not a delete-then-reinsert). Returns the number of items processed.
export function upsertSourceItems(db, items) {
  const stmt = db.prepare(`
    INSERT INTO source_items
      (id, sourceType, source, publisherType, url, title, summary, publishedAt, collectedAt, category, reactions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sourceType = excluded.sourceType,
      source = excluded.source,
      publisherType = excluded.publisherType,
      url = excluded.url,
      title = excluded.title,
      summary = excluded.summary,
      publishedAt = excluded.publishedAt,
      collectedAt = excluded.collectedAt,
      category = excluded.category,
      reactions = excluded.reactions
  `);
  for (const item of items) {
    stmt.run(
      item.id,
      item.sourceType,
      item.source,
      item.publisherType,
      item.url,
      item.title,
      item.summary,
      item.publishedAt,
      item.collectedAt,
      item.category ?? null,
      JSON.stringify(item.reactions),
    );
  }
  return items.length;
}

function rowToItem(row) {
  return { ...row, reactions: JSON.parse(row.reactions) };
}

export function getAllSourceItems(db) {
  return db.prepare('SELECT * FROM source_items ORDER BY publishedAt DESC').all().map(rowToItem);
}

export function countSourceItems(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM source_items').get().n;
}

// "이 데이터는 언제 기준인가" — the newest collectedAt across every stored
// item. The UI shows this as the as-of stamp, and the static build embeds it
// in the snapshot, so a page served hours later never implies it is live.
export function latestCollectedAt(db) {
  return db.prepare('SELECT MAX(collectedAt) AS at FROM source_items').get().at ?? null;
}

// Korean renderings of an item's title/summary, keyed by item id and hashed
// on the source text — see src/translate. Kept in its own table so re-running
// collect never re-pays for text that has not changed.
export function upsertTranslations(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO translations (id, hash, titleKo, summaryKo, gistKo, translatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      hash = excluded.hash,
      titleKo = excluded.titleKo,
      summaryKo = excluded.summaryKo,
      gistKo = excluded.gistKo,
      translatedAt = excluded.translatedAt
  `);
  for (const r of rows) stmt.run(r.id, r.hash, r.titleKo, r.summaryKo, r.gistKo, r.translatedAt);
  return rows.length;
}

export function getTranslations(db) {
  return new Map(db.prepare('SELECT * FROM translations').all().map((r) => [r.id, r]));
}
