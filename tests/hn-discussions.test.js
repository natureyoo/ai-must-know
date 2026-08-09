import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fetchHnDiscussions } from '../src/adapters/hackernews/discussions.js';
import { buildStories } from '../src/processing/dedup.js';
import { assessVerification } from '../src/verification/index.js';

const NOW = new Date('2026-08-07T12:00:00Z');

function algoliaResponse(hits) {
  return {
    ok: true,
    json: async () => ({ hits }),
  };
}

describe('fetchHnDiscussions', () => {
  test('returns a same-URL hn item carrying the real points/comments', async () => {
    const url = 'https://openai.com/index/apple-is-getting-this-wrong/';
    const items = await fetchHnDiscussions({
      urls: [url],
      now: NOW,
      fetchImpl: async () =>
        algoliaResponse([
          { url, title: 'Apple is getting this wrong', points: 289, num_comments: 295, created_at: '2026-08-06T09:00:00Z' },
        ]),
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].sourceType, 'hn');
    assert.equal(items[0].url, url, 'must keep the primary URL so dedup merges the pair');
    assert.deepEqual(items[0].reactions, { points: 289, comments: 295 });
  });

  test('ignores near-matches whose URL is not the one requested', async () => {
    const items = await fetchHnDiscussions({
      urls: ['https://openai.com/index/real-post/'],
      now: NOW,
      fetchImpl: async () =>
        algoliaResponse([{ url: 'https://example.com/unrelated', title: 'Unrelated', points: 900, num_comments: 400 }]),
    });
    assert.deepEqual(items, []);
  });

  test('picks the most-discussed submission when a link was posted more than once', async () => {
    const url = 'https://deepmind.google/blog/some-post/';
    const items = await fetchHnDiscussions({
      urls: [url],
      now: NOW,
      fetchImpl: async () =>
        algoliaResponse([
          { url, title: 'first post', points: 12, num_comments: 3 },
          { url: `${url.replace(/\/$/, '')}`, title: 'repost that took off', points: 430, num_comments: 210 },
        ]),
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].reactions.points, 430);
  });

  test('never throws on a failed lookup — the link simply gets no discussion item', async () => {
    const items = await fetchHnDiscussions({
      urls: ['https://openai.com/index/whatever/'],
      now: NOW,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    assert.deepEqual(items, []);
  });

  test('the backfilled item merges into the primary story and does not fake independent corroboration', async () => {
    const url = 'https://openai.com/index/apple-is-getting-this-wrong/';
    const primary = {
      id: 'rss-openai-apple',
      sourceType: 'rss',
      source: 'OpenAI News',
      publisherType: 'company',
      category: 'policy',
      title: 'Apple is getting this wrong',
      url,
      summary: 'OpenAI responds to the lawsuit.',
      publishedAt: '2026-08-06T08:00:00Z',
      collectedAt: NOW.toISOString(),
      reactions: {},
    };
    const [discussion] = await fetchHnDiscussions({
      urls: [url],
      now: NOW,
      fetchImpl: async () =>
        algoliaResponse([{ url, title: 'Apple is getting this wrong', points: 289, num_comments: 295 }]),
    });

    const stories = buildStories([primary, discussion]);
    assert.equal(stories.length, 1, 'same URL must merge into one story');

    const platforms = new Set(stories[0].items.map((i) => i.sourceType));
    assert.deepEqual([...platforms].sort(), ['hn', 'rss'], 'story now spans both platforms');

    // The whole point of the backfill is engagement data, NOT corroboration:
    // an HN repost of a company link is still one origin.
    const verification = assessVerification(stories[0]);
    assert.notEqual(verification.status, 'verified');
  });
});
