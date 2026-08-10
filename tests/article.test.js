import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, fetchArticleText, fetchArticleTexts } from '../src/enrich/article.js';

const BODY = 'Kimi K3 was trained on 4.2 trillion tokens. '.repeat(8);

function page(inner) {
  return `<!doctype html><html><head><title>t</title><style>.a{color:red}</style></head>
    <body><nav>Home About Login</nav><script>window.x=1</script>
    ${inner}
    <footer>Copyright 2026</footer></body></html>`;
}

test('extraction keeps the article body and drops chrome, scripts, and styles', () => {
  const text = htmlToText(page(`<article><p>${BODY}</p></article>`));

  assert.match(text, /4\.2 trillion tokens/);
  assert.doesNotMatch(text, /window\.x/, 'inline scripts must not reach the model');
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /Home About Login/, 'nav is not article content');
  assert.doesNotMatch(text, /Copyright 2026/);
  assert.doesNotMatch(text, /<[a-z]/i, 'no markup survives');
});

test('extraction decodes entities and collapses whitespace, and is length-capped', () => {
  assert.equal(htmlToText('<main><p>A&nbsp;&amp;&nbsp;B\n\n   C&#39;s</p></main>'), "A & B C's");
  assert.equal(htmlToText(`<main>${'x'.repeat(9000)}</main>`, { maxChars: 100 }).length, 100);
});

test('a page with no <article>/<main> still yields its text', () => {
  assert.match(htmlToText(page(`<div class="post">${BODY}</div>`)), /4\.2 trillion tokens/);
});

function response(html, { ok = true, contentType = 'text/html; charset=utf-8' } = {}) {
  return async () => ({ ok, status: ok ? 200 : 404, headers: { get: () => contentType }, text: async () => html });
}

test('a fetched article comes back as plain text', async () => {
  const text = await fetchArticleText('https://example.com/post', { fetchImpl: response(page(`<article>${BODY}</article>`)) });
  assert.match(text, /4\.2 trillion tokens/);
});

test('paywalls, JS shells, non-HTML and errors yield no context rather than misleading context', async () => {
  const shell = await fetchArticleText('https://example.com/x', { fetchImpl: response(page('<article>Subscribe to read.</article>')) });
  assert.equal(shell, '', 'a stub too short to be an article is discarded');

  const notFound = await fetchArticleText('https://example.com/x', { fetchImpl: response('<article>' + BODY + '</article>', { ok: false }) });
  assert.equal(notFound, '');

  const pdf = await fetchArticleText('https://example.com/x.pdf', { fetchImpl: response(BODY, { contentType: 'application/pdf' }) });
  assert.equal(pdf, '');

  const dead = await fetchArticleText('https://example.com/x', {
    fetchImpl: async () => {
      throw new Error('ETIMEDOUT');
    },
  });
  assert.equal(dead, '', 'a slow publisher must not fail the collection run');
});

test('fetching many articles is bounded and skips the ones that fail', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, url: `https://example.com/${i}` }));
  let inFlight = 0;
  let peak = 0;

  const fetchArticle = async (url) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return url.endsWith('3') ? '' : `body of ${url}`;
  };

  const byId = await fetchArticleTexts(items, { concurrency: 4, fetchArticle });

  assert.equal(byId.size, 18, 'the two failures are omitted, the rest are kept');
  assert.equal(byId.get('i0'), 'body of https://example.com/0');
  assert.ok(!byId.has('i3'));
  assert.ok(peak <= 4, `concurrency cap must hold, saw ${peak} in flight`);
});
