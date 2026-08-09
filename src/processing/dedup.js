// Merges raw SourceItems (src/adapters/sourceItem.js) into Stories: items
// that point at the same URL, or make a similar enough title/claim, are
// treated as the same real-world event reported through different sources.
//
// Two independent adapters covering one event is exactly the cross-platform
// signal later scoring/verification rounds need, so every constituent item
// (with its own collectedAt/publishedAt/source/url/reactions intact) is kept
// on the resulting Story rather than collapsed into one merged record.

// ponytail: word-overlap (Jaccard) title similarity, not embeddings/NLP —
// upgrade to a semantic similarity model if fixture-scale heuristics start
// missing real near-duplicates.
const TITLE_SIMILARITY_THRESHOLD = 0.3;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'by', 'and', 'or', 'is', 'its', 'new', 's',
]);

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const token of setA) {
    if (setB.has(token)) intersectionSize++;
  }
  return intersectionSize / (setA.size + setB.size - intersectionSize);
}

export function titleSimilarity(titleA, titleB) {
  return jaccard(tokenize(titleA), tokenize(titleB));
}

function normalizeUrl(url) {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

export function shouldMergeItems(itemA, itemB) {
  if (normalizeUrl(itemA.url) === normalizeUrl(itemB.url)) return true;
  return titleSimilarity(itemA.title, itemB.title) >= TITLE_SIMILARITY_THRESHOLD;
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

// Groups items into Stories via union-find over pairwise shouldMergeItems,
// so similarity is transitive (A~B and B~C merges A, B, and C together)
// even when A and C alone wouldn't clear the threshold.
export function buildStories(items) {
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
      if (shouldMergeItems(items[i], items[j])) union(i, j);
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
