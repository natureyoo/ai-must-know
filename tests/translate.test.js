import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertSourceItems, getTranslations, latestCollectedAt } from '../src/db/index.js';
import { translateItems, contentHash } from '../src/translate/index.js';
import { getStoryViews } from '../src/server/index.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

// Every test drives article fetching explicitly — none of them may touch the
// network.
const noArticles = async () => new Map();

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
      takeKo: '이 소식이 중요한 이유입니다.',
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

  const count = await translateItems(db, items(), { apiKey: '', fetchImpl, log: () => {}, getArticleTexts: noArticles });

  assert.equal(count, 0);
  assert.equal(calls.length, 0, 'must not call the API without a key');
  assert.equal(getTranslations(db).size, 0);
  db.close();
});

test('translates new items and persists Korean title, gist, and summary', async () => {
  const db = openDb(':memory:');
  const { fetchImpl, calls } = fakeOpenAI();
  const input = items(2);

  const count = await translateItems(db, input, { apiKey: 'sk-test', fetchImpl, log: () => {}, getArticleTexts: noArticles });

  assert.equal(count, 2);
  assert.equal(calls.length, 1, 'two items fit in one batch');
  const stored = getTranslations(db);
  for (const item of input) {
    const row = stored.get(item.id);
    assert.ok(row, `expected a translation row for ${item.id}`);
    assert.equal(row.titleKo, `[번역] ${item.title}`);
    assert.equal(row.gistKo, '한 줄 핵심');
    assert.equal(row.takeKo, '이 소식이 중요한 이유입니다.');
    assert.equal(row.hash, contentHash(item));
  }
  db.close();
});

test('re-running collection does not re-translate unchanged items (this is what keeps the daily run cheap)', async () => {
  const db = openDb(':memory:');
  const input = items(3);

  const first = fakeOpenAI();
  await translateItems(db, input, { apiKey: 'sk-test', fetchImpl: first.fetchImpl, log: () => {}, getArticleTexts: noArticles });

  const second = fakeOpenAI();
  const count = await translateItems(db, input, { apiKey: 'sk-test', fetchImpl: second.fetchImpl, log: () => {}, getArticleTexts: noArticles });

  assert.equal(count, 0);
  assert.equal(second.calls.length, 0, 'unchanged items must not hit the API a second time');
  db.close();
});

test('an edited title re-translates only that item', async () => {
  const db = openDb(':memory:');
  const input = items(3);

  const first = fakeOpenAI();
  await translateItems(db, input, { apiKey: 'sk-test', fetchImpl: first.fetchImpl, log: () => {}, getArticleTexts: noArticles });

  const edited = [{ ...input[0], title: `${input[0].title} (updated)` }, input[1], input[2]];
  const second = fakeOpenAI();
  const count = await translateItems(db, edited, { apiKey: 'sk-test', fetchImpl: second.fetchImpl, log: () => {}, getArticleTexts: noArticles });

  assert.equal(count, 1);
  assert.equal(second.calls.length, 1);
  assert.deepEqual(second.calls[0].body.messages[1].content.includes(edited[0].title), true);
  assert.equal(getTranslations(db).get(edited[0].id).titleKo, `[번역] ${edited[0].title}`);
  db.close();
});

test('an API failure never breaks collection — items just stay English', async () => {
  const db = openDb(':memory:');
  const { fetchImpl } = fakeOpenAI({ fail: true });

  const count = await translateItems(db, items(2), { apiKey: 'sk-test', fetchImpl, log: () => {}, getArticleTexts: noArticles });

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

  const count = await translateItems(db, items(2), { apiKey: 'sk-test', fetchImpl, log: () => {}, getArticleTexts: noArticles });

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
  await translateItems(db, input, { apiKey: 'sk-test', fetchImpl, log: () => {}, getArticleTexts: noArticles });

  const translated = getStoryViews(db, { includeFixtures: true });
  assert.ok(translated.some((v) => v.titleKo?.startsWith('[번역]')), 'expected at least one Korean title in the view');
  assert.ok(translated.some((v) => v.gistKo === '한 줄 핵심'));
  assert.ok(translated.some((v) => v.takeKo === '이 소식이 중요한 이유입니다.'), 'the AI take reaches the view');
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

test('a DB written before takeKo existed is migrated in place, not crashed on', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const path = join(mkdtempSync(join(tmpdir(), 'amk-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE translations (
    id TEXT PRIMARY KEY, hash TEXT NOT NULL, titleKo TEXT NOT NULL,
    summaryKo TEXT NOT NULL, gistKo TEXT NOT NULL, translatedAt TEXT NOT NULL)`);
  old.exec(`INSERT INTO translations VALUES ('x','h','제목','요약','핵심','2026-08-09T00:00:00.000Z')`);
  old.close();

  const db = openDb(path);
  const columns = db.prepare('PRAGMA table_info(translations)').all().map((c) => c.name);
  assert.ok(columns.includes('takeKo'), 'the new column is added to the existing table');
  assert.equal(getTranslations(db).get('x').takeKo, '', 'existing rows survive with an empty take');

  const { fetchImpl } = fakeOpenAI();
  await translateItems(db, items(1), { apiKey: 'sk-test', fetchImpl, log: () => {}, getArticleTexts: noArticles });
  assert.ok([...getTranslations(db).values()].some((r) => r.takeKo));
  db.close();
});

test('the article body is what the model is given, not just the feed summary', async () => {
  const db = openDb(':memory:');
  const { fetchImpl, calls } = fakeOpenAI();
  const [item] = items(1);

  await translateItems(db, [item], {
    apiKey: 'sk-test',
    fetchImpl,
    log: () => {},
    getArticleTexts: async () => new Map([[item.id, 'The paper reports 4.2 trillion training tokens.']]),
  });

  const sent = JSON.parse(calls[0].body.messages[1].content).items[0];
  assert.equal(sent.articleText, 'The paper reports 4.2 trillion training tokens.');
  assert.equal(sent.summary, item.summary, 'the summary is still sent alongside it');
});

test('an item whose article could not be fetched is still translated, with an empty body', async () => {
  const db = openDb(':memory:');
  const { fetchImpl, calls } = fakeOpenAI();
  const [item] = items(1);

  const count = await translateItems(db, [item], { apiKey: 'sk-test', fetchImpl, log: () => {}, getArticleTexts: noArticles });

  assert.equal(count, 1);
  assert.equal(JSON.parse(calls[0].body.messages[1].content).items[0].articleText, '');
});

test('a rejected model id falls back instead of losing the whole run to a typo', async () => {
  const db = openDb(':memory:');
  const seen = [];
  const good = fakeOpenAI();
  const fetchImpl = async (url, init) => {
    const model = JSON.parse(init.body).model;
    seen.push(model);
    if (model === 'gpt-does-not-exist') {
      return { ok: false, status: 404, text: async () => '{"error":{"message":"The model does not exist"}}' };
    }
    return good.fetchImpl(url, init);
  };

  const count = await translateItems(db, items(2), {
    apiKey: 'sk-test',
    model: 'gpt-does-not-exist',
    fetchImpl,
    log: () => {},
    getArticleTexts: noArticles,
  });

  assert.equal(count, 2, 'the batch is retried on the fallback model');
  assert.deepEqual(seen, ['gpt-does-not-exist', 'gpt-4o-mini']);
  db.close();
});
