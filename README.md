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
below) when `OPENAI_API_KEY` is set.

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
   `OPENAI_API_KEY` (optional — without it the site is English-only).

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
collected item into Korean during collection via the OpenAI API, storing
four fields per item in the `translations` table:

- `titleKo` — the headline in Korean (product/model names left intact),
- `gistKo` — **one sentence, 45-90 characters**, carrying the actual news:
  the actor, the thing, and every concrete figure, model name or benchmark in
  the source. This is the line the card is built around, so the grid can be
  read without opening anything; the prompt rejects both vague ("새로운 결과를
  발표했습니다") and headline-restating output,
- `summaryKo` — the original's content compressed to **at most 2 sentences**,
  adding what the gist had no room for (shown on the detail view),
- `takeKo` — 2-3 sentences of **AI commentary**: why this matters, what to
  watch, what to be skeptical of. This is the only generated field allowed to
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

`OPENAI_MODEL` defaults to `gpt-4o`: with only a one-line summary to work
from, `gpt-4o-mini` produced generic filler ("성능 향상을 포함할 수 있습니다").
If the configured model id is rejected, the run retries once on
`gpt-4o-mini` and logs the switch rather than turning the whole site
English.

A closed card is therefore: verification badge, category, platforms, the
headline, `발행 <date> · <N일 전>` (the story's earliest publication across
its sources, so a later repost cannot make old news look new), the one-line
gist, and the four scores. Everything else — the AI take, the verification
reasoning, all five score rationales — sits behind toggles.

The home view also has a **최근 7일 / 최근 30일 / 전체 기간** window, defaulting
to 7 days. The viral score rewards accumulated engagement, so a two-week-old
story can legitimately outrank today's; that is right for "what is big" and
wrong for a page titled "오늘의 Must Know", so recency is a filter on top of
the ranking rather than a change to it.

30 days exists because a Hugging Face model's publication date is when its
repo was created, which is routinely weeks before it trends — a 7-day window
hides most open-weight releases. Widening the window is honest; back-dating
those items to "today" would not be, and every card shows its real 발행 date
either way.

Work is keyed on a SHA-1 of `title + summary`, so a daily re-collect only
pays for genuinely new or edited items. Everything the app generates itself
(verification statuses and reasoning, all five score rationales) is written
in both languages directly in `src/verification` and `src/scoring` — no API
call involved, so the explanations are always readable in Korean even when
translation is off.

Translation is entirely optional. With no `OPENAI_API_KEY`, a failing API,
or a malformed response, the affected stories simply keep their English
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
| `OPENAI_API_KEY` | `src/translate/index.js` | Used by `npm run collect` to render titles/summaries in Korean. Unset → the dashboard falls back to the English original per story. |
| `OPENAI_MODEL` | `src/translate/index.js` | Model used for translation and the AI take. Defaults to `gpt-4o`; falls back to `gpt-4o-mini` if the id is rejected. |
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
  Tech Review, Ars Technica, **MarkTechPost** — which covers open-weight
  Chinese releases far more closely than the US tech press). Hand-rolled
  regex XML parsing (no dependency).
- **Hugging Face trending models** (`src/adapters/huggingface/index.js`):
  the public Hub API, no key. This is what actually carries open-weight
  releases — Kimi, Qwen, DeepSeek, MiniMax, GLM, Llama — because those labs
  often ship the model first and blog about it later or never in English.
  Uploads under a known org namespace (`moonshotai/`, `deepseek-ai/`,
  `Qwen/`, …) count as that lab publishing its own release; anything else is
  a community re-upload and needs far more traction to qualify as news.
- **Hacker News** (`src/adapters/hackernews/index.js`): the official
  Firebase API (`hacker-news.firebaseio.com`), no key needed. Pulls current
  top stories and keeps ones matching an AI-related keyword filter.
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
  bonus (up to +20) for appearing on multiple platforms.
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
- **Must-Know score**: a weighted blend of all four — viral ×0.3 +
  influence ×0.15 + credibility ×0.3 + impact ×0.25 — so influence alone
  cannot dominate the ranking.

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
  URL, or if their titles clear a word-overlap (Jaccard) threshold of 0.3.
  This can under-merge genuine same-event coverage that uses very different
  wording (e.g. a terse HN title vs. a descriptive press headline), leaving
  it as two separate, lower-signal stories instead of one corroborated one.
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
  new release. The known-org allowlist and a much higher like floor for
  everyone else filter most of that, but not all. Its `createdAt` is also
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
