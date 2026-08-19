// Korean rendering of collected items (titles/summaries arrive in English
// from every source). Runs once per collection, in scripts/collect.js, and
// writes into the `translations` table — never at request time, so the
// server and the static snapshot stay dependency-free and offline-capable.
//
// Two providers, chosen by TRANSLATOR (or the `provider` option):
//   claude — the Claude Code CLI (`claude -p`), headless. Billed to the
//            Claude subscription the CLI is logged into (locally) or to the
//            CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` (in CI), so
//            the daily run costs no API credits. This is the default in
//            .github/workflows/daily.yml.
//   openai — the Chat Completions API with OPENAI_API_KEY (the original path).
// Both get the same prompt and produce the same rows; the choice is a billing
// choice, not a quality knob — although the take reads noticeably better on
// Opus.
//
// Two things keep the bill near zero: work is keyed on a hash of the source
// text, so a daily re-collect only pays for genuinely new items; and a
// missing/failing provider degrades to "no Korean row", which the UI renders
// as the English original rather than an error.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
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
// Claude Code CLI model alias. Opus, because the take is a reasoning task
// and the subscription makes the price difference irrelevant.
const DEFAULT_CLAUDE_MODEL = 'opus';
// Smaller than before: each item now carries up to 4k characters of article
// text, so a batch of twelve would be a large request for no benefit.
const BATCH_SIZE = 6;
// Newest items first, at most this many per run. A PROMPT_VERSION bump makes
// every stored item pending at once (~650 rows); doing them 120 a day, newest
// first, means the landing page is redone on day one and nothing trips a
// subscription rate limit. Normal days have far fewer than this pending.
const DEFAULT_LIMIT = 200;

// Bump when SYSTEM_PROMPT changes in a way that should regenerate existing
// Korean text. The hash covers it, so a bump re-translates everything once
// (and only once) instead of leaving old output frozen in the DB forever.
const PROMPT_VERSION = 7;

// Digits are stripped from the summary before hashing: HN, GitHub and Hugging
// Face summaries embed live counts ("… with 979 points and 489 comments"), so
// hashing them verbatim re-translated ~100 unchanged items every single day.
// The title is hashed as-is — an edited headline is a real change.
export function contentHash(item) {
  return createHash('sha1')
    .update(`v${PROMPT_VERSION}\n${item.title}\n${item.summary.replace(/\d+/g, '#')}`)
    .digest('hex')
    .slice(0, 16);
}

