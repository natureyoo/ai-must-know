// Merges raw SourceItems (src/adapters/sourceItem.js) into Stories: items
// that point at the same URL, or make a similar enough title/claim, are
// treated as the same real-world event reported through different sources.
//
// Two independent adapters covering one event is exactly the cross-platform
// signal later scoring/verification rounds need, so every constituent item
// (with its own collectedAt/publishedAt/source/url/reactions intact) is kept
// on the resulting Story rather than collapsed into one merged record.
//
// Merge rules, in order (all but the first are AND-ed):
//  1. Same URL -> always merge, no title check. (HN retitles the post it links.)
//  2. Version guard: if both titles carry a dotted version ("3.5", "GPT-5.6",
//     "Qwen3.8-27B") and share none, refuse. Gemini 3.5 vs 3.7 are two events.
//  3. Both titles shaped "<name> — <org/description>" (how the Hugging Face
//     and GitHub adapters build titles) -> compare only the name halves, so
//     "Kimi-K3-GGUF" and "Qwen3.8-27B-GGUF" stop chaining through "unsloth".
//  4. At least 2 shared tokens: Jaccard over 3-token sets is noise.
//  5. IDF-weighted Jaccard >= 0.32, document frequency taken from the batch
//     buildStories was handed. Rare words carry the merge ("twitch",
//     "shieldstral"); batch-common ones barely count, which is what keeps
//     "frontier/cyber/capabilities" from fusing an OpenAI post with GLM-5.3.
//  6. Size guard, same shape as the version guard: "27B" and "2.4T" are two
//     models. Without it Qwen3.8-27B-FP8 ~ Qwen3.8-2.4T-A95B-FP8 on
//     {qwen3.8, fp8} chained the small release into the big one.
//  7. Time gate: title-only merges need publish dates within 7 days. Same
//     event, two outlets: hours apart. Same words, four months apart
//     (DeepSeek-V4-Flash's April repo vs the August V4-Pro post): two events
//     that union-find used to fuse into one story dated April — which the
//     7-day landing view then hid entirely.

// ponytail: word-overlap title similarity with batch IDF, not embeddings —
// upgrade to a semantic similarity model if this starts missing real
// near-duplicates. Pairwise O(n^2); fine at a few thousand items per batch.
import { canonicalUrl } from '../adapters/sourceItem.js';

const TITLE_SIMILARITY_THRESHOLD = 0.32;
const MIN_SHARED_TOKENS = 2;
const MAX_TITLE_MERGE_GAP_MS = 7 * 24 * 3600 * 1000;

const STOPWORDS = new Set([
  // Function words. They never carry the story, but two outlets phrase the
  // same event differently around them, so leaving them in inflates the
  // Jaccard denominator and sinks genuine rewrites of one headline.
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'and',
  'or', 'is', 'its', 'it', 'as', 'that', 'this', 'from', 'into', 'over',
  'after', 'before', 'up', 'all', 'be', 'was', 'are', 'has', 'have', 'do',
  'will', 'not', 'but', 'they', 'their', 'them', 'you', 'your', 'we', 'our',
  'who', 'what', 'when', 'why', 'how', 'can', 'now', 'just', 'about', 'than',
  'more', 'most', 'also', 'make', 'makes', 'made', 'new', 's',
  // Artifacts of splitting contractions ("don't" -> don, t).
  'don', 'isn', 'doesn', 'won', 'didn', 'wasn', 'aren', 'll', 've', 're',
  // Pure announcement boilerplate: in every launch headline, so it never
  // distinguishes one launch from the next.
  'introducing', 'announcing', 'launching',
]);

// "3.5", "5.6", "1.2" — including when glued to a name ("Qwen3.8-27B").
const VERSION = /\d+(?:\.\d+)+/g;
const BARE_VERSION = /^\d+(?:\.\d+)+$/;
// "27b", "2.4t", "106b" — parameter counts, glued or not.
const SIZE = /\b\d+(?:\.\d+)?[bt]\b/g;

