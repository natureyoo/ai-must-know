import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertSourceItems, getTranslations, latestCollectedAt } from '../src/db/index.js';
import { translateItems, contentHash } from '../src/translate/index.js';
import { getStoryViews } from '../src/server/index.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

function items(n = 2) {
  return getFixtureItems().slice(0, n);
}

// Stands in for the OpenAI endpoint: records every call and answers with the
// shape src/translate expects.
function fakeOpenAI({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (fail) return { ok: false, status: 429, text: async () => 'rate limited' };
    const sent = JSON.parse(init.body).messages[1].content;
    const payload = JSON.parse(sent).items.map((i) => ({
      id: i.id,
      titleKo: `[번역] ${i.title}`,
      gistKo: '한 줄 핵심',
      summaryKo: `[번역] ${i.summary}`,
    }));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ items: payload }) } }] }),
    };
  };
  return { fetchImpl, calls };
}

test('no API key: translation is skipped, items stay English, collection is unaffected', async () => {
  const db = openDb(':memory:');
  const { fetchImpl, calls } = fakeOpenAI();

  const count = await translateItems(db, items(), { apiKey: '', fetchImpl, log: () => {} });

  assert.equal(count, 0);
  assert.equal(calls.length, 0, 'must not call the API without a key');
  assert.equal(getTranslations(db).size, 0);
  db.close();
});

test('translates new items and persists Korean title, gist, and summary', async () => {
  const db = openDb(':memory:');
  const { fetchImpl, calls } = fakeOpenAI();
  const input = items(2);

  const count = await translateItems(db, input, { apiKey: 'sk-test', fetchImpl, log: () => {} });

  assert.equal(count, 2);
  assert.equal(calls.length, 1, 'two items fit in one batch');
  const stored = getTranslations(db);
  for (const item of input) {
    const row = stored.get(item.id);
    assert.ok(row, `expected a translation row for ${item.id}`);
    assert.equal(row.titleKo, `[번역] ${item.title}`);
    assert.equal(row.gistKo, '한 줄 핵심');
    assert.equal(row.hash, contentHash(item));
  }
  db.close();
});

test('re-running collection does not re-translate unchanged items (this is what keeps the daily run cheap)', async () => {
  const db = openDb(':memory:');
  const input = items(3);

  const first = fakeOpenAI();
  await translateItems(db, input, { apiKey: 'sk-test', fetchImpl: first.fetchImpl, log: () => {} });

  const second = fakeOpenAI();
  const count = await translateItems(db, input, { apiKey: 'sk-test', fetchImpl: second.fetchImpl, log: () => {} });

  assert.equal(count, 0);
  assert.equal(second.calls.length, 0, 'unchanged items must not hit the API a second time');
  db.close();
});

test('an edited title re-translates only that item', async () => {
  const db = openDb(':memory:');
  const input = items(3);

  const first = fakeOpenAI();
  await translateItems(db, input, { apiKey: 'sk-test', fetchImpl: first.fetchImpl, log: () => {} });

  const edited = [{ ...input[0], title: `${input[0].title} (updated)` }, input[1], input[2]];
  const second = fakeOpenAI();
  const count = await translateItems(db, edited, { apiKey: 'sk-test', fetchImpl: second.fetchImpl, log: () => {} });

  assert.equal(count, 1);
  assert.equal(second.calls.length, 1);
  assert.deepEqual(second.calls[0].body.messages[1].content.includes(edited[0].title), true);
  assert.equal(getTranslations(db).get(edited[0].id).titleKo, `[번역] ${edited[0].title}`);
  db.close();
});

test('an API failure never breaks collection — items just stay English', async () => {
  const db = openDb(':memory:');
  const { fetchImpl } = fakeOpenAI({ fail: true });

  const count = await translateItems(db, items(2), { apiKey: 'sk-test', fetchImpl, log: () => {} });

  assert.equal(count, 0);
  assert.equal(getTranslations(db).size, 0);
  db.close();
});

test('a malformed API response is discarded rather than stored', async () => {
  const db = openDb(':memory:');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ items: [{ id: 'not-a-real-id', titleKo: '침입', gistKo: '', summaryKo: '' }] }) } }],
    }),
  });

  const count = await translateItems(db, items(2), { apiKey: 'sk-test', fetchImpl, log: () => {} });

  assert.equal(count, 0, 'unknown ids and empty fields must be rejected');
  assert.equal(getTranslations(db).size, 0);
  db.close();
});

test('story views carry Korean text when translated and null when not', async () => {
  const db = openDb(':memory:');
  const input = items(4);
  upsertSourceItems(db, input);

  const untranslated = getStoryViews(db, { includeFixtures: true });
  assert.ok(untranslated.length > 0);
  assert.ok(untranslated.every((v) => v.titleKo === null && v.gistKo === null));

  const { fetchImpl } = fakeOpenAI();
  await translateItems(db, input, { apiKey: 'sk-test', fetchImpl, log: () => {} });

  const translated = getStoryViews(db, { includeFixtures: true });
  assert.ok(translated.some((v) => v.titleKo?.startsWith('[번역]')), 'expected at least one Korean title in the view');
  assert.ok(translated.some((v) => v.gistKo === '한 줄 핵심'));
  db.close();
});

test('latestCollectedAt reports the newest collection time, which is what the UI stamps the page with', () => {
  const db = openDb(':memory:');
  assert.equal(latestCollectedAt(db), null, 'empty DB has no as-of date');

  const [a, b] = items(2);
  upsertSourceItems(db, [
    { ...a, collectedAt: '2026-08-08T20:00:00.000Z' },
    { ...b, collectedAt: '2026-08-09T20:00:00.000Z' },
  ]);

  assert.equal(latestCollectedAt(db), '2026-08-09T20:00:00.000Z');
  db.close();
});