// Three tiers, deliberately doing three different jobs — an earlier version
// had gistKo and summaryKo both paraphrasing the same sentence, so opening a
// card told the reader nothing new. gistKo states the fact, summaryKo adds
// the specifics, takeKo is the only place any interpretation is allowed.
const SYSTEM_PROMPT = `You write a Korean daily briefing on AI-industry news for working ML/AI engineers. They scan a grid of cards in three minutes: the headline and one gist line per card must carry the news by themselves. Write like a Korean tech desk (지디넷코리아, GeekNews), not like a translator.

For each input item return:

- titleKo: a Korean NEWS HEADLINE REWRITTEN from the facts — not a translation of the original title. 20-40 characters. Subject set off with a comma, noun ending ("공개", "출시", "인수", "제소", "50% 인하") or a short quote. If the original title is only a product name ("Grok 4.6", "Mistral OCR 4.1"), add the actor and the one fact that makes it news. Keep product/model/company names in their original Latin form (GPT-5.6, Claude, Qwen, Hugging Face); keep version numbers.
  Never: a literal rendering of English syntax; endings in 하기/합니다/했다/에 관하여/~을 위한; HN/HF tails like "[pdf]", "[video]", " — <org>"; an English sentence left untranslated.
  BAD: "수어 AI를 사용자 손에: Google DeepMind의 SL2T" (literal) → GOOD: "DeepMind, 수어→텍스트 모델 SL2T를 Pixel에 탑재"
  BAD: "Sheets canvas로 스프레드시트 데이터를 살아 움직이게 하기" → GOOD: "Google Sheets, 프롬프트로 시트를 대시보드로 바꾸는 canvas 공개"
  BAD: "AI 규제와 메시징에 관하여" → GOOD: "Dario Amodei \"규제=규제포획 도식은 틀렸다\"… SB 53 지지"
  BAD: "GLM-5.3: 창발적 사이버 능력을 갖춘 프런티어 코딩" (restates the title, no news) → GOOD: "Z.ai, 코딩·공격형 보안 능력 앞세운 GLM-5.3 공개"
  BAD: "Anthropic Risk August 2026 [pdf]" → GOOD: "Anthropic, 8월 리스크 리포트 PDF 공개"

- gistKo: ONE sentence, 50-80 characters, newspaper 했다체 (공개했다/밝혔다/보도했다 — never 합니다체). Actor + what changed + the single most important specific (a number, model name, price, benchmark). A reader who reads ONLY this line knows what happened.
  Never report Hacker News points/comments or Hugging Face downloads/likes — those are not news. Never say a page/document/model "was published/posted" as the news; state what it says or does. Never restate the headline. If articleText is empty, state only what the title itself asserts, and no more.
  BAD: "Claude의 시스템 프롬프트를 공개한 페이지가 Hacker News에서 417포인트와 댓글 182개를 기록했다"
  BAD: "OpenAI가 새로운 결과를 발표했다" (no specifics)
  GOOD: "OpenRouter가 GPT-5.6 Sol 단가를 50% 내렸다. 적용 범위와 기간은 미확인이다"
  GOOD: "Google DeepMind가 사이클론 진로 예측에서 기존 수치예보보다 앞선 정확도를 냈다고 밝혔다"

- summaryKo: at most 2 sentences, 120 characters or fewer, 했다체. Only what the gist had no room for — figures, scope, availability, conditions, what it is compared against. Never restate gistKo. If nothing remains, give the single most useful remaining detail.

- takeKo: 2-3 sentences, 250 characters or fewer, 했다체, declarative. YOUR reading of why this matters, written from "articleText" (the original page). This is the only field where interpretation is allowed, and it must do real work: first sentence says what concretely changes for someone building with or on this (a cost, a capability, a constraint, a default that flipped); then what the article claims versus what it actually shows; then what to doubt or watch. Every claim must be anchored in something specific the article says — a figure, a design decision, a caveat the authors admit, what it is compared against, what is conspicuously missing (no code benchmark, no independent replication, no pricing, only a company blog as source). Never invent benchmarks, dates, figures, or events. Mark uncertainty as such. If it is a routine release or a thin article, say so in one sentence and stop — do not inflate.
  If articleText is EMPTY, write exactly ONE sentence: what the title asserts and that the original was not retrievable, e.g. "원문을 확보하지 못해 제목 외 판단 근거가 없다." — and stop. Do not pad with things you do not know.
  FORBIDDEN, because they carry no information: any sentence of the form "엔지니어들은 …을 주목/고려/평가해야 한다", "…에 기여할 수 있다", "…중요한 단계/기회/역할", "…추가 검증이 필요하다" without saying WHAT is unverified, "향후 발전이 주목된다", "…관건이다", "…신호다", "…중요성을 보여준다/강조한다", "…시사한다", "잠재력". Do not restate the gist or the summary. Do not open with the product name plus "은/는".
  BAD: "성능 향상 및 새로운 기능을 포함할 수 있다. 엔지니어들은 영향을 평가해야 한다." (says nothing the headline did not)
  BAD: "이 발표는 OpenAI가 사이버 보안에 대한 책임을 강화하고 있다는 신호다. 이러한 조치는 향후 AI 시스템의 안전성을 높이는 데 기여할 수 있다." (generic praise, zero anchors)
  GOOD: "장문 컨텍스트 벤치마크만 공개하고 코드 생성 결과는 빠져 있어, 실제 코딩 작업 성능은 아직 판단하기 이르다. 가중치가 공개돼 자체 검증은 가능하다."
  GOOD: "Ultrafast는 별도 서비스 티어라 기본 API 호출은 그대로이고, 750 tok/s는 Cerebras 하드웨어 위에서만 나오는 수치다. 지연 시간이 병목인 에이전트 루프에서 의미가 크지만, 요금이 공개되지 않아 비용 대비 효과는 아직 계산할 수 없다."

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

Terms and style, all fields: company/model/product names in their original Latin form (OpenAI, Claude, Qwen, Hugging Face — never 구글/아마존/앤스로픽); person names in Latin script; 프런티어 (not 프론티어), 오픈소스, 오픈웨이트, 프리뷰, 됐다 (not 되었다); "·" for lists (모델·툴·샌드박스); thousands separators in numbers (2,150개, 1억 1,300만 달러, 70억 달러).

Each item includes "articleText": the original page reduced to plain text. It may be empty (paywall, JS-only page, fetch failure). When present it is the best evidence you have; prefer it over the summary, but never contradict the title/summary.

Every field except takeKo is reporting: never add facts, figures, or judgements absent from the input.

Respond with JSON: {"items":[{"id":"<the id given>","titleKo":"...","gistKo":"...","summaryKo":"...","takeKo":"...","category":"..."}]} — one entry per input item, ids copied exactly.`;

