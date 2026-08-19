# AI Must Know

Local AI news curation dashboard. Collects AI news from official RSS/feeds,
Hacker News, GitHub, and the Hugging Face Hub, merges duplicate coverage into
stories, and scores
each story on virality, publisher influence, credibility, and industry
impact — with a visible verification status for every claim.

## Install

Requires Node.js >= 22 (uses `node:sqlite` and `node:test`, no other
runtime dependency). This project has zero npm dependencies.

```
npm install
```

## Run

Collection and serving are separate commands, so you can run a collection
on a schedule (e.g. cron) without keeping a web server alive, and vice versa.

```
npm run collect   # fetch/refresh data into the local SQLite DB, then exit
npm run serve     # start the web server, reading from that DB
```

`npm run collect` runs the RSS, Hacker News, GitHub, and Hugging Face
adapters live. Each
source is independent: if a source's live fetch fails or returns nothing
(no network, feed down, API error), that source alone falls back to its
bundled fixture items — the other sources still use live data. This means
the app is fully usable offline (all three sources fall back to fixtures)
and works with no setup at all: first run, empty DB, no `.env` file.

`npm run collect` also renders new items into Korean (see **Language**
below) through the Claude Code CLI (`TRANSLATOR=claude`) or the OpenAI API
(`OPENAI_API_KEY`).

`npm run serve` starts an HTTP server (default `http://localhost:3000`)
serving both the dashboard (`public/`) and the JSON API it calls
(`/api/stories`, `/api/stories/:id`). It only reads from the DB; it never
collects.

## Daily updates

`.github/workflows/daily.yml` runs the whole chain on GitHub Actions every
day at **20:00 UTC = 05:00 KST**: `npm run collect` → `node
scripts/build-static.js dist` → deploy to GitHub Pages. It can also be
triggered by hand from the Actions tab (`workflow_dispatch`), and runs on
every push to `main`.

Setup on a fresh repo:

1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → new secret
   `CLAUDE_CODE_OAUTH_TOKEN`: on a machine where Claude Code is logged in,
   run `claude setup-token` and paste the token it prints. That is a one-year
   token tied to your Claude subscription, so the daily Korean text costs no
   API credits. (`OPENAI_API_KEY` still works as the fallback provider when
   that secret is absent; with neither, the site is English-only.)

The SQLite DB is carried between runs with `actions/cache`, so previous
days' stories stay in the pool and already-translated items are never paid
for twice. A cache miss is not a failure: the run just collects from
scratch. Note that GitHub queues scheduled workflows and can start them
late under load, so 05:00 KST is "soon after", not exact — which is
precisely why the page stamps its real as-of time rather than the intended
one.

**Every page shows what it is a snapshot of.** The header renders `데이터
기준 <newest collectedAt> KST · N시간 전`, taken from `MAX(collectedAt)` in
the DB (`latestCollectedAt`), not from build or request time — rebuilding
without collecting cannot make stale data look fresh. If that stamp is more
than 30 hours old (i.e. a daily run was missed), it turns orange and reads
`갱신 지연`.

## Language

The dashboard defaults to **Korean**; the header toggle switches to English
and the choice is remembered in `localStorage`.

Sources publish in English, so `src/translate/index.js` renders each
collected item into Korean during collection, storing four fields per item
in the `translations` table. The model behind it is chosen by `TRANSLATOR`:

- `claude` — one headless `claude -p` call per batch (`--tools ""`, our own
  system prompt, JSON schema enforced), run from the OS temp dir so it never
  picks up a stray CLAUDE.md. Billed to whatever the CLI is logged into:
  your subscription locally, `CLAUDE_CODE_OAUTH_TOKEN` in CI. Model
  `CLAUDE_MODEL`, default `opus` — the take is a reasoning task and the
  subscription makes the price difference moot. This is what
  `daily.yml` uses.
- `openai` — the Chat Completions API with `OPENAI_API_KEY` (the original
  path, default when `TRANSLATOR` is unset). `OPENAI_MODEL` defaults to
  `gpt-4o`, falling back to `gpt-4o-mini` if the id is rejected.

Both providers get the same prompt and write the same rows:

- `titleKo` — a Korean **news headline rewritten from the facts**, not a
  rendering of the English title: 20-40 characters, subject set off with a
  comma, noun ending ("공개", "출시", "50% 인하"), product/model names left in
  Latin script. A product-name-only original ("Grok 4.6") gets the actor and
  the one fact that makes it news. Literal renderings ("~을 사용자 손에",
  "~하기", "~에 관하여"), 합니다체 endings and HN/HF tails ("[pdf]", " — org")
  are rejected by a regex and the item is retried next run,
