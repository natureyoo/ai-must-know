import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assessVerification, VERIFICATION_STATUSES } from '../src/verification/index.js';
import { buildStories } from '../src/processing/dedup.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

const NOW = new Date('2026-08-07T12:00:00Z');

function findStoryContaining(stories, itemId) {
  return stories.find((story) => story.items.some((item) => item.id === itemId));
}

function assess(itemId) {
  const stories = buildStories(getFixtureItems({ now: NOW }));
  const story = findStoryContaining(stories, itemId);
  assert.ok(story, `expected a story containing ${itemId}`);
  return assessVerification(story);
}

describe('assessVerification', () => {
  test('a single company-only source caps at Official claim, never Verified', () => {
    const result = assess('rss-perplexity-comet-launch');
    assert.equal(result.status, 'official-claim');
    assert.notEqual(result.status, 'verified');
  });

  test('a same-URL company + community repost is not 2 independent sources', () => {
    // gpt-5.2 story: company rss item + an HN item that shares the exact
    // same URL (a resubmission of the same primary source, not independent
    // corroboration) — must not be treated as 2 independent sources.
    const result = assess('rss-openai-gpt5-2-launch');
    assert.equal(result.status, 'official-claim');
    assert.equal(result.independentSourceCount, 0);
  });

  test('two different companies each publishing their own claim (no independent coverage) still caps at Official claim', () => {
    const story = {
      id: 'story-synthetic-two-companies',
      title: 'Two vendors both claim to have shipped the fastest inference stack',
      items: [
        {
          id: 'a', sourceType: 'rss', source: 'Vendor A Blog', publisherType: 'company',
          category: 'products', url: 'https://vendor-a.example.com/fastest-stack',
          title: 'Vendor A ships the fastest inference stack', summary: 'Vendor A says so.',
          publishedAt: '2026-08-07T00:00:00Z', collectedAt: '2026-08-07T00:05:00Z', reactions: {},
        },
        {
          id: 'b', sourceType: 'rss', source: 'Vendor B Blog', publisherType: 'company',
          category: 'products', url: 'https://vendor-b.example.com/fastest-stack-too',
          title: 'Vendor B also claims the fastest inference stack', summary: 'Vendor B says so too.',
          publishedAt: '2026-08-07T00:00:00Z', collectedAt: '2026-08-07T00:05:00Z', reactions: {},
        },
      ],
    };
    const result = assessVerification(story);
    assert.equal(result.status, 'official-claim');
    assert.notEqual(result.status, 'verified');
    assert.equal(result.independentSourceCount, 0);
  });

  test('two articles from the same independent outlet count as one publisher, not two', () => {
    const story = {
      id: 'story-synthetic-same-outlet-twice',
      title: 'One outlet, two separate write-ups',
      items: [
        {
          id: 'c1', sourceType: 'rss', source: 'Reuters', publisherType: 'independent-media',
          category: 'policy', url: 'https://reuters.example.com/article-one',
          title: 'Reuters covers the story, part one', summary: 'First write-up.',
          publishedAt: '2026-08-07T00:00:00Z', collectedAt: '2026-08-07T00:05:00Z', reactions: {},
        },
        {
          id: 'c2', sourceType: 'rss', source: 'Reuters', publisherType: 'independent-media',
          category: 'policy', url: 'https://reuters.example.com/article-two-follow-up',
          title: 'Reuters follow-up on the same story', summary: 'Second write-up, same outlet.',
          publishedAt: '2026-08-07T01:00:00Z', collectedAt: '2026-08-07T01:05:00Z', reactions: {},
        },
      ],
    };
    const result = assessVerification(story);
    assert.equal(result.independentSourceCount, 1, 'same outlet twice must count as 1 independent source, not 2');
    assert.equal(result.status, 'reported');
    assert.notEqual(result.status, 'verified');
  });

  test('an independent article plus its own HN repost (same URL) is one origin, not two independent sources', () => {
    // Reuters covers the story (independent-media) and someone submits that
    // exact same URL to HN (community) — same origin, one voice. Paired
    // with a second, genuinely separate independent-media origin, only the
    // second one should push the count to 2.
    const story = {
      id: 'story-synthetic-reposted-independent-origin',
      title: 'Independent report plus its own HN repost, plus a second outlet',
      items: [
        {
          id: 'r1', sourceType: 'rss', source: 'Reuters', publisherType: 'independent-media',
          category: 'policy', url: 'https://reuters.example.com/the-story',
          title: 'Reuters reports the story', summary: 'Original independent reporting.',
          publishedAt: '2026-08-07T00:00:00Z', collectedAt: '2026-08-07T00:05:00Z', reactions: {},
        },
        {
          id: 'r2', sourceType: 'hn', source: 'Hacker News', publisherType: 'community',
          category: 'policy', url: 'https://reuters.example.com/the-story',
          title: 'Reuters reports the story (HN submission)', summary: 'HN thread linking to the Reuters article.',
          publishedAt: '2026-08-07T00:10:00Z', collectedAt: '2026-08-07T00:20:00Z', reactions: { points: 50, comments: 10 },
        },
      ],
    };
    const soloResult = assessVerification(story);
    assert.equal(soloResult.independentSourceCount, 1, 'the HN repost must not add a second independent voice');
    assert.equal(soloResult.status, 'reported');

    const secondOutletItem = {
      id: 'r3', sourceType: 'rss', source: 'Associated Press', publisherType: 'independent-media',
      category: 'policy', url: 'https://ap.example.com/the-story-too',
      title: 'AP independently reports the same story', summary: 'A second, genuinely separate outlet.',
      publishedAt: '2026-08-07T00:15:00Z', collectedAt: '2026-08-07T00:25:00Z', reactions: {},
    };
    const twoVoiceResult = assessVerification({ ...story, items: [...story.items, secondOutletItem] });
    assert.equal(twoVoiceResult.independentSourceCount, 2);
    assert.equal(twoVoiceResult.status, 'verified');
  });

  test('a claim cannot be Disputed against itself — a lone item never triggers Disputed', () => {
    const story = {
      id: 'story-synthetic-lone-dispute-word',
      title: 'A lone report using dispute-flavored language about someone else',
      items: [
        {
          id: 'd1', sourceType: 'rss', source: 'Some Outlet', publisherType: 'independent-media',
          category: 'safety', url: 'https://outlet.example.com/denies-story',
          title: 'Company denies a rumor that was never independently reported',
          summary: 'The only source on this; nothing else corroborates or conflicts with it.',
          publishedAt: '2026-08-07T00:00:00Z', collectedAt: '2026-08-07T00:05:00Z', reactions: {},
        },
      ],
    };
    const result = assessVerification(story);
    assert.notEqual(result.status, 'disputed');
  });

  test('two or more independent non-company sources agreeing → Verified', () => {
    // EU AI Act story: government primary + Reuters + AP, genuinely
    // independent outlets with distinct URLs corroborating the same guidance.
    const result = assess('rss-ec-eu-ai-act-guidance-official');
    assert.equal(result.status, 'verified');
    assert.ok(result.independentSourceCount >= 2, `expected >=2 independent sources, got ${result.independentSourceCount}`);
  });

  test('a single independent-media source with no second corroborator → Reported, not Verified', () => {
    // Mistral story: company announcement + TechCrunch's independent
    // confirmation — only 1 independent source, short of the 2 required.
    const result = assess('rss-mistral-series-c-official');
    assert.equal(result.status, 'reported');
    assert.equal(result.independentSourceCount, 1);
  });

  test('conflicting sources about the same claim → Disputed', () => {
    // NeoMind story: company benchmark claim + an independent report that
    // it doesn't reproduce.
    const result = assess('rss-neomind-benchmark-claim');
    assert.equal(result.status, 'disputed');
  });

  test('a lone unconfirmed community claim with nothing to corroborate it → Unverified', () => {
    const result = assess('hn-jailbreak-claim-unverified');
    assert.equal(result.status, 'unverified');
  });

  test('same-URL community reposts of a company URL do not count as independent corroboration', () => {
    // agentkit story: github + hn both point at the exact same repo URL —
    // one origin, not two — and neither is a company/credible-independent
    // source, so this stays Unverified rather than climbing to Reported.
    const result = assess('github-agentkit-trending');
    assert.equal(result.status, 'unverified');
    assert.equal(result.independentSourceCount, 0);
  });

  test('every story exposes evidence links, source type, status, and a reasoning string', () => {
    const stories = buildStories(getFixtureItems({ now: NOW }));
    for (const story of stories) {
      const result = assessVerification(story);
      assert.ok(VERIFICATION_STATUSES.includes(result.status));
      assert.ok(typeof result.reasoning === 'string' && result.reasoning.length > 0);
      assert.equal(result.evidence.length, story.items.length);
      for (const ev of result.evidence) {
        assert.ok(ev.url && ev.source && ev.sourceType);
      }
    }
  });

  test('no fixture story reaches Verified from a single influential source', () => {
    const stories = buildStories(getFixtureItems({ now: NOW }));
    for (const story of stories) {
      const result = assessVerification(story);
      if (result.status === 'verified') {
        assert.ok(
          result.independentSourceCount >= 2,
          `story "${story.title}" was marked Verified with only ${result.independentSourceCount} independent sources`,
        );
      }
    }
  });
});
