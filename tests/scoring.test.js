import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scoreStories, scoreStoryStandalone, PRIMARY_SOURCE_BONUS, RECENCY_BONUS } from '../src/scoring/index.js';
import { buildStories } from '../src/processing/dedup.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

const NOW = new Date('2026-08-07T12:00:00Z');

function findScoredStory(scored, itemId, stories) {
  const story = stories.find((s) => s.items.some((i) => i.id === itemId));
  return scored.find((s) => s.storyId === story.id);
}

function baseItem(overrides) {
  return {
    id: 'x', sourceType: 'hn', source: 'Hacker News', publisherType: 'community',
    category: 'models', url: 'https://example.com/x', title: 'x', summary: 'x',
    publishedAt: NOW.toISOString(), collectedAt: NOW.toISOString(), reactions: {},
    ...overrides,
  };
}

describe('scoreStories', () => {
  test('every score plus Must-know is 0-100 with a non-empty rationale, for every fixture story', () => {
    const stories = buildStories(getFixtureItems({ now: NOW }));
    const scored = scoreStories(stories, { now: NOW });
    assert.equal(scored.length, stories.length);
    for (const s of scored) {
      for (const key of ['viral', 'influence', 'credibility', 'impact', 'mustKnow']) {
        const score = s.scores[key];
        assert.ok(score.value >= 0 && score.value <= 100, `${key} out of range: ${score.value}`);
        assert.ok(typeof score.rationale === 'string' && score.rationale.length > 10, `${key} missing rationale`);
      }
    }
  });

  test('score separation: a single high-influence, low-corroboration story does not get a high credibility score', () => {
    const story = {
      id: 'story-huge-reach-single-company',
      title: 'A giant lab claims a huge breakthrough',
      items: [
        baseItem({
          id: 'huge-1', sourceType: 'rss', source: 'MegaLab', publisherType: 'company',
          url: 'https://megalab.example.com/huge-claim',
          title: 'MegaLab claims a huge breakthrough',
          reactions: { shares: 50000, estimatedReads: 5000000 },
        }),
      ],
    };
    const scored = scoreStoryStandalone(story, { now: NOW });
    assert.ok(scored.scores.influence.value >= 80, `expected high influence, got ${scored.scores.influence.value}`);
    assert.ok(scored.scores.credibility.value <= 50, `expected low credibility despite influence, got ${scored.scores.credibility.value}`);
    assert.ok(
      scored.scores.influence.value - scored.scores.credibility.value >= 30,
      'a single company voice with huge reach must not translate into high credibility',
    );
    assert.equal(scored.verification.status, 'official-claim');
  });

  test('a verified, well-corroborated story scores meaningfully higher on credibility than an official-claim-only story', () => {
    const stories = buildStories(getFixtureItems({ now: NOW }));
    const scored = scoreStories(stories, { now: NOW });
    const verifiedStory = findScoredStory(scored, 'rss-ec-eu-ai-act-guidance-official', stories);
    const officialClaimStory = findScoredStory(scored, 'rss-perplexity-comet-launch', stories);
    assert.equal(verifiedStory.verification.status, 'verified');
    assert.equal(officialClaimStory.verification.status, 'official-claim');
    assert.ok(verifiedStory.scores.credibility.value > officialClaimStory.scores.credibility.value);
  });

  test('time-decay/percentile: an old story with high raw-but-decayed reactions does not automatically outrank a new fast-rising one', () => {
    const oldStory = {
      id: 'story-old-high-raw',
      title: 'Old post with lots of accumulated but slow reactions',
      items: [
        baseItem({
          id: 'old-1', url: 'https://example.com/old-post',
          title: 'Old post with lots of accumulated but slow reactions',
          publishedAt: new Date(NOW.getTime() - 500 * 3600 * 1000).toISOString(),
          collectedAt: NOW.toISOString(),
          reactions: { points: 5000, comments: 1000 },
        }),
      ],
    };
    const newStory = {
      id: 'story-new-fast-rising',
      title: 'Brand new post rising fast',
      items: [
        baseItem({
          id: 'new-1', url: 'https://example.com/new-post',
          title: 'Brand new post rising fast',
          publishedAt: new Date(NOW.getTime() - 1 * 3600 * 1000).toISOString(),
          collectedAt: NOW.toISOString(),
          reactions: { points: 300, comments: 50 },
        }),
      ],
    };

    // Old story has ~6000 raw reactions vs the new story's ~350 — but the
    // new story's hourly rate (350/hr) is far higher than the old story's
    // (6000/500 = 12/hr), so it must win the within-platform percentile.
    const [scoredOld, scoredNew] = scoreStories([oldStory, newStory], { now: NOW });
    assert.ok(
      scoredNew.scores.viral.value > scoredOld.scores.viral.value,
      `expected new fast-rising story to outrank old high-raw-count story on viral score (old=${scoredOld.scores.viral.value}, new=${scoredNew.scores.viral.value})`,
    );
  });

  test('cross-platform blending: a story appearing on multiple platforms scores differently than an identical single-platform one', () => {
    const singlePlatformStory = {
      id: 'story-single-platform',
      title: 'Covered on one platform',
      items: [baseItem({ id: 'sp-1', sourceType: 'hn', reactions: { points: 200, comments: 40 } })],
    };
    const multiPlatformStory = {
      id: 'story-multi-platform',
      title: 'Covered on multiple platforms',
      items: [
        baseItem({ id: 'mp-1', sourceType: 'hn', reactions: { points: 200, comments: 40 } }),
        baseItem({ id: 'mp-2', sourceType: 'github', url: 'https://example.com/repo', reactions: { stars: 500, forks: 20 } }),
      ],
    };

    const scoredSingle = scoreStoryStandalone(singlePlatformStory, { now: NOW });
    const scoredMulti = scoreStoryStandalone(multiPlatformStory, { now: NOW });

    assert.ok(
      scoredMulti.scores.viral.value > scoredSingle.scores.viral.value,
      `expected cross-platform bonus to raise viral score (single=${scoredSingle.scores.viral.value}, multi=${scoredMulti.scores.viral.value})`,
    );
  });

  test('industry-impact reach percentile is scoped per platform, unaffected by a huge cross-platform outlier', () => {
    // Three hn stories with distinct magnitudes, ranked only against each
    // other. Adding a huge rss story (whose estimatedReads dwarfs any hn
    // points/comments count) must not change the hn stories' impact
    // scores — mixing raw counts across source types would have made the
    // hn stories look artificially unimpactful next to the rss outlier.
    const hnStory = (id, magnitude) => ({
      id: `story-hn-${id}`,
      title: `hn story ${id}`,
      items: [baseItem({ id: `hn-${id}`, sourceType: 'hn', url: `https://example.com/hn-${id}`, reactions: { points: magnitude } })],
    });
    const rssOutlier = {
      id: 'story-rss-outlier',
      title: 'rss outlier',
      items: [baseItem({ id: 'rss-outlier', sourceType: 'rss', url: 'https://example.com/rss-outlier', reactions: { estimatedReads: 1000000 } })],
    };

    const hnStories = [hnStory('a', 50), hnStory('b', 500), hnStory('c', 5000)];
    const withoutOutlier = scoreStories(hnStories, { now: NOW });
    const withOutlier = scoreStories([...hnStories, rssOutlier], { now: NOW });

    for (const story of hnStories) {
      const before = withoutOutlier.find((s) => s.storyId === story.id).scores.impact.value;
      const after = withOutlier.find((s) => s.storyId === story.id).scores.impact.value;
      assert.equal(after, before, `hn story ${story.id} impact score changed when an unrelated rss outlier was added (${before} -> ${after})`);
    }
  });

  test('Must-know score is a real weighted blend, not a copy of any single component', () => {
    const stories = buildStories(getFixtureItems({ now: NOW }));
    const scored = scoreStories(stories, { now: NOW });
    for (const s of scored) {
      const { viral, influence, credibility, impact, mustKnow } = s.scores;
      const values = [viral.value, influence.value, credibility.value, impact.value];
      // Blend of the four components, plus at most the flat primary-source
      // bonus (an editorial boost for stories anchored by an official
      // post/paper/release — see MUST_KNOW_WEIGHTS in src/scoring).
      assert.ok(
        mustKnow.value >= Math.min(...values) - 1 &&
          mustKnow.value <= Math.max(...values) + 1 + PRIMARY_SOURCE_BONUS,
      );
      // Must-know rationale should be traceable to all four inputs.
      for (const v of values) assert.ok(mustKnow.rationale.includes(String(v)));
    }
  });
});

