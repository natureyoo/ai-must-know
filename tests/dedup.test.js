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

// Real headlines from a production snapshot that the first version of this
// heuristic mis-grouped (a 979-point HN story attributed to the wrong lab,
// five Gemini releases as one story, Kimi chained to Qwen through two
// community re-uploads), plus the genuine multi-outlet merges that have to
// keep working. Run as one batch because document frequency — which decides
// how much a shared word is worth — is measured across the batch.
const SNAPSHOT = [
  ['openai-cyber', 'Responding to the next frontier of critical cyber capabilities', 'https://openai.com/index/cyber-capabilities'],
  ['glm-53', 'GLM-5.3: Frontier coding with emergent cyber capabilities', 'https://z.ai/blog/glm-5.3'],
  ['gemini-35-cyber', 'Introducing Gemini 3.5 Flash Cyber', 'https://blog.google/gemini-3-5-flash-cyber'],
  ['gemini-37', 'Introducing Gemini 3.7 Flash', 'https://blog.google/gemini-3-7-flash'],
  ['gemini-37-hn', 'Gemini 3.7 Flash', 'https://news.ycombinator.com/item?id=1'],
  ['gemini-omni', 'Introducing Gemini Omni', 'https://blog.google/gemini-omni'],
  ['hf-kimi', 'Kimi-K3 — Moonshot AI (Kimi)', 'https://huggingface.co/moonshotai/Kimi-K3'],
  ['hf-kimi-gguf', 'Kimi-K3-GGUF — unsloth', 'https://huggingface.co/unsloth/Kimi-K3-GGUF'],
  ['hf-qwen', 'Qwen3.8-27B — Qwen (Alibaba)', 'https://huggingface.co/Qwen/Qwen3.8-27B'],
  ['hf-qwen-gguf', 'Qwen3.8-27B-GGUF — unsloth', 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF'],
  ['hf-qwen36', 'Qwen3.6-27B — Qwen (Alibaba)', 'https://huggingface.co/Qwen/Qwen3.6-27B'],
  ['hf-minimax', 'MiniMax-H3 — MiniMax', 'https://huggingface.co/MiniMaxAI/MiniMax-H3'],
  ['hf-minimax-music', 'MiniMax-Music3 — MiniMax', 'https://huggingface.co/MiniMaxAI/MiniMax-Music3'],
  ['glm-52', 'GLM-5.2 — Z.ai (GLM)', 'https://huggingface.co/zai-org/GLM-5.2'],
  ['ai-by-hand', 'AI by Hand', 'https://news.ycombinator.com/item?id=2'],
  ['twitch-verge', 'Twitch streamers can now opt out from training Amazon’s AI', 'https://www.theverge.com/twitch-amazon-ai'],
  ['twitch-tc', 'Amazon will train on Twitch streamers’ content by default, unless they opt out', 'https://techcrunch.com/amazon-twitch'],
  ['twitch-ars', 'Twitch content has trained Amazon AI for years, but users can opt out now', 'https://arstechnica.com/twitch-amazon'],
  ['ultrafast-openai', 'Previewing Ultrafast mode: GPT-5.6 Sol at up to 14X the speed', 'https://openai.com/index/ultrafast'],
  ['ultrafast-tc', 'OpenAI introduces ‘Ultrafast,’ a new mode that makes GPT-5.6 Sol work up to 14X faster', 'https://techcrunch.com/openai-ultrafast'],
  ['ultrafast-blog', 'Accelerating GPT-5.6 Sol Ultrafast', 'https://openai.com/index/accelerating-ultrafast'],
  ['zuck-verge', 'Four takeaways from Mark Zuckerberg’s massive AI manifesto', 'https://www.theverge.com/zuck-manifesto-takeaways'],
  ['zuck-tc', 'Mark Zuckerberg’s AI manifesto is exactly why people don’t like AI', 'https://techcrunch.com/zuck-manifesto'],
  ['shield-hf', 'Shieldstral-1.0-3B — Mistral AI', 'https://huggingface.co/mistralai/Shieldstral-1.0-3B'],
  ['shield-news', 'Mistral’s Shieldstral: 3B open-weights model for multimodal moderation', 'https://venturebeat.com/shieldstral'],
  ['daybreak', 'Expanding Daybreak as the Cyber Defense Window Narrows', 'https://openai.com/index/daybreak'],
  ['daybreak-hn', 'GPT 5.6 Cyber', 'https://openai.com/index/daybreak'],
  ['gpt56-guide', 'The builder’s guide to GPT-5.6', 'https://openai.com/index/gpt-5-6-guide'],
  ['qwen-24t', 'Qwen3.8-2.4T-A95B-FP8 — Qwen (Alibaba)', 'https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B-FP8'],
  ['qwen-27b-fp8', 'Qwen3.8-27B-FP8 — Qwen (Alibaba)', 'https://huggingface.co/Qwen/Qwen3.8-27B-FP8'],
  // Same words as the DeepSeek Flash repo, four months later: another event.
  ['ds-flash-apr', 'DeepSeek-V4-Flash — DeepSeek', 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash', '2026-04-22T00:00:00Z'],
  ['ds-flash-aug', 'DeepSeek-V4-Flash-0813 — DeepSeek', 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0813', '2026-08-13T00:00:00Z'],
].map(([id, title, url, publishedAt]) => ({ id, title, url, publishedAt: publishedAt ?? '2026-08-01T00:00:00Z' }));

describe('buildStories on real mis-grouped headlines', () => {
  const stories = buildStories(SNAPSHOT);
  const storyOf = (id) => findStoryContaining(stories, id).id;
  const together = (a, b) => storyOf(a) === storyOf(b);

  test('a shared topic vocabulary is not a shared story (OpenAI cyber post vs GLM-5.3)', () => {
    // Both carry {frontier, cyber, capabilities} — three words this batch uses
    // constantly, so they must not be enough to fuse two labs' announcements.
    assert.ok(!together('openai-cyber', 'glm-53'));
  });

  test('different versions of one model line stay different stories', () => {
    assert.ok(!together('gemini-37', 'gemini-35-cyber'));
    assert.ok(!together('gemini-37', 'gemini-omni'));
    assert.ok(!together('hf-qwen', 'hf-qwen36'));
    assert.ok(!together('hf-minimax', 'hf-minimax-music'));
  });

  test('an HN retitle of the same release still merges (version shared, not conflicting)', () => {
    assert.ok(together('gemini-37', 'gemini-37-hn'));
  });

  test('community re-uploads merge with their model, not with each other', () => {
    // Two "…-GGUF — unsloth" uploads used to chain Kimi to Qwen through the
    // shared {gguf, unsloth} in the org half of the title.
    assert.ok(together('hf-kimi', 'hf-kimi-gguf'));
    assert.ok(together('hf-qwen', 'hf-qwen-gguf'));
    assert.ok(!together('hf-kimi', 'hf-qwen'));
    assert.ok(!together('hf-kimi-gguf', 'hf-qwen-gguf'));
  });

  test('one shared token is never a merge', () => {
    assert.ok(!together('glm-52', 'ai-by-hand'));
    assert.ok(!together('daybreak-hn', 'gpt56-guide'));
  });

  test('parameter sizes are discriminators: 27B and 2.4T are two releases', () => {
    assert.ok(!together('hf-qwen', 'qwen-24t'));
    assert.ok(together('hf-qwen', 'qwen-27b-fp8'));
  });

  test('title merges need publish dates within a week', () => {
    assert.ok(!together('ds-flash-apr', 'ds-flash-aug'));
  });

  test('three outlets reporting the Twitch/Amazon opt-out are one story', () => {
    assert.ok(together('twitch-verge', 'twitch-tc'));
    assert.ok(together('twitch-verge', 'twitch-ars'));
  });

  test('the Ultrafast launch, its coverage, and the follow-up post are one story', () => {
    assert.ok(together('ultrafast-openai', 'ultrafast-tc'));
    assert.ok(together('ultrafast-openai', 'ultrafast-blog'));
  });

  test('a Hugging Face model card merges with press coverage of that release', () => {
    assert.ok(together('shield-hf', 'shield-news'));
  });

  test('two takes on the same Zuckerberg manifesto are one story', () => {
    assert.ok(together('zuck-verge', 'zuck-tc'));
  });

  test('an HN retitle of the same URL merges however different the title', () => {
    assert.ok(together('daybreak', 'daybreak-hn'));
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
