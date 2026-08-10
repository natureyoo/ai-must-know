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
import { fetchArticleTexts } from '../enrich/article.js';
import { CATEGORIES } from '../adapters/sourceItem.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
// The take is the one field that has to reason rather than translate, and
// gpt-4o-mini produced generic filler ("성능 향상을 포함할 수 있습니다") even with
// the article body in hand. Overridable via OPENAI_MODEL.
const DEFAULT_MODEL = 'gpt-4o';
// Used only if the configured model is rejected — a typo'd or unavailable
// model id would otherwise silently turn the whole site English.
const FALLBACK_MODEL = 'gpt-4o-mini';
// Smaller than before: each item now carries up to 4k characters of article
// text, so a batch of twelve would be a large request for no benefit.
const BATCH_SIZE = 6;

// Bump when SYSTEM_PROMPT changes in a way that should regenerate existing
// Korean text. The hash covers it, so a bump re-translates everything once
// (and only once) instead of leaving old output frozen in the DB forever.
const PROMPT_VERSION = 5;

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
- takeKo: 2-3 Korean sentences, 합니다체, YOUR reading of why this matters, written from "articleText" — the body of the original piece. Say what it changes for engineers or the industry, what to watch next, or what to be skeptical about, and anchor it in something specific the article actually says (a figure, a design decision, a caveat the authors admit, what it is compared against). This is the only field where interpretation is allowed, and it must stay grounded: never invent benchmarks, dates, figures, or events. Mark anything uncertain as uncertain ("~일 수 있습니다", "아직 확인되지 않았습니다"). If it is a routine release with no wider significance, say so plainly rather than inflating it.
  BAD: "성능 향상 및 새로운 기능을 포함할 수 있습니다. 엔지니어들은 영향을 평가해야 합니다." (says nothing the headline did not)
  BAD: "향후 발전이 주목됩니다." (filler)
  GOOD: "장문 컨텍스트 벤치마크만 공개하고 코드 생성 결과는 빠져 있어, 실제 코딩 작업 성능은 아직 판단하기 이릅니다. 가중치가 공개돼 자체 검증은 가능합니다."

- category: EXACTLY ONE of research | models | products | open-source | infrastructure | business | policy | funding | safety. Work down this list and take the FIRST that fits, so an item that touches several lands in one place consistently:
  1. safety — model risk, misuse, alignment, jailbreaks, red-teaming, a security incident or breach, safety evaluations
  2. policy — regulation, legislation, standards, court rulings, lawsuits, government action
  3. funding — a funding round, acquisition, or valuation
  4. business — pricing, strategy, partnerships, hiring, earnings, market moves that are none of the above
  5. infrastructure — chips, accelerators, datacenters, serving/inference stacks, hardware
  6. models — a model being released, updated, or open-weighted (the model itself is the news)
  7. research — a paper, experiment, benchmark result, or new method
  8. open-source — an open-source tool, framework, or library (open model WEIGHTS are "models", not this)
  9. products — an end-user product, feature, or app
  A reinforcement-learning "policy" is research, not policy. A repository being on GitHub does not make it open-source news.

Each item includes "articleText": the original page reduced to plain text. It may be empty (paywall, JS-only page, fetch failure) — in that case write takeKo from the title and summary alone and keep it correspondingly modest. When it is present it is the best evidence you have; prefer it over the summary, but never contradict the title/summary.

Every field except takeKo is reporting: never add facts, figures, or judgements absent from the input.

Respond with JSON: {"items":[{"id":"<the id given>","titleKo":"...","gistKo":"...","summaryKo":"...","takeKo":"...","category":"..."}]} — one entry per input item, ids copied exactly.`;

const FIELDS = ['titleKo', 'gistKo', 'summaryKo', 'takeKo'];

function validRow(entry, allowedIds) {
  return (
    entry &&
    allowedIds.has(entry.id) &&
    FIELDS.every((k) => typeof entry[k] === 'string' && entry[k].trim() !== '')
  );
}

// An unrecognised category is dropped rather than stored: the keyword
// fallback in the adapters is a worse classifier but a known one, and a
// junk value would break filtering and the impact weight.
function validCategory(value) {
  return typeof value === 'string' && CATEGORIES.includes(value) ? value : '';
}

function isModelError(message) {
  return /model|404|invalid_request/i.test(message);
}

async function translateBatch(batch, { apiKey, model, fetchImpl, articleText }) {
  const payload = batch.map((i) => ({
    id: i.id,
    title: i.title,
    summary: i.summary,
    articleText: articleText.get(i.id) ?? '',
  }));
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
      category: validCategory(entry.category),
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
    getArticleTexts = fetchArticleTexts,
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

  // Only the pending items are fetched, so the daily run pulls the handful
  // of genuinely new articles rather than re-reading the whole archive.
  const articleText = await getArticleTexts(pending);
  log(`Translation: fetched the original article text for ${articleText.size}/${pending.length} item(s); the rest fall back to their summary.`);

  let activeModel = model;
  let translated = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    try {
      const rows = await translateBatch(batch, { apiKey, model: activeModel, fetchImpl, articleText });
      // Persist per batch, so a failure halfway through keeps what already
      // succeeded instead of re-billing it on the next run.
      upsertTranslations(db, rows);
      translated += rows.length;
    } catch (err) {
      // A rejected model id fails every batch identically, so retry this one
      // on the fallback and switch for the rest of the run rather than
      // losing the entire day's Korean text to a typo in OPENAI_MODEL.
      if (activeModel !== FALLBACK_MODEL && isModelError(err.message)) {
        log(`Translation: model "${activeModel}" rejected (${err.message}) — falling back to ${FALLBACK_MODEL}.`);
        activeModel = FALLBACK_MODEL;
        try {
          const rows = await translateBatch(batch, { apiKey, model: activeModel, fetchImpl, articleText });
          upsertTranslations(db, rows);
          translated += rows.length;
          continue;
        } catch (retryErr) {
          err.message = retryErr.message;
        }
      }
      log(`Translation: batch of ${batch.length} failed (${err.message}) — those items stay English.`);
    }
  }

  log(`Translation: ${translated}/${pending.length} new or changed item(s) rendered in Korean via ${activeModel}.`);
  return translated;
}
