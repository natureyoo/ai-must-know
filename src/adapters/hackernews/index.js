// Live adapter: Hacker News via the Algolia search API (the same endpoint
// src/adapters/labposts and hackernews/discussions already use), no key.
//
// It used to read the Firebase `topstories` list — i.e. the front page at
// the one minute a day the collector runs. Anything that peaked and fell
// off in the preceding 23 hours was invisible: on 2026-08-15 that was
// "Qwen 3.8 27B" at 1,354 points. So this asks for every story above a
// points floor in the last `windowHours` instead, and keeps the AI-looking
// ones. Never throws — a failed call yields [] and the fixture fallback.

import { assertValidSourceItem, publisherForUrl } from '../sourceItem.js';

const ALGOLIA_URL = 'https://hn.algolia.com/api/v1/search';

// Lab and model names matter as much as the generic terms: "Qwen 3.8 27B",
// "GLM-5.3", "Kimi K2.5" carry none of the words the first version of this
// list matched, and those are exactly the stories the viral axis is for.
const AI_KEYWORDS = /\b(ai|artificial intelligence|llms?|gpt|openai|anthropic|claude|gemini|deepmind|mistral|mixtral|machine learning|neural network|transformers?|chatbot|generative ai|genai|qwen|deepseek|kimi|moonshot|glm|zhipu|minimax|llama|grok|xai|hugging ?face|diffusion|agentic|ai agents?|open[- ]?weights?|foundation model|copilot|codex|cursor|nvidia|cuda|tpu)\b/i;

function idFor(id) {
  return `hn-${id}`;
}

export async function fetchHackerNewsItems({
  fetchImpl = fetch,
  now = new Date(),
  windowHours = 36,
  minPoints = 50,
  maxResults = 40,
  timeoutMs = 8000,
} = {}) {
  const since = Math.floor(now.getTime() / 1000) - windowHours * 3600;
  const url = `${ALGOLIA_URL}?tags=story&numericFilters=created_at_i>${since},points>=${minPoints}&hitsPerPage=300`;

  let payload;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    payload = await res.json();
  } catch {
    return [];
  }
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];

  const items = [];
  for (const hit of hits.sort((a, b) => (b.points ?? 0) - (a.points ?? 0))) {
    if (!hit?.objectID || !hit.title || !hit.created_at_i || !AI_KEYWORDS.test(hit.title)) continue;

    // The submission is the linked page: an HN post of cursor.com/blog IS a
    // Cursor announcement, so it carries that publisher (and its host as the
    // source name), not "community". Self posts and unknown hosts stay HN.
    const url = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
    const { host, publisherType } = publisherForUrl(url);
    const item = {
      id: idFor(hit.objectID),
      sourceType: 'hn',
      source: publisherType === 'community' ? 'Hacker News' : host,
      publisherType,
      category: null,
      title: hit.title,
      url,
      summary: `Hacker News submission with ${hit.points ?? 0} points and ${hit.num_comments ?? 0} comments.`,
      publishedAt: new Date(hit.created_at_i * 1000).toISOString(),
      collectedAt: now.toISOString(),
      reactions: { points: hit.points ?? 0, comments: hit.num_comments ?? 0 },
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
