// HTTP API layer: reads persisted SourceItems (src/db) and runs them through
// the audited pipeline (dedup -> verification -> scoring), exposing the
// result over plain node:http. Read-only — writes happen only in
// scripts/collect.js.

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllSourceItems, getTranslations, latestCollectedAt } from '../db/index.js';
import { getFixtureItems } from '../adapters/fixtures/index.js';
import { buildStories } from '../processing/dedup.js';
import { scoreStories } from '../scoring/index.js';
import { CATEGORIES } from '../adapters/sourceItem.js';

// Fixture rows may coexist with live rows in the DB (collect's per-source
// fallback upserts them, and upsert never deletes). Fixtures exist for
// offline use only — when any live item is present, serving them alongside
// real news would let hand-crafted fixture clusters outrank live stories.
const FIXTURE_IDS = new Set(getFixtureItems().map((i) => i.id));

const SORT_VALUE = {
  viral: (v) => v.scores.viral.value,
  credibility: (v) => v.scores.credibility.value,
  impact: (v) => v.scores.impact.value,
  recent: (v) => Date.parse(v.latestPublishedAt),
  mustknow: (v) => v.scores.mustKnow.value,
};

function storyCategory(items) {
  return items.find((i) => i.category)?.category ?? null;
}

// Combines dedup's Story (raw constituent items) with scoring's per-score
// rationale and verification's status/reasoning into the shape items 17/20
// need for cards and detail views. Title/summary are never fabricated —
// both come from the earliest-published item, the same "canonical" item
// buildStory() in dedup.js already picks for the story title.
const PRIMARY_PUBLISHERS = new Set(['company', 'research-org', 'government']);

export function buildStoryView(story, scored, translations = new Map()) {
  // Primary sources (the org's own post, a paper, an official release) come
  // first — they are the 원문; media items follow as corroborating 근거.
  // Within each group, earliest published first.
  const items = [...story.items].sort((a, b) => {
    const pa = PRIMARY_PUBLISHERS.has(a.publisherType) ? 0 : 1;
    const pb = PRIMARY_PUBLISHERS.has(b.publisherType) ? 0 : 1;
    return pa - pb || Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
  });
  const canonical = items[0];
  const platforms = [...new Set(items.map((i) => i.sourceType))];
  // How recently a real source covered this — what the recency window
  // (public/logic.js withinDays) and the NEW badge key on. Community
  // re-uploads of an already-released model (GGUF quants, "abliterated"
  // forks) keep landing on Hugging Face for weeks and are not new coverage:
  // one of them held Qwen 3.8 27B at #1 of the 최근 7일 tab nine days after
  // release. Fall back to every item so a community upload that IS the story
  // still gets its own date.
  const covering = items.filter((i) => !(i.publisherType === 'community' && i.sourceType === 'hf'));
  const latestPublishedAt = (covering.length ? covering : items)
    .reduce((max, i) => Math.max(max, Date.parse(i.publishedAt)), 0);
  // When the story first broke, across every source that covers it. The card
  // shows this rather than latestPublishedAt: a follow-up repost should not
  // make a three-day-old story read as published today.
  const firstPublishedAt = items.reduce((min, i) => Math.min(min, Date.parse(i.publishedAt)), Infinity);

  // Korean text (src/translate) is stored per source item, while the story's
  // title and summary can come from two different items — so each is looked
  // up against the item it actually came from. Missing rows stay null and the
  // frontend falls back to the English original; a story is never half-shown.
  const titleOwner = items.find((i) => i.title === story.title) ?? canonical;
  const titleTr = translations.get(titleOwner.id) ?? null;
  const bodyTr = translations.get(canonical.id) ?? null;

  return {
    id: story.id,
    title: story.title,
    titleKo: titleTr?.titleKo ?? null,
    summary: canonical.summary,
    summaryKo: bodyTr?.summaryKo ?? null,
    gistKo: bodyTr?.gistKo ?? null,
    // AI commentary, not reporting — the UI labels it as such and it is the
    // only generated field allowed to interpret rather than restate.
    takeKo: bodyTr?.takeKo || null,
    category: storyCategory(items),
    platforms,
    firstPublishedAt: new Date(firstPublishedAt).toISOString(),
    latestPublishedAt: new Date(latestPublishedAt).toISOString(),
    verification: scored.verification,
    scores: scored.scores,
    sources: items.map((i) => ({
      source: i.source,
      sourceType: i.sourceType,
      publisherType: i.publisherType,
      url: i.url,
      title: i.title,
      publishedAt: i.publishedAt,
      collectedAt: i.collectedAt,
      reactions: i.reactions,
    })),
  };
}

