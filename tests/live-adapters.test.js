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

test('fetchHackerNewsItems keeps AI-related stories and maps HN fields correctly', async () => {
  const storiesById = {
    1: { id: 1, type: 'story', title: 'OpenAI releases GPT-5.2', url: 'https://openai.com/blog/gpt-5-2', score: 500, descendants: 200, time: 1754500000 },
    2: { id: 2, type: 'story', title: 'Show HN: my weekend recipe app', url: 'https://example.com/recipes', score: 10, descendants: 2, time: 1754500000 },
    3: { id: 3, type: 'job', title: 'We are hiring engineers (AI team)', time: 1754500000 },
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/topstories.json')) return { ok: true, status: 200, json: async () => [1, 2, 3] };
    const id = Number(url.match(/item\/(\d+)\.json/)[1]);
    return { ok: true, status: 200, json: async () => storiesById[id] };
  };

  const items = await fetchHackerNewsItems({ fetchImpl, now: NOW, limit: 3 });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'hn-1');
  assert.equal(items[0].url, 'https://openai.com/blog/gpt-5-2');
  assert.deepEqual(items[0].reactions, { points: 500, comments: 200 });
  assert.deepEqual(validateSourceItem(items[0]), []);
});

test('fetchHackerNewsItems falls back to the HN permalink when a story has no external url', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/topstories.json')) return { ok: true, status: 200, json: async () => [42] };
    return { ok: true, status: 200, json: async () => ({ id: 42, type: 'story', title: 'Ask HN: best local LLM setup?', score: 88, descendants: 40, time: 1754500000 }) };
  };

  const items = await fetchHackerNewsItems({ fetchImpl, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://news.ycombinator.com/item?id=42');
});

test('fetchHackerNewsItems returns [] when the topstories call fails, without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  const items = await fetchHackerNewsItems({ fetchImpl, now: NOW });
  assert.deepEqual(items, []);
});

test('fetchHackerNewsItems tolerates a single failed item fetch and still returns the rest', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/topstories.json')) return { ok: true, status: 200, json: async () => [1, 2] };
    if (url.includes('/item/1.json')) throw new Error('timeout');
    return { ok: true, status: 200, json: async () => ({ id: 2, type: 'story', title: 'New open LLM benchmark released', score: 88, descendants: 12, time: 1754500000 }) };
  };

  const items = await fetchHackerNewsItems({ fetchImpl, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'hn-2');
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
