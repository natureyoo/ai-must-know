// Live adapter: Hacker News official Firebase API (item 2), no API key
// needed. Fetches top stories and keeps ones that look AI-related. Never
// throws — a failed topstories call or a failed individual item fetch just
// yields fewer results, not a crash.

import { assertValidSourceItem } from '../sourceItem.js';

const HN_BASE = 'https://hacker-news.firebaseio.com/v0';

const AI_KEYWORDS = /\b(ai|artificial intelligence|llm|gpt|openai|anthropic|claude|gemini|deepmind|mistral|machine learning|neural network|transformer|chatbot|generative ai|genai)\b/i;

function idFor(id) {
  return `hn-${id}`;
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchHackerNewsItems({ fetchImpl = fetch, now = new Date(), limit = 30, maxResults = 15, timeoutMs = 8000 } = {}) {
  let ids;
  try {
    ids = await fetchJson(fetchImpl, `${HN_BASE}/topstories.json`, timeoutMs);
  } catch {
    return [];
  }
  if (!Array.isArray(ids)) return [];

  const stories = await Promise.all(
    ids.slice(0, limit).map((id) => fetchJson(fetchImpl, `${HN_BASE}/item/${id}.json`, timeoutMs).catch(() => null)),
  );

  const items = [];
  for (const story of stories) {
    if (!story || story.type !== 'story' || story.dead || story.deleted) continue;
    if (!story.title || !story.time || !AI_KEYWORDS.test(story.title)) continue;

    const url = story.url || `https://news.ycombinator.com/item?id=${story.id}`;
    const item = {
      id: idFor(story.id),
      sourceType: 'hn',
      source: 'Hacker News',
      publisherType: 'community',
      category: null,
      title: story.title,
      url,
      summary: `Hacker News submission with ${story.score ?? 0} points and ${story.descendants ?? 0} comments.`,
      publishedAt: new Date(story.time * 1000).toISOString(),
      collectedAt: now.toISOString(),
      reactions: { points: story.score ?? 0, comments: story.descendants ?? 0 },
    };

    try {
      assertValidSourceItem(item);
    } catch {
      continue;
    }
    items.push(item);
    if (items.length >= maxResults) break;
  }
  return items;
}