// Reads every collected item, runs the full audited pipeline, and returns
// one view per story. `now` is injectable for deterministic tests.
// Fixture items are served only when no live item exists (offline mode) or
// when FIXTURES=include is set explicitly.
export function getStoryViews(db, { now = new Date(), includeFixtures = process.env.FIXTURES === 'include' } = {}) {
  const all = getAllSourceItems(db);
  const live = all.filter((i) => !FIXTURE_IDS.has(i.id));
  const selected = includeFixtures || live.length === 0 ? all : live;
  const translations = getTranslations(db);
  // The adapters' keyword classifier is a poor one — a story merely
  // mentioning GitHub became open-source news, an RL "policy" became policy
  // news. Where src/translate has read the article and picked a category,
  // that wins. Applied here, before scoring, so the impact weight and the
  // category filter both see the same value. Re-collection overwrites the
  // adapter's column but never the translation, so this survives.
  const items = selected.map((i) => {
    const category = translations.get(i.id)?.category;
    return category ? { ...i, category } : i;
  });
  const stories = buildStories(items);
  const scored = scoreStories(stories, { now });
  const scoredById = new Map(scored.map((s) => [s.storyId, s]));
  return stories.map((story) => buildStoryView(story, scoredById.get(story.id), translations));
}

export function sortStoryViews(views, sortBy = 'mustknow') {
  const key = SORT_VALUE[sortBy] ?? SORT_VALUE.mustknow;
  return [...views].sort((a, b) => key(b) - key(a));
}

export function filterByCategory(views, category) {
  if (!category) return views;
  return views.filter((v) => v.category === category);
}

// Detail view adds a chronological timeline and a per-platform reaction
// breakdown on top of the list-view fields already in `view`.
export function buildStoryDetail(view) {
  const timeline = [...view.sources]
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    .map((s) => ({ publishedAt: s.publishedAt, source: s.source, sourceType: s.sourceType, title: s.title, url: s.url }));

  const reactionsByPlatform = {};
  for (const s of view.sources) {
    if (!reactionsByPlatform[s.sourceType]) reactionsByPlatform[s.sourceType] = [];
    reactionsByPlatform[s.sourceType].push({ source: s.source, url: s.url, reactions: s.reactions });
  }

  return { ...view, timeline, reactionsByPlatform };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Routes one request against current DB state. Exported separately from the
// socket-binding server so tests can exercise real routing logic against a
// mock { req, res } pair without opening a port.
export function handleRequest(req, res, db) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/stories') {
    const category = url.searchParams.get('category');
    if (category && !CATEGORIES.includes(category)) {
      return sendJson(res, 400, { error: `category must be one of ${CATEGORIES.join(', ')}` });
    }
    const sortBy = url.searchParams.get('sort') || 'mustknow';
    const views = getStoryViews(db);
    const sorted = sortStoryViews(filterByCategory(views, category), sortBy);
    // dataAsOf answers "언제 기준 데이터인가" — the newest collectedAt, not
    // the time of this request, so it stays honest whether it's served live
    // or baked into the static snapshot.
    return sendJson(res, 200, { stories: sorted, dataAsOf: latestCollectedAt(db) });
  }

  const detailMatch = url.pathname.match(/^\/api\/stories\/(.+)$/);
  if (req.method === 'GET' && detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    const view = getStoryViews(db).find((v) => v.id === id);
    if (!view) return sendJson(res, 404, { error: 'story not found' });
    return sendJson(res, 200, buildStoryDetail(view));
  }

  return sendJson(res, 404, { error: 'not found' });
}

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../../public', import.meta.url)));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Serves the dashboard (item 16-22's static frontend) from public/. Kept
// entirely separate from handleRequest so the audited /api/* routing is
// untouched — createServer just picks which handler a request goes to.
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const requestPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = resolve(PUBLIC_DIR + requestPath);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden');
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

export function createServer(db) {
  return createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      handleRequest(req, res, db);
    } else {
      serveStatic(req, res);
    }
  });
}