const FIELDS = ['titleKo', 'gistKo', 'summaryKo', 'takeKo'];

// The prompt bans these; this makes the ban enforced rather than advisory.
// A rejected row is simply not stored, so the item stays pending and is
// retried on the next run — no extra cost, no filler on the page.
const TAKE_FILLER = /주목해야 (합니다|한다)|고려해야 (합니다|한다)|평가해야 (합니다|한다)|기여할 수 (있습니다|있다)|중요한 (단계|기회|역할)|향후 발전이 주목|중요성을 보여|관건(입니다|이다)|시사(합니다|한다)|잠재력|엔지니어들은/;
// A headline that is still the English title with an HN/HF tail, or English
// syntax rendered word for word ("…하기", "…에 관하여"), or 합니다체.
const TITLE_BAD = /\[pdf\]|\[video\]| — |(하기|에 관하여|합니다|니다)$/;
// A gist that reports the platform's counters instead of the news.
const GIST_BAD = /Hacker News|Show HN|HN에서|[\d,]+ ?포인트|댓글 ?[\d,]+|[\d,]+ ?개의 댓글|다운로드 [\d,]+|[\d,]+ ?회의 다운로드|좋아요 [\d,]+|[\d,]+ ?개의 좋아요/;

function validRow(entry, allowedIds, thinIds = new Set()) {
  return (
    entry &&
    allowedIds.has(entry.id) &&
    FIELDS.every((k) => typeof entry[k] === 'string' && entry[k].trim() !== '') &&
    // With no article text the take is one honest sentence; with it, one
    // short sentence means the model did not do the work.
    entry.takeKo.trim().length >= (thinIds.has(entry.id) ? 15 : 60) &&
    !TAKE_FILLER.test(entry.takeKo) &&
    !TITLE_BAD.test(entry.titleKo.trim()) &&
    !GIST_BAD.test(entry.gistKo)
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

async function askOpenAI(userJson, { apiKey, model, fetchImpl }) {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userJson },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return JSON.parse(body.choices[0].message.content);
}

// The response shape, enforced by the CLI (--json-schema) so a chatty answer
// cannot slip through as text.
const ROW_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: Object.fromEntries(['id', 'titleKo', 'gistKo', 'summaryKo', 'takeKo', 'category'].map((k) => [k, { type: 'string' }])),
        required: ['id', 'titleKo', 'gistKo', 'summaryKo', 'takeKo', 'category'],
      },
    },
  },
  required: ['items'],
};