test('recency tips ties toward the newer story without outranking a bigger one', () => {
  const now = new Date('2026-08-22T00:00:00.000Z');
  const item = (id, publishedAt, points) => ({
    id, sourceType: 'hn', source: 'Hacker News', publisherType: 'company',
    url: `https://example.com/${id}`, title: `Item ${id}`, summary: '', category: 'models',
    publishedAt, collectedAt: now.toISOString(), reactions: { points },
  });
  const score = (items) => scoreStoryStandalone({ id: 's', title: items[0].title, items }, { now }).scores.mustKnow.value;

  const today = score([item('a', '2026-08-21T12:00:00.000Z', 100)]);
  const weekOld = score([item('b', '2026-08-15T00:00:00.000Z', 100)]);
  assert.ok(today > weekOld, 'same story, published today, must rank above the seven-day-old one');
  assert.ok(today - weekOld <= RECENCY_BONUS, `recency must not move a story more than ${RECENCY_BONUS} points`);

  const stale = score([item('c', '2026-07-01T00:00:00.000Z', 100)]);
  const staler = score([item('d', '2026-06-01T00:00:00.000Z', 100)]);
  assert.equal(stale, staler, 'past the decay window recency stops applying — 30일/전체 tabs keep their order');
});

test('the recency term explains itself on the card, in both languages', () => {
  const now = new Date('2026-08-22T00:00:00.000Z');
  const items = [{
    id: 'a', sourceType: 'hn', source: 'Hacker News', publisherType: 'company',
    url: 'https://example.com/a', title: 'Item a', summary: '', category: 'models',
    publishedAt: '2026-08-21T00:00:00.000Z', collectedAt: now.toISOString(), reactions: { points: 100 },
  }];
  const { mustKnow } = scoreStoryStandalone({ id: 's', title: 'Item a', items }, { now }).scores;

  assert.match(mustKnow.rationaleKo, /최신성 \d/);
  assert.match(mustKnow.rationale, /recency \(last covered/);
});
