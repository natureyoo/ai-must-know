import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRssItems } from '../src/adapters/rss/index.js';
import { fetchHackerNewsItems } from '../src/adapters/hackernews/index.js';
import { fetchGithubItems } from '../src/adapters/github/index.js';
import { validateSourceItem } from '../src/adapters/sourceItem.js';

const NOW = new Date('2026-08-07T00:00:00Z');

// --- RSS -------------------------------------------------------------

test('fetchRssItems parses a realistic RSS 2.0 response into valid SourceItems', async () => {
  const xml = `<?xml version="1.0"?>
    <rss><channel>
      <item>
        <title><![CDATA[OpenAI Announces GPT-5.3 Model Update]]></title>
        <link>https://openai.com/blog/new-model</link>
        <pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate>
        <description><![CDATA[<p>OpenAI describes a new model with more parameters and improved instruction following.</p>]]></description>
      </item>
    </channel></rss>`;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => xml });

  const items = await fetchRssItems({
    fetchImpl,
    feeds: [{ url: 'https://example.com/rss.xml', source: 'Test Feed', publisherType: 'company', category: 'products' }],
    now: NOW,
  });

  assert.equal(items.length, 1);
  assert.deepEqual(validateSourceItem(items[0]), []);
  assert.equal(items[0].url, 'https://openai.com/blog/new-model');
  assert.equal(items[0].sourceType, 'rss');
  assert.equal(items[0].category, 'models');
  assert.match(items[0].summary, /improved instruction following/);
});

test('fetchRssItems parses a realistic Atom feed entry into a valid SourceItem', async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Anthropic publishes new safety alignment research</title>
        <link href="https://example.com/research/alignment-2026" />
        <published>2026-08-04T09:00:00Z</published>
        <summary>A new paper on alignment techniques for frontier models.</summary>
      </entry>
    </feed>`;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => xml });

  const items = await fetchRssItems({
    fetchImpl,
    feeds: [{ url: 'https://example.com/atom.xml', source: 'Test Feed', publisherType: 'company', category: 'research' }],
    now: NOW,
  });

  assert.equal(items.length, 1);
  assert.deepEqual(validateSourceItem(items[0]), []);
  assert.equal(items[0].url, 'https://example.com/research/alignment-2026');
  assert.equal(items[0].category, 'safety');
});

test('fetchRssItems tolerates network errors and HTTP failures per feed, never throws', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('down')) throw new Error('network down');
    return { ok: false, status: 500, text: async () => '' };
  };
  const feeds = [
    { url: 'https://down.example.com/rss.xml', source: 'Down Feed', publisherType: 'company', category: 'models' },
    { url: 'https://error.example.com/rss.xml', source: 'Error Feed', publisherType: 'company', category: 'models' },
  ];

  const items = await fetchRssItems({ fetchImpl, feeds, now: NOW });
  assert.deepEqual(items, []);
});

// --- Hacker News -------------------------------------------------------

function algolia(hits) {
  return async (url) => {
    assert.match(url, /hn\.algolia\.com\/api\/v1\/search\?tags=story&numericFilters=created_at_i>\d+,points>=\d+/);
    return { ok: true, status: 200, json: async () => ({ hits }) };
  };
}

test('fetchHackerNewsItems keeps AI-related stories (incl. lab/model names) and maps HN fields correctly', async () => {
  const items = await fetchHackerNewsItems({
    fetchImpl: algolia([
      { objectID: '2', title: 'Show HN: my weekend recipe app', url: 'https://example.com/recipes', points: 60, num_comments: 2, created_at_i: 1754500000 },
      { objectID: '1', title: 'OpenAI releases GPT-5.2', url: 'https://openai.com/blog/gpt-5-2', points: 500, num_comments: 200, created_at_i: 1754500000 },
      { objectID: '3', title: 'Qwen 3.8 27B', url: 'https://qwen.ai/blog/qwen3.8', points: 1354, num_comments: 770, created_at_i: 1754500000 },
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((i) => i.id), ['hn-3', 'hn-1'], 'AI stories only, most points first; "Qwen" alone must qualify');
  assert.equal(items[1].url, 'https://openai.com/blog/gpt-5-2');
  assert.deepEqual(items[1].reactions, { points: 500, comments: 200 });
  assert.deepEqual(validateSourceItem(items[0]), []);
});

test('fetchHackerNewsItems falls back to the HN permalink when a story has no external url', async () => {
  const items = await fetchHackerNewsItems({
    fetchImpl: algolia([{ objectID: '42', title: 'Ask HN: best local LLM setup?', points: 88, num_comments: 40, created_at_i: 1754500000 }]),
    now: NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://news.ycombinator.com/item?id=42');
});

test('fetchHackerNewsItems returns [] when the search call fails, without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  const items = await fetchHackerNewsItems({ fetchImpl, now: NOW });
  assert.deepEqual(items, []);
});

test('fetchHackerNewsItems asks for a time window, not the front page, and caps results', async () => {
  let seen;
  const fetchImpl = async (url) => {
    seen = url;
    return { ok: true, status: 200, json: async () => ({ hits: Array.from({ length: 5 }, (_, i) => ({ objectID: String(i), title: `AI story ${i}`, url: `https://x.test/${i}`, points: 100 - i, num_comments: 1, created_at_i: 1754500000 })) }) };
  };
  const items = await fetchHackerNewsItems({ fetchImpl, now: NOW, windowHours: 36, minPoints: 50, maxResults: 3 });
  const since = Math.floor(NOW.getTime() / 1000) - 36 * 3600;
  assert.ok(seen.includes(`created_at_i>${since},points>=50`), seen);
  assert.equal(items.length, 3);
});