function tokenize(text) {
  // Half the feeds ship raw HTML entities ("Zuckerberg&#8217;s"); a space
  // makes them tokenize like the decoded apostrophe version does.
  const clean = text.replace(/&#?\w+;/g, ' ').toLowerCase();
  const tokens = new Set();
  for (const word of clean.replace(/[^a-z0-9.]+/g, ' ').split(' ')) {
    // Keep dots only between digits, so "5.6" survives but "Simple." doesn't
    // become its own token.
    const token = word.replace(/(?<!\d)\.|\.(?!\d)/g, '');
    // A bare version number is a discriminator (rule 2), never a matcher:
    // counting it would pair "GPT 5.6 Cyber" with "The builder's guide to
    // GPT-5.6" on {gpt, 5.6} alone. Glued to a name ("qwen3.8", "lfm2.5")
    // it IS the name, so it stays.
    if (BARE_VERSION.test(token)) continue;
    if (token.length > 1 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return { tokens, versions: new Set(clean.match(VERSION) ?? []), sizes: new Set(clean.match(SIZE) ?? []) };
}

// Adapter-built titles are "<model or repo name> — <org or description>".
// When both sides are that shape the org half is boilerplate that chains
// unrelated releases together, so drop it. Split on the first separator only.
function tokenSets(titleA, titleB) {
  const both = titleA.includes(' — ') && titleB.includes(' — ');
  const half = (t) => (both ? t.slice(0, t.indexOf(' — ')) : t);
  return [tokenize(half(titleA)), tokenize(half(titleB))];
}

const FLAT = () => 1;

function weightedJaccard(a, b, idf) {
  let intersection = 0;
  let union = 0;
  let shared = 0;
  for (const token of a.tokens) {
    const weight = idf(token);
    union += weight;
    if (b.tokens.has(token)) {
      shared++;
      intersection += weight;
    }
  }
  for (const token of b.tokens) {
    if (!a.tokens.has(token)) union += idf(token);
  }
  return { score: union === 0 ? 0 : intersection / union, shared };
}

function disjoint(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  for (const v of a) if (b.has(v)) return false;
  return true;
}

function versionsConflict(a, b) {
  return disjoint(a.versions, b.versions) || disjoint(a.sizes, b.sizes);
}

export function titleSimilarity(titleA, titleB) {
  const [a, b] = tokenSets(titleA, titleB);
  return weightedJaccard(a, b, FLAT).score;
}


function mergeable(itemA, itemB, idf) {
  if (canonicalUrl(itemA.url) === canonicalUrl(itemB.url)) return true;
  if (Math.abs(Date.parse(itemA.publishedAt) - Date.parse(itemB.publishedAt)) > MAX_TITLE_MERGE_GAP_MS) return false;
  const [a, b] = tokenSets(itemA.title, itemB.title);
  if (versionsConflict(a, b)) return false;
  const { score, shared } = weightedJaccard(a, b, idf);
  return shared >= MIN_SHARED_TOKENS && score >= TITLE_SIMILARITY_THRESHOLD;
}

export function shouldMergeItems(itemA, itemB) {
  return mergeable(itemA, itemB, FLAT);
}

// Smoothed so a two-item batch degrades to near-flat weights (plain Jaccard)
// instead of zeroing out every token that both items share.
function batchIdf(items) {
  const df = new Map();
  for (const item of items) {
    for (const token of tokenize(item.title).tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return (token) => Math.log((items.length + 1) / ((df.get(token) ?? 0) + 1)) + 1;
}

function buildStory(items) {
  const sorted = [...items].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const canonical = sorted[0];
  return {
    id: `story-${canonical.id}`,
    title: canonical.title,
    items: sorted,
  };
}

// Groups items into Stories via union-find over pairwise merges, so
// similarity is transitive (A~B and B~C merges A, B, and C together) even
// when A and C alone wouldn't clear the threshold. The gates above are what
// keep that transitivity from running away into 8-title mega-stories.
export function buildStories(items) {
  const idf = batchIdf(items);
  const parent = items.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i, j) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (mergeable(items[i], items[j], idf)) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });

  return Array.from(groups.values()).map(buildStory);
}