- `gistKo` — **one sentence, 50-80 characters, 했다체**, carrying the actual
  news: the actor, the thing, and the single most important figure, model
  name or price. This is the line the card is built around, so the grid can
  be read without opening anything; the prompt rejects vague ("새로운 결과를
  발표했다") and headline-restating output, and a validator rejects a gist
  that reports Hacker News points or Hugging Face download counts — those
  are the platform's counters, not the news,
- `summaryKo` — the original's content compressed to **at most 2 sentences,
  120 characters**, adding what the gist had no room for (detail view only),
- `takeKo` — 2-3 sentences (≤250 characters, 했다체) of **AI commentary**:
  why this matters, what to watch, what to be skeptical of. When the
  article text could not be fetched it is exactly one sentence saying so,
  rather than three sentences of hedging. This is the only generated field allowed to
  interpret rather than report; the prompt forbids inventing figures or
  events, requires the take to be anchored in something the article actually
  says, and requires uncertainty to be marked as such. It is what the card's
  `AI 관점 · 왜 중요한가` toggle opens onto, and it always carries a visible
  notice that it was written by AI.

The take is written from the **original article**, not from the feed teaser.
`src/enrich/article.js` fetches each pending item's URL and reduces the page
to plain text (chrome, scripts and nav stripped, `<article>`/`<main>`
preferred, capped at 4k characters), with bounded concurrency and a short
timeout. Only items that still need translating are fetched, so the daily run
pulls the handful of genuinely new articles. A paywall, a JS-only shell, a
non-HTML target or a timeout yields nothing and the take falls back to being
written from the summary — collection never fails because a publisher's site
is slow.

The take prompt bans the filler an LLM reaches for when it has nothing to
say ("엔지니어들은 …을 주목해야 합니다", "…에 기여할 수 있습니다", "…추가 검증이 필요할
수 있습니다" without saying what) and requires every claim to be anchored in
something the article states — including what is conspicuously missing (no
benchmark, no price, no independent source). On Opus that turns the take
from a restatement of the headline into the one paragraph worth opening the
card for; on gpt-4o it mostly stops the worst of it.

A closed card is therefore: NEW/verification badge, category, the Must Know
number, the headline, `발행 <date> · <N일 전>` (the story's earliest
publication across its sources, so a later repost cannot make old news look
new), and the one-line gist. Everything else — the AI take, the verification
reasoning, all five score rationales — sits behind two toggles. Platform
tags and the four sub-score pills used to sit on the card too; a reader
review found the card was 70% metadata and 30% news, and the sub-scores are
still one click away under "왜 이 점수인가".

Every card and detail view ends with **AI에게 더 물어보기: Claude · ChatGPT**.
Those are plain links to `claude.ai/new?q=…` and `chatgpt.com/?q=…` with the
headline, the gist and the 원문 URL pre-filled as a question, so "I want to
know more about this" is one click, answered on the reader's own account —
no key, no backend, no cost on this side (`askPrompt` in `public/logic.js`).

The home view also has a **최근 7일 / 최근 30일 / 전체 기간** window, defaulting
to 7 days. The viral score rewards accumulated engagement, so a two-week-old
story can legitimately outrank today's; that is right for "what is big" and
wrong for a page titled "오늘의 Must Know", so recency is a filter on top of
the ranking rather than a change to it.

A story is in the window if **any of its sources** published inside it
(`latestPublishedAt`), not only its first one. A Hugging Face model is dated
from repo creation, routinely a week before the weights go public and HN
notices — keyed on the first date, Qwen 3.8 27B (1,354 HN points) was
missing from the default view while an opinion post about it was on it.
Dedup refuses title merges across more than a 7-day gap, so this cannot
resurrect month-old news; the card still shows the real first 발행 date.
Cards whose newest source is less than 24h older than the snapshot carry a
red **NEW** badge, so a daily reader can tell today's arrivals from the
big stories still holding their rank from earlier in the week.

Work is keyed on a SHA-1 of `title + summary` (digits stripped from the
summary — HN, GitHub and Hugging Face summaries embed live counts, which
used to re-translate ~100 unchanged items a day), so a daily re-collect
only pays for genuinely new or edited items. Pending items are done newest
first, at most `TRANSLATE_LIMIT` (120) per run: a prompt-version bump makes
the whole archive pending, and this way the landing page is redone on day
one without one run tripping a subscription rate limit. Everything the app generates itself
(verification statuses and reasoning, all five score rationales) is written
in both languages directly in `src/verification` and `src/scoring` — no API
call involved, so the explanations are always readable in Korean even when
translation is off.

Translation is entirely optional. With no provider configured, a failing
API or CLI, or a malformed response, the affected stories simply keep their English
original and are tagged `원문(영어)` in the UI. Collection never fails
because of translation.

## Test

```
npm test
```

Runs the full suite via the built-in `node --test` runner. Covers dedup
(same-URL and similar-title merging), all four scores plus the Must-Know
score, the five verification states (including the independent-source and
company-claim rules), the live-adapter fixture fallback path, the
translation cache (no key, unchanged items, edited items, API failure,
malformed response, migrating a DB written before `takeKo` existed), the
Hugging Face adapter (org attribution, age/traction floors, unreachable
Hub), article extraction (chrome stripping, paywall/JS-shell/non-HTML
rejection, concurrency cap), the model fallback, and the Korean/English
fallback, recency window, and as-of staleness logic the UI renders.

## Environment variables

See `.env.example`. All are optional — the app runs with none of them set.

| Variable | Used in | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | `src/adapters/github/index.js` | GitHub personal access token, sent as a `Bearer` header on the repo-search request to raise the public API's rate limit. Collection still works unauthenticated, just at GitHub's lower unauthenticated limit. |
| `TRANSLATOR` | `src/translate/index.js` | `claude` (Claude Code CLI, subscription-billed) or `openai` (default). |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code CLI | From `claude setup-token`; only needed where the CLI is not already logged in (CI). |
| `CLAUDE_MODEL` | `src/translate/index.js` | Model alias/id for `TRANSLATOR=claude`. Defaults to `opus`. |
| `TRANSLATE_LIMIT` | `src/translate/index.js` | Max items translated per run, newest first. Defaults to 120. |
| `OPENAI_API_KEY` | `src/translate/index.js` | Key for `TRANSLATOR=openai`. Unset → those items stay English. |
| `OPENAI_MODEL` | `src/translate/index.js` | Model for `TRANSLATOR=openai`. Defaults to `gpt-4o`; falls back to `gpt-4o-mini` if the id is rejected. |
| `RETENTION_DAYS` | `scripts/collect.js` | Days of history to keep; items published before that are deleted after each collection, along with their translations. Defaults to 180. |
| `DB_PATH` | `scripts/collect.js`, `scripts/serve.js` | Filesystem path to the local SQLite database file. Defaults to `data/app.db`. |
| `PORT` | `scripts/serve.js` | HTTP port for the web server. Defaults to `3000`. |

No API key is ever required to run the app — RSS and Hacker News need none,
and GitHub's public search API works without one.

## Data sources

- **Official RSS/Atom feeds** (`src/adapters/rss/index.js`): first-party lab
  and research feeds (OpenAI, Google DeepMind, Google AI, Google Research,
  Hugging Face, **Qwen/Alibaba**, Microsoft Research, Berkeley BAIR, GitHub
  AI/ML) plus independent media (TechCrunch, The Verge, VentureBeat, MIT
  Tech Review, Ars Technica, **MarkTechPost** and **The Decoder** — both of
  which cover open-weight Chinese releases far more closely than the US tech
  press) and the **GitHub Copilot changelog**, the one first-party feed of
  distribution events ("Grok 4.6 is now available in GitHub Copilot").
  Hand-rolled regex XML parsing (no dependency).
- **Hugging Face trending models** (`src/adapters/huggingface/index.js`):
  the public Hub API, no key. This is what actually carries open-weight
  releases — Kimi, Qwen, DeepSeek, MiniMax, GLM, Llama — because those labs
  often ship the model first and blog about it later or never in English.
  Uploads under a known org namespace (`moonshotai/`, `deepseek-ai/`,
  `Qwen/`, …) count as that lab publishing its own release; anything else is
  a community re-upload and needs far more traction to qualify as news.
- **Hacker News** (`src/adapters/hackernews/index.js`): the Algolia search
  API, no key needed. Every story above 50 points in the last 36 hours —
  not the front page at the minute the collector runs, which missed anything
  that peaked earlier in the day (Qwen 3.8 27B at 1,354 points, on
  2026-08-15) — filtered by an AI keyword list that includes lab and model
  names (qwen, deepseek, kimi, glm, llama, grok …), since those headlines
  often carry no generic AI word at all. The submission is the page it links
  to, so its publisher is taken from that host
  (`publisherForUrl` in `src/adapters/sourceItem.js`: lab and vendor domains
  are `company`, arxiv/.edu `research-org`, Reuters/Verge/Ars… `independent-
  media`, everything else `community`). Before this every HN item was
  `community`, so "Cursor launches Origin" (cursor.com) and a GPT price cut
  on openrouter.ai ranked like forum posts, below opinion blogs.
- **GitHub** (`src/adapters/github/index.js`): the public REST search API
  (`api.github.com/search/repositories`). GitHub has no official "trending"
  endpoint, so this approximates it: repos tagged `artificial-intelligence`
  pushed in the last 7 days, sorted by stars.
Feed entries older than 120 days are dropped at collection time: some feeds
publish their whole archive, and an abandoned one keeps serving old posts as
if they were current (`qwenlm.github.io/blog` still serves 44 entries whose
newest is from September 2025). Stored items are pruned at 180 days
(`RETENTION_DAYS`), so nothing that has aged out of every source lingers in
the rankings — upsert alone never deletes.

- **Feedless labs** (`src/adapters/labposts/index.js`): labs with no public
  feed (Anthropic, Meta AI, Mistral, xAI, **Qwen**, DeepSeek, Moonshot, Z.ai,
  MiniMax, AI2) discovered by domain through HN's search index, which yields
  their own posts with canonical URLs. Qwen belongs here rather than in the
  feed list: `qwenlm.github.io`'s feed stopped in September 2025 and `qwen.ai`
  is a SPA that returns the same HTML for every path, so its announcements —
  including Qwen3.8-Max, 1,121 points on HN — are only reachable by their
  submitted URL.
- **Fixtures** (`src/adapters/fixtures/index.js`): 19 hand-written, realistic
  items covering all 7 categories, with deliberately engineered same-URL
  duplicates, similar-title duplicates, cross-platform overlaps, a disputed
  pair, and an unverified claim. Used automatically whenever a live source
  returns nothing (see `src/collect/index.js`), and directly by the test
  suite for deterministic assertions.

## Scoring methodology

Every story gets four independently computed 0–100 scores plus a derived
Must-Know score (`src/scoring/index.js`). Each score's UI display includes
a plain-language rationale explaining the specific numbers behind it.

- **Viral**: the best-placed constituent item's *reactions-per-hour-since-
  publish*, converted to a percentile rank against other items on the same
  platform (not raw totals — this stops an old post from winning purely by
  having accumulated more reactions than a fast-rising new one), plus a
  bonus (up to +20) for appearing on multiple platforms. Age is floored at
  24 hours because collection is daily: with a 0.5h floor a 3-point thread
  found 36 minutes after posting rated "5/hr", the 92nd percentile.
- **Publisher influence**: a base score by publisher type (government 80,
  company 75, independent-media 70, research-org 65, community 35),
  adjusted by observed reach (GitHub stars or estimated reads) where
  available. This never looks at verification status.
- **Credibility**: derived directly from the verification status (see
  below) — Verified 90, Reported 65, Official claim 45, Disputed 30,
  Unverified 20, with a small bonus for more than 2 independent sources.
  This never looks at publisher influence or reach, so a highly-influential
  publisher cannot buy a high credibility score by itself.
- **Industry impact**: a category weight (Safety 90, Research 85, Models
  80, Policy 80, Funding 65, Open Source 60, Products 55) blended with the
  story's engagement percentile within its platform, plus a small bonus for
  multi-platform coverage.
- **Must-Know score**: a weighted blend of all four — viral ×0.4 +
  influence ×0.1 + credibility ×0.2 + impact ×0.3, plus a flat +10 when a
  primary source (the org's own post, paper or release) is present — so
  influence alone cannot dominate the ranking.

Percentiles are always computed within the current collection batch (e.g.
"this HN item's rate vs. every other HN item just collected"), not against
a fixed historical baseline.

**Known simplification**: "hourly rate" is `total reactions ÷ hours since
publish` from a single snapshot, not a true time-series growth rate — there's
no repeated-collection history to compute a real delta from yet. This is
a reasonable proxy (old stale posts score low, fast-rising new ones score
high) but would improve once `collect` runs on a schedule and stores
reaction counts over time.

## Verification states

Every story is assigned exactly one of five states
(`src/verification/index.js`), shown as a badge with a reasoning string:

- **Verified** — at least 2 independent, non-company sources corroborate it.
- **Official claim** — only the announcing company/companies have published
  it; no independent corroboration yet.
- **Reported** — exactly 1 independent, credible source covers it (short of
  the 2 required for Verified).
- **Disputed** — one source's content conflicts with another's account of
  the same story.
- **Unverified** — only community-sourced or unconfirmed material exists;
  no official source and no credible independent reporting.

Two rules enforce the task's core principle that influence and factuality
are not the same axis:

1. **A company's own announcement is never counted as independent
   corroboration of itself**, no matter how many times it's reposted or how
   influential the company is. It establishes only that the announcement
   was made — not that any performance/capability claim inside it is true.
   A story with only company-sourced items caps at *Official claim*, never
   *Verified*.
2. **Verified requires >= 2 independent sources**, where "source" means a
   distinct publisher, not a distinct URL — items that merely repost the
   same URL (e.g. an HN submission linking to the same article) collapse
   into one origin and count once.

## Limitations

- **Dedup is a title-similarity heuristic, not semantic matching**
  (`src/processing/dedup.js`): items merge into one story if they share a
  URL, or if their titles share ≥2 tokens, clear an IDF-weighted Jaccard of
  0.32 (rare words carry the merge, batch-common ones like "cyber" or
  "capabilities" barely count), do not carry conflicting version numbers
  (Gemini 3.5 vs 3.7 are two events) or parameter sizes (27B vs 2.4T), and
  were published within 7 days of each other (the same words four months
  apart — DeepSeek-V4-Flash's April repo and the August V4-Pro post — are
  two events, and fusing them dated the story April and hid it). It still
  under-merges genuine same-event coverage that uses very different wording:
  three outlets' takes on one 404 Media scoop ("rare books", "rare texts",
  "hidden AirTag") stay three cards, and "watermarking" ≠ "watermarks". The
  fix that would actually work is an event key assigned by the translator,
  which already reads every article — not a lower threshold.
- **Dispute detection is lexical, not a real claim-diff**: it looks for
  conflict-language patterns ("disputed", "denies", "fails to reproduce",
  etc.) between items, not an actual comparison of what each source claims.
- **RSS coverage is 3 fixed official feeds**, not a general web crawl —
  broader coverage would mean adding more feeds to
  `src/adapters/rss/index.js`.
- **GitHub "trending" is an approximation**: there is no official trending
  endpoint, so this uses topic + recency + star-sort via the search API,
  and cannot reliably distinguish an official org repo from an individual's
  (so GitHub items are always treated as `community` publisher type, never
  counted as a company's own claim).
- **No historical reaction snapshots**: viral scoring uses a single-snapshot
  rate proxy (see Scoring methodology above) rather than a true growth rate.
- **No auth or rate-limit backoff beyond what's coded**: adapters catch
  failures and return an empty result (triggering fixture fallback) rather
  than retrying; a rate-limited GitHub call simply yields no live GitHub
  items for that run.
- **The UI exposes one ordering, not four**: the page always ranks by Must
  Know and prints the weights behind it under the title. `/api/stories`
  still accepts `?sort=viral|credibility|impact|recent`, so restoring a
  sort control is a frontend-only change.
- **`takeKo` is opinion, and is labelled as such**: it is a language model
  reasoning from one summary, not analysis grounded in reporting. The prompt
  bars it from inventing facts and requires hedging, but it can still be
  wrong or shallow — it sits behind a toggle, under a notice, next to the
  원문 link, and no score is derived from it.
- **Hugging Face trending is a popularity signal, not an editorial one**: a
  quantised re-upload of last week's hit model can trend above a genuinely
  new release. The known-org allowlist, a much higher like floor for
  everyone else, and a name filter that drops community quants/fine-tunes
  (`-GGUF`, `-Uncensored-…`, `-Lora`) filter most of that, but not all. Its `createdAt` is also
  repo-creation time, not "when this became news", which is why the recency
  window offers 30 days.
- **Korean text is machine translation, not editorial rewriting**
  (`src/translate/index.js`): the model is instructed to translate only and
  add nothing, but a mistranslated headline is possible. The original is
  always one toggle away, and every card links the 원문, so the English
  source stays the authority. Stories collected before a key was configured
  keep showing English until their source text changes.
- **The one-line gist is generated, not sourced**: `gistKo` is the model's
  compression of the item's own title and summary. It can only be as
  accurate as that input — it is a scanning aid, not a claim of its own,
  which is why the verification badge is rendered next to it rather than
  derived from it.
- **Daily freshness depends on GitHub's scheduler**: cron runs can be
  delayed or (on a repo with no activity for 60 days) suspended entirely.
  The as-of stamp and its `갱신 지연` state exist so a stalled schedule is
  visible on the page instead of silently serving old news as today's.
- **Source adapters are independently pluggable but only three are
  implemented** (RSS, Hacker News, GitHub) — the shared `SourceItem`
  contract (`src/adapters/sourceItem.js`) is designed so Reddit, YouTube, or
  X adapters can be added later without changing dedup/scoring/verification.
