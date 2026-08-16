// Fetches the original article and reduces it to plain text, so the AI take
// (src/translate) is written from what the piece actually says rather than
// from a one-line RSS teaser. Feed descriptions are often a single sentence —
// enough to report the headline, not enough to say anything useful about why
// it matters.
//
// Best-effort by design: a paywall, a JS-only page, a redirect loop or a
// timeout yields '', and the take falls back to being written from the
// summary. Collection must never fail because a publisher's site is slow.

const BLOCK_TAGS = /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
// Wikipedia-style "[1]" citation markers and the boilerplate link furniture
// around an article body survive tag-stripping and waste input tokens.
const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

export function htmlToText(html, { maxChars = 4000 } = {}) {
  let text = String(html).replace(BLOCK_TAGS, ' ');

  // Prefer the semantic body when the page marks one — it drops menus,
  // related-article rails and cookie banners without needing a parser.
  const body = text.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (body) text = body[1];

  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

const BLOCK_PAGE = /captcha|just a moment|access denied|enable javascript|verify you are human|are you a robot|subscribe to (?:continue|read)|sign in to continue/i;

export async function fetchArticleText(url, { fetchImpl = fetch, timeoutMs = 8000, maxChars = 4000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'ai-must-know/1.0 (+https://github.com/natureyoo/ai-must-know)' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) return '';
    const text = htmlToText(await res.text(), { maxChars });
    // A page that reduces to a couple of words is a paywall notice or a JS
    // shell, not an article — better no context than misleading context.
    // Same for a bot wall or subscription wall long enough to pass the length
    // check: the take must not be written from a CAPTCHA page.
    if (text.length < 200 || BLOCK_PAGE.test(text.slice(0, 600))) return '';
    return text;
  } catch {
    return '';
  }
}

// Bounded-concurrency map. Sequential fetching of a few hundred articles
// would dominate the collection run; unbounded would hammer a handful of
// publishers all at once.
export async function fetchArticleTexts(items, { concurrency = 8, fetchArticle = fetchArticleText, ...options } = {}) {
  const byId = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      const text = await fetchArticle(item.url, options);
      if (text) byId.set(item.id, text);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return byId;
}
