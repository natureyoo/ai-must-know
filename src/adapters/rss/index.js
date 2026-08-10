// Live adapter: official AI company/research RSS or Atom feeds (item 1).
// Hand-rolled regex-based XML parsing (no dependency needed for the small,
// well-formed subset of RSS 2.0 / Atom tags real feeds use). Each feed is
// fetched and parsed independently — a dead, redirecting, or malformed feed
// is skipped, never thrown, so one bad source can't blank the whole batch.

import { createHash } from 'node:crypto';
import { assertValidSourceItem } from '../sourceItem.js';

// Confirmed live and reachable (curl 200, real RSS content) as of this
// round. Company first-party feeds plus independent media — the verification
// layer requires >=2 independent non-company sources for Verified, so
// without independent-media feeds no live story can ever pass that gate.
export const DEFAULT_FEEDS = [
  { url: 'https://openai.com/news/rss.xml', source: 'OpenAI News', publisherType: 'company', category: 'models' },
  { url: 'https://deepmind.google/blog/rss.xml', source: 'Google DeepMind Blog', publisherType: 'company', category: 'research' },
  { url: 'https://huggingface.co/blog/feed.xml', source: 'Hugging Face Blog', publisherType: 'company', category: 'open-source' },
  // Non-US / open-weight labs. Without these the dashboard reads as if only
  // OpenAI, Google and Anthropic ship anything — Qwen, DeepSeek, Kimi and
  // MiniMax releases were reaching it only as secondhand coverage, if at all.
  { url: 'https://qwenlm.github.io/blog/index.xml', source: 'Qwen (Alibaba)', publisherType: 'company', category: 'models' },
  { url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', source: 'Google AI Blog', publisherType: 'company', category: 'models' },
  { url: 'https://research.google/blog/rss/', source: 'Google Research', publisherType: 'research-org', category: 'research' },
  { url: 'https://www.microsoft.com/en-us/research/feed/', source: 'Microsoft Research', publisherType: 'research-org', category: 'research' },
  { url: 'https://bair.berkeley.edu/blog/feed.xml', source: 'Berkeley BAIR', publisherType: 'research-org', category: 'research' },
  { url: 'https://github.blog/ai-and-ml/feed/', source: 'GitHub Blog (AI/ML)', publisherType: 'company', category: 'open-source' },
  // Covers open-weight releases (Qwen/DeepSeek/Kimi/GLM) far more closely
  // than the US tech press does.
  { url: 'https://www.marktechpost.com/feed/', source: 'MarkTechPost', publisherType: 'independent-media', category: 'models' },
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch AI', publisherType: 'independent-media', category: 'products' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', source: 'The Verge AI', publisherType: 'independent-media', category: 'products' },
  { url: 'https://venturebeat.com/category/ai/feed/', source: 'VentureBeat AI', publisherType: 'independent-media', category: 'products' },
  { url: 'https://www.technologyreview.com/feed/', source: 'MIT Technology Review', publisherType: 'independent-media', category: 'research' },
  { url: 'https://arstechnica.com/ai/feed/', source: 'Ars Technica AI', publisherType: 'independent-media', category: 'products' },
];

// Best-effort per-item category refinement from title/summary text — feed
// entries cover a mix of categories, so the feed's static default is only
// a fallback for when no keyword matches.
const CATEGORY_KEYWORDS = [
  ['safety', /\b(safety|alignment|jailbreak|red[- ]?team|dangerous capabilit)/i],
  ['policy', /\b(polic(y|ies)|regulat|legislat|ai act|government)/i],
  ['funding', /\b(raises?|series [a-e]\b|funding round|valuation)/i],
  ['open-source', /\b(open[- ]source|open[- ]weight|github)/i],
  ['products', /\b(launch|now available|introduc|ships?\b|chatgpt)/i],
  ['research', /\b(research|paper|study|benchmark|evaluat)/i],
  ['models', /\b(model|gpt|gemini|claude|llm|parameters?)/i],
];

function classifyCategory(text, fallback) {
  for (const [category, re] of CATEGORY_KEYWORDS) {
    if (re.test(text)) return category;
  }
  return fallback;
}

function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

// RSS <link>text</link> or Atom <link href="..."/>.
function extractLink(block) {
  const selfClosing = block.match(/<link\b[^>]*\shref=["']([^"']+)["'][^>]*\/?>/i);
  if (selfClosing) return decodeEntities(selfClosing[1]);
  const wrapped = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  return wrapped ? decodeEntities(wrapped[1]) : '';
}

function parseEntryBlocks(xml) {
  return xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
}

function idFor(url) {
  return `rss-${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
}

async function fetchOneFeed(feed, { fetchImpl, now, timeoutMs, maxPerFeed }) {
  try {
    const res = await fetchImpl(feed.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const xml = await res.text();

    const items = [];
    // Feeds are conventionally newest-first and some publish their entire
    // archive (observed: 1000+ <item> entries), so take only the front of
    // the list — this is a daily-news collector, not an archive importer.
    for (const block of parseEntryBlocks(xml).slice(0, maxPerFeed)) {
      const url = extractLink(block);
      const title = extractTag(block, 'title');
      if (!url || !title) continue;

      const rawDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
      const publishedMs = Date.parse(rawDate);
      if (Number.isNaN(publishedMs)) continue;

      const summary = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content') || title;

      const item = {
        id: idFor(url),
        sourceType: 'rss',
        source: feed.source,
        publisherType: feed.publisherType,
        category: classifyCategory(`${title} ${summary}`, feed.category),
        title,
        url,
        summary: summary.slice(0, 500),
        publishedAt: new Date(publishedMs).toISOString(),
        collectedAt: now.toISOString(),
        reactions: {},
      };

      try {
        assertValidSourceItem(item);
        items.push(item);
      } catch {
        // malformed entry (e.g. collectedAt < publishedAt from a bad clock) — skip it, not the whole feed
      }
    }
    return items;
  } catch {
    return [];
  }
}

export async function fetchRssItems({ fetchImpl = fetch, feeds = DEFAULT_FEEDS, now = new Date(), timeoutMs = 8000, maxPerFeed = 25 } = {}) {
  const results = await Promise.all(feeds.map((feed) => fetchOneFeed(feed, { fetchImpl, now, timeoutMs, maxPerFeed })));
  return results.flat();
}
