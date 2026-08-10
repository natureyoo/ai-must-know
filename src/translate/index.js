// Korean rendering of collected items (titles/summaries arrive in English
// from every source). Runs once per collection, in scripts/collect.js, and
// writes into the `translations` table — never at request time, so the
// server and the static snapshot stay dependency-free and offline-capable.
//
// Two things keep the bill near zero: work is keyed on a hash of the source
// text, so a daily re-collect only pays for genuinely new items; and a
// missing/failing API key degrades to "no Korean row", which the UI renders
// as the English original rather than an error.

import { createHash } from 'node:crypto';
import { getTranslations, upsertTranslations } from '../db/index.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const BATCH_SIZE = 12;

// Bump when SYSTEM_PROMPT changes in a way that should regenerate existing
// Korean text. The hash covers it, so a bump re-translates everything once
// (and only once) instead of leaving old output frozen in the DB forever.
const PROMPT_VERSION = 3;

export function contentHash(item) {
  return createHash('sha1').update(`v${PROMPT_VERSION}\n${item.title}\n${item.summary}`).digest('hex').slice(0, 16);
}

// Three tiers, deliberately doing three different jobs — an earlier version
// had gistKo and summaryKo both paraphrasing the same sentence, so opening a
// card told the reader nothing new. gistKo states the fact, summaryKo adds
// the specifics, takeKo is the only place any interpretation is allowed.
const SYSTEM_PROMPT = `You brief a Korean-speaking engineering audience on AI-industry news.

For each input item return:
- titleKo: the headline in natural Korean. Keep product names, model names, company names, and version numbers in their original form (GPT-5.2, Claude, Kimi-K3, Hugging Face). Do not add words that are not in the original.
- gistKo: ONE Korean sentence ending in 합니다/했습니다, 45-90 characters, dense with the actual news. It must answer "무엇이 어떻게 달라졌는가" and carry every concrete specific present in the input — the actor, the thing, and any number, model name, version, benchmark, price, or amount. A reader who reads ONLY this line should be able to say what happened.
  BAD: "OpenAI가 새로운 결과를 발표했습니다" (no specifics)
  BAD: "WeatherNext AI 모델이 사이클론 예측에서 돌파구를 달성했습니다" (restates the headline)
  GOOD: "Google DeepMind이 사이클론 진로 예측에서 기존 수치예보보다 앞선 정확도를 냈다고 발표했습니다"
- summaryKo: AT MOST 2 Korean sentences, 합니다체, adding the detail gistKo had no room for — figures, scope, availability, what it is compared against. Never restate gistKo. If the input has nothing further to add, return the single most useful remaining detail.
- takeKo: 2-3 Korean sentences, 합니다체, YOUR reading of why this matters: what it changes for engineers or the industry, what to watch next, or what to be skeptical about. This is the only field where interpretation is allowed, and it must stay grounded — reason from what the input says, never invent benchmarks, dates, figures, or events. Mark anything uncertain as uncertain ("~일 수 있습니다", "아직 확인되지 않았습니다"). If the item is a routine release with no wider significance, say so plainly rather than inflating it. No hype, no "주목됩니다" filler.

Every field except takeKo is reporting: never add facts, figures, or judgements absent from the input.

Respond with JSON: {"items":[{"id":"<the id given>","titleKo":"...","gistKo":"...","summaryKo":"...","takeKo":"..."}]} — one entry per input item, ids copied exactly.`;

const FIELDS = ['titleKo', 'gistKo', 'summaryKo', 'takeKo'];

function validRow(entry, allowedIds) {
  return (
    entry &&
    allowedIds.has(entry.id) &&
    FIELDS.every((k) => typeof entry[k] === 'string' && entry[k].trim() !== '')
  );
}

async function translateBatch(batch, { apiKey, model, fetchImpl }) {
  const payload = batch.map((i) => ({ id: i.id, title: i.title, summary: i.summary }));
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ items: payload }) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${(await res.text()).slice(0, 200)}`);

  const body = await res.json();
  const parsed = JSON.parse(body.choices[0].message.content);
  const allowedIds = new Set(batch.map((i) => i.id));
  const byId = new Map(batch.map((i) => [i.id, i]));
  const translatedAt = new Date().toISOString();

  return (parsed.items ?? [])
    .filter((entry) => validRow(entry, allowedIds))
    .map((entry) => ({
      id: entry.id,
      hash: contentHash(byId.get(entry.id)),
      titleKo: entry.titleKo.trim(),
      summaryKo: entry.summaryKo.trim(),
      gistKo: entry.gistKo.trim(),
      takeKo: entry.takeKo.trim(),
      translatedAt,
    }));
}

// Translates whatever in `items` has no up-to-date Korean row yet and
// persists it. Returns the number of items translated this run. Never
// throws: a dead key, a rate limit, or a malformed response costs Korean
// text for those items, not the collection run.
export async function translateItems(
  db,
  items,
  {
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.OPENAI_MODEL || DEFAULT_MODEL,
    fetchImpl = fetch,
    log = console.log,
    batchSize = BATCH_SIZE,
  } = {},
) {
  const existing = getTranslations(db);
  const pending = items.filter((item) => existing.get(item.id)?.hash !== contentHash(item));

  if (pending.length === 0) {
    log(`Translation: ${items.length} item(s) already have current Korean text — nothing to translate.`);
    return 0;
  }
  if (!apiKey) {
    log(`Translation: OPENAI_API_KEY not set — ${pending.length} item(s) stay English-only (the UI falls back to the original).`);
    return 0;
  }

  let translated = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    try {
      const rows = await translateBatch(batch, { apiKey, model, fetchImpl });
      // Persist per batch, so a failure halfway through keeps what already
      // succeeded instead of re-billing it on the next run.
      upsertTranslations(db, rows);
      translated += rows.length;
    } catch (err) {
      log(`Translation: batch of ${batch.length} failed (${err.message}) — those items stay English.`);
    }
  }

  log(`Translation: ${translated}/${pending.length} new or changed item(s) rendered in Korean via ${model}.`);
  return translated;
}
