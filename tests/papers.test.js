import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHuggingFacePapers } from '../src/adapters/huggingface/papers.js';
import { validateSourceItem } from '../src/adapters/sourceItem.js';

const NOW = new Date('2026-08-22T00:00:00.000Z');

function entry({ id, upvotes, publishedAt, title = 'A paper about agents', comments = 3 }) {
  return {
    title,
    publishedAt: '2026-08-21T20:00:00.000Z',
    numComments: comments,
    paper: { id, upvotes, publishedAt, title, summary: 'We introduce a benchmark for long-horizon agent tasks.' },
  };
}

const respond = (entries) => async () => ({ ok: true, status: 200, json: async () => entries });

test('a well-upvoted paper becomes a research-org item pointing at arXiv, not at Hugging Face', async () => {
  const [item] = await fetchHuggingFacePapers({
    fetchImpl: respond([entry({ id: '2608.15089', upvotes: 435, publishedAt: '2026-08-20T00:00:00.000Z' })]),
    now: NOW,
  });

  assert.deepEqual(validateSourceItem(item), []);
  assert.equal(item.sourceType, 'papers', 'paper upvotes must not be pooled with model downloads');
  assert.equal(item.publisherType, 'research-org');
  assert.equal(item.url, 'https://arxiv.org/abs/2608.15089', 'the primary source, and what HN submits');
  assert.equal(item.category, 'research');
  assert.deepEqual(item.reactions, { upvotes: 435, comments: 3 });
});

test('the long tail of one-upvote submissions is dropped', async () => {
  const items = await fetchHuggingFacePapers({
    fetchImpl: respond([
      entry({ id: '2608.1', upvotes: 435, publishedAt: '2026-08-20T00:00:00.000Z' }),
      entry({ id: '2608.2', upvotes: 2, publishedAt: '2026-08-20T00:00:00.000Z' }),
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((i) => i.id), ['paper-2608.1']);
});

test('the story is dated from arXiv publication, not from the day it was surfaced', async () => {
  const items = await fetchHuggingFacePapers({
    fetchImpl: respond([entry({ id: '2604.9', upvotes: 300, publishedAt: '2026-04-01T00:00:00.000Z' })]),
    now: NOW,
    maxAgeDays: 30,
  });

  assert.deepEqual(items, [], 'a months-old paper resurfaced today is not today’s news');
});

test('an unreachable or reshaped API yields no items rather than throwing', async () => {
  const reject = async () => { throw new Error('ENOTFOUND'); };
  assert.deepEqual(await fetchHuggingFacePapers({ fetchImpl: reject, now: NOW }), []);
  assert.deepEqual(await fetchHuggingFacePapers({ fetchImpl: async () => ({ ok: false, status: 503 }), now: NOW }), []);
  assert.deepEqual(await fetchHuggingFacePapers({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }), now: NOW }), []);
});

test('only the most-upvoted papers of the window make the page', async () => {
  const many = Array.from({ length: 20 }, (_, n) =>
    entry({ id: `2608.${n}`, upvotes: 300 - n * 10, publishedAt: '2026-08-20T00:00:00.000Z' }));
  const items = await fetchHuggingFacePapers({ fetchImpl: respond(many), now: NOW, maxPapers: 5 });

  assert.equal(items.length, 5, 'uncapped, a curated pool takes over the ranking');
  assert.deepEqual(items.map((i) => i.reactions.upvotes), [300, 290, 280, 270, 260]);
});
