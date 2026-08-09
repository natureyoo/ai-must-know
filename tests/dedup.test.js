import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildStories, titleSimilarity, shouldMergeItems } from '../src/processing/dedup.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

const NOW = new Date('2026-08-07T12:00:00Z');

function findStoryContaining(stories, itemId) {
  return stories.find((story) => story.items.some((item) => item.id === itemId));
}

describe('buildStories', () => {
  test('merges items that share the same URL', () => {
    const items = getFixtureItems({ now: NOW });
    const stories = buildStories(items);

    const story = findStoryContaining(stories, 'rss-openai-gpt5-2-launch');
    assert.ok(story, 'expected a story containing the gpt-5.2 rss item');
    const ids = story.items.map((i) => i.id).sort();
    assert.deepEqual(ids, ['hn-openai-gpt5-2-submission', 'rss-openai-gpt5-2-launch']);
  });

  test('merges similar-title/claim items from different sources with different URLs', () => {
    const items = getFixtureItems({ now: NOW });
    const stories = buildStories(items);

    const story = findStoryContaining(stories, 'rss-mistral-series-c-official');
    assert.ok(story, 'expected a story containing the mistral funding item');
    const ids = story.items.map((i) => i.id).sort();
    assert.deepEqual(ids, ['rss-mistral-series-c-official', 'rss-techcrunch-mistral-funding-report']);
    // sanity check: these two items really do have different URLs — the
    // merge must be coming from title/claim similarity, not URL matching.
    assert.notEqual(story.items[0].url, story.items[1].url);
  });

  test('merges a 3-way similar-title cluster reported by independent outlets', () => {
    const items = getFixtureItems({ now: NOW });
    const stories = buildStories(items);

    const story = findStoryContaining(stories, 'rss-ec-eu-ai-act-guidance-official');
    assert.ok(story);
    const ids = story.items.map((i) => i.id).sort();
    assert.deepEqual(ids, [
      'rss-ap-eu-ai-act-guidance',
      'rss-ec-eu-ai-act-guidance-official',
      'rss-reuters-eu-ai-act-guidance',
    ]);
    const urls = new Set(story.items.map((i) => i.url));
    assert.equal(urls.size, 3, 'all three items should keep their own distinct URLs');
  });

  test('does not merge clearly unrelated items', () => {
    const items = getFixtureItems({ now: NOW });
    const stories = buildStories(items);

    const smolvlm3Story = findStoryContaining(stories, 'github-smolvlm3-trending');
    const mcpToolsStory = findStoryContaining(stories, 'github-mcp-tools-trending');
    const cometStory = findStoryContaining(stories, 'rss-perplexity-comet-launch');
    const metrStory = findStoryContaining(stories, 'rss-metr-frontier-eval-report');

    assert.notEqual(smolvlm3Story.id, mcpToolsStory.id);
    assert.notEqual(cometStory.id, metrStory.id);
    assert.equal(smolvlm3Story.items.length, 1);
    assert.equal(mcpToolsStory.items.length, 1);
  });

  test('a merged story lists all of its multi-platform source items intact', () => {
    const stories = buildStories(getFixtureItems({ now: NOW }));
    // Independent snapshot (getFixtureItems returns fresh copies each call)
    // so this compares against un-shared objects, not the same references
    // buildStories grouped — otherwise a field-overwriting bug couldn't fail.
    const freshItems = getFixtureItems({ now: NOW });

    const story = findStoryContaining(stories, 'github-agentkit-trending');
    assert.equal(story.items.length, 2);

    const sourceTypes = story.items.map((i) => i.sourceType).sort();
    assert.deepEqual(sourceTypes, ['github', 'hn'], 'story should span both platforms it was seen on');

    const githubItem = story.items.find((i) => i.sourceType === 'github');
    const hnItem = story.items.find((i) => i.sourceType === 'hn');
    const originalGithubItem = freshItems.find((i) => i.id === 'github-agentkit-trending');
    const originalHnItem = freshItems.find((i) => i.id === 'hn-agentkit-hn-discussion');

    assert.notEqual(githubItem, originalGithubItem, 'sanity check: comparing against an independent object, not itself');

    // Each constituent item must retain its own individually observed
    // fields, not a merged/overwritten version.
    assert.equal(githubItem.collectedAt, originalGithubItem.collectedAt);
    assert.equal(githubItem.publishedAt, originalGithubItem.publishedAt);
    assert.deepEqual(githubItem.reactions, originalGithubItem.reactions);
    assert.equal(hnItem.collectedAt, originalHnItem.collectedAt);
    assert.equal(hnItem.publishedAt, originalHnItem.publishedAt);
    assert.deepEqual(hnItem.reactions, originalHnItem.reactions);
  });

  test('merges the disputed neomind pair into one story (required for a future Disputed verdict)', () => {
    const items = getFixtureItems({ now: NOW });
    const stories = buildStories(items);

    const story = findStoryContaining(stories, 'rss-neomind-benchmark-claim');
    assert.ok(story);
    const ids = story.items.map((i) => i.id).sort();
    assert.deepEqual(ids, ['hn-neomind-benchmark-disputed', 'rss-neomind-benchmark-claim']);
  });

  test('every fixture item ends up in exactly one story, none dropped', () => {
    const items = getFixtureItems({ now: NOW });
    const stories = buildStories(items);

    const allStoryItemIds = stories.flatMap((story) => story.items.map((i) => i.id)).sort();
    const allItemIds = items.map((i) => i.id).sort();
    assert.deepEqual(allStoryItemIds, allItemIds);
  });

  test('handles an empty input array', () => {
    assert.deepEqual(buildStories([]), []);
  });
});

describe('titleSimilarity / shouldMergeItems', () => {
  test('identical titles score 1', () => {
    assert.equal(titleSimilarity('GPT-5.2 launches today', 'GPT-5.2 launches today'), 1);
  });

  test('completely unrelated titles score low', () => {
    const score = titleSimilarity(
      'Mistral AI Raises $1.2B Series C Led by New Investors',
      'vision-labs/smolvlm3 — open-weight 3B-parameter vision-language model',
    );
    assert.ok(score < 0.3, `expected low similarity, got ${score}`);
  });

  test('same URL forces a merge even if titles differ completely', () => {
    const a = { url: 'https://example.com/post', title: 'Completely different headline one' };
    const b = { url: 'https://example.com/post', title: 'Nothing at all alike, second headline' };
    assert.ok(shouldMergeItems(a, b));
  });

  test('different URLs and dissimilar titles do not merge', () => {
    const a = { url: 'https://example.com/a', title: 'Completely different headline one' };
    const b = { url: 'https://example.com/b', title: 'Nothing at all alike, second headline' };
    assert.ok(!shouldMergeItems(a, b));
  });
});