// --- GitHub --------------------------------------------------------------

test('fetchGithubItems parses a realistic search response into valid SourceItems', async () => {
  const payload = {
    items: [
      {
        id: 999,
        full_name: 'acme/ai-agent-kit',
        html_url: 'https://github.com/acme/ai-agent-kit',
        description: 'A framework for building AI agents',
        stargazers_count: 4200,
        forks_count: 310,
        open_issues_count: 22,
        pushed_at: '2026-08-06T12:00:00Z',
      },
    ],
  };
  let capturedHeaders;
  const fetchImpl = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => payload };
  };

  const items = await fetchGithubItems({ fetchImpl, now: NOW, token: undefined });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'github-999');
  assert.equal(items[0].sourceType, 'github');
  assert.deepEqual(items[0].reactions, { stars: 4200, forks: 310, openIssues: 22 });
  assert.deepEqual(validateSourceItem(items[0]), []);
  assert.equal(capturedHeaders.Authorization, undefined, 'must not send an Authorization header when no token is provided');
});

test('fetchGithubItems adds a caller-supplied Authorization header, never a hardcoded token', async () => {
  let capturedHeaders;
  const fetchImpl = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };

  await fetchGithubItems({ fetchImpl, now: NOW, token: 'token-supplied-by-caller-env' });
  assert.equal(capturedHeaders.Authorization, 'Bearer token-supplied-by-caller-env');
});

test('fetchGithubItems returns [] on an HTTP failure (e.g. rate limit), without throwing', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ message: 'rate limited' }) });
  const items = await fetchGithubItems({ fetchImpl, now: NOW });
  assert.deepEqual(items, []);
});

test('fetchGithubItems returns [] on a network failure, without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  const items = await fetchGithubItems({ fetchImpl, now: NOW });
  assert.deepEqual(items, []);
});

test('fetchGithubItems skips a malformed repo entry but keeps the rest of the batch', async () => {
  const payload = {
    items: [
      { id: 1, full_name: null, html_url: null, stargazers_count: 5 }, // missing required fields -> invalid url/title
      { id: 2, full_name: 'ok/repo', html_url: 'https://github.com/ok/repo', description: 'fine', stargazers_count: 10, forks_count: 1, open_issues_count: 0, pushed_at: '2026-08-05T00:00:00Z' },
    ],
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => payload });

  const items = await fetchGithubItems({ fetchImpl, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'github-2');
});

test('an abandoned feed contributes nothing rather than year-old posts', async () => {
  const { fetchRssItems } = await import('../src/adapters/rss/index.js');
  const entry = (title, date) => `<item><title>${title}</title><link>https://qwenlm.github.io/${encodeURIComponent(title)}</link><pubDate>${date}</pubDate><description>d</description></item>`;
  const xml = `<rss><channel>
    ${entry('Qwen3Guard', 'Mon, 22 Sep 2025 00:00:00 GMT')}
    ${entry('Qwen-Image', 'Mon, 04 Aug 2025 00:00:00 GMT')}
    ${entry('Something recent', 'Fri, 07 Aug 2026 00:00:00 GMT')}
  </channel></rss>`;

  const items = await fetchRssItems({
    fetchImpl: async () => ({ ok: true, text: async () => xml }),
    feeds: [{ url: 'https://qwenlm.github.io/blog/index.xml', source: 'Qwen', publisherType: 'company', category: 'models' }],
    now: new Date('2026-08-10T00:00:00.000Z'),
    maxAgeDays: 120,
  });

  assert.deepEqual(items.map((i) => i.title), ['Something recent']);
});

test('canonicalUrl treats tracking-parameter and www/trailing-slash variants as one document', async () => {
  const { canonicalUrl } = await import('../src/adapters/sourceItem.js');
  const a = canonicalUrl('https://www.theverge.com/ai/123?utm_source=hn&utm_medium=social#top');
  assert.equal(a, canonicalUrl('https://theverge.com/ai/123/'));
  assert.equal(canonicalUrl('https://x.test/a?b=1&page=2'), canonicalUrl('https://x.test/a?page=2&b=1'), 'param order is irrelevant');
  assert.notEqual(canonicalUrl('https://x.test/a?page=2'), canonicalUrl('https://x.test/a?page=3'), 'real params still distinguish');
  assert.equal(canonicalUrl('not a url'), 'not a url', 'unparseable input falls back instead of throwing');
});

test('fetchRssItems strips HTML that arrives entity-escaped inside <content>', async () => {
  const xml = `<?xml version="1.0"?><feed><entry><title>Qwen 3.8 megathread</title><link href="https://reddit.test/r/x/1"/><published>2026-08-01T00:00:00Z</published><content>&lt;div class="md"&gt;&lt;p&gt;Weights are &lt;strong&gt;out&lt;/strong&gt;.&lt;/p&gt;&lt;/div&gt;</content></entry></feed>`;
  const items = await fetchRssItems({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => xml }), feeds: [{ url: 'https://reddit.test/.rss', source: 'r/test', publisherType: 'community', category: 'models' }], now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].summary, 'Weights are out .');
});
