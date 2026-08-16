// Shared "raw source item" contract. Every adapter (rss, hackernews, github,
// fixtures, and future ones like reddit/youtube/x) must return items shaped
// like this so processing/scoring/verification can stay adapter-agnostic.

export const SOURCE_TYPES = ['rss', 'hn', 'github', 'hf', 'fixture'];

// The original seven left two recurring kinds of story with nowhere to go:
// chips/datacenter/serving news kept landing in `products` or `models`, and
// lawsuits, pricing changes and acquisitions kept landing in `policy` or
// `funding`. Both are common enough in the collected data to need their own
// bucket rather than distorting an existing one.
export const CATEGORIES = [
  'research',
  'models',
  'products',
  'open-source',
  'infrastructure',
  'business',
  'policy',
  'funding',
  'safety',
];

// Who actually published the item — later verification logic needs this to
// tell "company announcing its own results" apart from independent reporting.
export const PUBLISHER_TYPES = [
  'company',
  'independent-media',
  'community',
  'research-org',
  'government',
];

const REQUIRED_STRING_FIELDS = [
  'id',
  'sourceType',
  'source',
  'publisherType',
  'url',
  'title',
  'summary',
  'publishedAt',
  'collectedAt',
];

// url: the canonical target this item points at. For a submission that
// links out (e.g. an HN post linking to an article), this is the external
// target URL, not the platform's wrapper/thread page — that's what makes
// same-URL dedup work across platforms. For a self-contained post with
// nothing to link to (e.g. an HN discussion with no external article), this
// is the post's own permalink; such an item will not URL-match anything.
//
// reactions: platform-appropriate engagement metrics, e.g. { points,
// comments } for hn, { stars, forks } for github, { shares, estimatedReads }
// for rss/fixture where derivable. May be `{}` — plain RSS/Atom feeds carry
// no engagement data, so an item's viral signal in that case has to come
// from elsewhere (cross-platform overlap, other adapters), not this field.

// Returns an array of human-readable problems; empty array means valid.
export function validateSourceItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object') {
    return ['item must be an object'];
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof item[field] !== 'string' || item[field].length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if (!SOURCE_TYPES.includes(item.sourceType)) {
    errors.push(`sourceType must be one of ${SOURCE_TYPES.join(', ')}`);
  }
  if (!PUBLISHER_TYPES.includes(item.publisherType)) {
    errors.push(`publisherType must be one of ${PUBLISHER_TYPES.join(', ')}`);
  }
  if (item.category !== null && !CATEGORIES.includes(item.category)) {
    errors.push(`category must be null or one of ${CATEGORIES.join(', ')}`);
  }
  if (typeof item.url === 'string' && !/^https?:\/\//.test(item.url)) {
    errors.push('url must start with http:// or https://');
  }

  const publishedAt = Date.parse(item.publishedAt);
  const collectedAt = Date.parse(item.collectedAt);
  if (Number.isNaN(publishedAt)) errors.push('publishedAt must be a parseable ISO timestamp');
  if (Number.isNaN(collectedAt)) errors.push('collectedAt must be a parseable ISO timestamp');
  if (!Number.isNaN(publishedAt) && !Number.isNaN(collectedAt) && collectedAt < publishedAt) {
    errors.push('collectedAt must not be earlier than publishedAt');
  }

  if (!item.reactions || typeof item.reactions !== 'object' || Array.isArray(item.reactions)) {
    errors.push('reactions must be an object of platform-appropriate metrics (may be empty, e.g. {} for plain RSS)');
  } else if (!Object.values(item.reactions).every((v) => typeof v === 'number')) {
    errors.push('reactions values must all be numbers');
  }

  return errors;
}

export function assertValidSourceItem(item) {
  const errors = validateSourceItem(item);
  if (errors.length > 0) {
    throw new Error(`Invalid source item (id=${item?.id ?? 'unknown'}): ${errors.join('; ')}`);
  }
}

// One canonical form for "is this the same document?", shared by dedup
// (same-URL merge) and verification (independent-origin count). Tracking
// parameters matter there: an HN submission of `theverge.com/x?utm_source=hn`
// and the feed's `theverge.com/x` used to count as two independent origins,
// which is one document masquerading as corroboration.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|ref$|ref_src$|source$|spm$|mc_cid$|mc_eid$|igshid$|si$)/i;

export function canonicalUrl(url) {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    return u.toString().replace(/\/+$/, '').replace(/\?$/, '');
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '');
  }
}
