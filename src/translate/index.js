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

export function contentHash(item) {
  return createHash('sha1').update(`${item.title}\n${item.summary}`).digest('hex').slice(0, 16);
}

// gistKo is the card's lead line: the one sentence that tells a reader what
// happened without opening anything. Explicitly bounded, because an LLM left
// unbounded writes a paragraph and the card stops being scannable.
const SYSTEM_PROMPT = `You translate AI-industry news for a Korean-speaking engineering audience.

For each input item return:
- titleKo: the headline in natural Korean. Keep product names, model names, company names, and version numbers in their original form (GPT-5.2, Claude, Hugging Face). Do not add words that are not in the original.
- gistKo: ONE Korean sentence, 40 characters or fewer, saying what actually happened — the single fact a reader needs. No marketing tone, no "~에 대한 소식", no trailing ellipsis.
- summaryKo: the summary translated into Korean, same number of sentences as the original, plain 합니다체.

Translate only. Never add facts, figures, or judgements that are absent from the input.

Respond with JSON: {"items":[{"id":"<the id given>","titleKo":"...","gistKo":"...","summaryKo":"..."}]} — one entry per input item, ids copied exactly.`;

function validRow(entry, allowedIds) {
  return (
    entry &&
    allowedIds.has(entry.id) &&
    ['titleKo', 'gistKo', 'summaryKo'].every((k) => typeof entry[k] === 'string' && entry[k].trim() !== '')
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