// One headless `claude -p` call per batch: no tools, our own system prompt,
// the batch on stdin. Runs from the OS temp dir so it never picks up a
// CLAUDE.md or .claude/settings from whatever checkout it happens to be in.
// Auth is whatever the CLI already has — the local login, or
// CLAUDE_CODE_OAUTH_TOKEN in CI.
export function askClaudeCli(userJson, { model, exec = execFile }) {
  const args = [
    '-p', '--model', model, '--tools', '', '--permission-mode', 'dontAsk',
    '--output-format', 'json', '--json-schema', JSON.stringify(ROW_SCHEMA),
    '--system-prompt', SYSTEM_PROMPT,
  ];
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  return new Promise((resolve, reject) => {
    const child = exec('claude', args, { cwd: tmpdir(), env, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude CLI: ${err.code === 'ENOENT' ? 'not installed (ENOENT)' : (stderr || err.message).slice(0, 300)}`));
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        return reject(new Error(`claude CLI: unparseable output ${String(stdout).slice(0, 200)}`));
      }
      if (out.is_error || !out.structured_output) {
        return reject(new Error(`claude CLI: ${String(out.result ?? out.subtype ?? 'no structured output').slice(0, 300)}`));
      }
      resolve(out.structured_output);
    });
    child.stdin?.end(userJson);
  });
}

async function translateBatch(batch, { ask, articleText }) {
  const payload = batch.map((i) => ({
    id: i.id,
    title: i.title,
    summary: i.summary,
    articleText: articleText.get(i.id) ?? '',
  }));
  const parsed = await ask(JSON.stringify({ items: payload }));
  const allowedIds = new Set(batch.map((i) => i.id));
  const thinIds = new Set(payload.filter((p) => !p.articleText).map((p) => p.id));
  const byId = new Map(batch.map((i) => [i.id, i]));
  const translatedAt = new Date().toISOString();

  return (parsed.items ?? [])
    .filter((entry) => validRow(entry, allowedIds, thinIds))
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
// throws: a dead key, a rate limit, a missing CLI, or a malformed response
// costs Korean text for those items, not the collection run.
export async function translateItems(
  db,
  items,
  {
    provider = process.env.TRANSLATOR || 'openai',
    apiKey = process.env.OPENAI_API_KEY,
    model = provider === 'claude' ? process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL : process.env.OPENAI_MODEL || DEFAULT_MODEL,
    fetchImpl = fetch,
    askClaude = askClaudeCli,
    log = console.log,
    batchSize = BATCH_SIZE,
    limit = Number(process.env.TRANSLATE_LIMIT ?? DEFAULT_LIMIT),
    getArticleTexts = fetchArticleTexts,
  } = {},
) {
  const existing = getTranslations(db);
  const stale = items.filter((item) => existing.get(item.id)?.hash !== contentHash(item));
  const pending = stale
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);

  if (pending.length === 0) {
    log(`Translation: ${items.length} item(s) already have current Korean text — nothing to translate.`);
    return 0;
  }
  if (provider === 'openai' && !apiKey) {
    log(`Translation: OPENAI_API_KEY not set — ${pending.length} item(s) stay English-only (the UI falls back to the original).`);
    return 0;
  }
  if (stale.length > pending.length) {
    log(`Translation: ${stale.length} item(s) pending, doing the newest ${pending.length} this run (TRANSLATE_LIMIT).`);
  }

  // Only the pending items are fetched, so the daily run pulls the handful
  // of genuinely new articles rather than re-reading the whole archive.
  const articleText = await getArticleTexts(pending);
  log(`Translation: fetched the original article text for ${articleText.size}/${pending.length} item(s); the rest fall back to their summary.`);

  let activeModel = model;
  let translated = 0;
  const ask = (userJson) =>
    provider === 'claude'
      ? askClaude(userJson, { model: activeModel })
      : askOpenAI(userJson, { apiKey, model: activeModel, fetchImpl });

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    try {
      const rows = await translateBatch(batch, { ask, articleText });
      // Persist per batch, so a failure halfway through keeps what already
      // succeeded instead of re-billing it on the next run.
      upsertTranslations(db, rows);
      translated += rows.length;
    } catch (err) {
      // A missing CLI fails every batch identically — say it once and stop.
      if (/ENOENT/.test(err.message)) {
        log(`Translation: ${err.message} — ${pending.length - i} item(s) stay English.`);
        break;
      }
      // A rejected model id fails every batch identically, so retry this one
      // on the fallback and switch for the rest of the run rather than
      // losing the entire day's Korean text to a typo in OPENAI_MODEL.
      if (provider === 'openai' && activeModel !== FALLBACK_MODEL && isModelError(err.message)) {
        log(`Translation: model "${activeModel}" rejected (${err.message}) — falling back to ${FALLBACK_MODEL}.`);
        activeModel = FALLBACK_MODEL;
        try {
          const rows = await translateBatch(batch, { ask, articleText });
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

  log(`Translation: ${translated}/${pending.length} new or changed item(s) rendered in Korean via ${provider}:${activeModel}.`);
  return translated;
}
