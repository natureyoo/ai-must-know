import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHuggingFaceModels } from '../src/adapters/huggingface/index.js';
import { validateSourceItem } from '../src/adapters/sourceItem.js';

const NOW = new Date('2026-08-10T00:00:00.000Z');

function hubResponse(models) {
  return async () => ({ ok: true, status: 200, json: async () => models });
}

const KIMI = {
  id: 'moonshotai/Kimi-K3',
  likes: 10398,
  downloads: 1456459,
  createdAt: '2026-08-05T06:42:57.000Z',
  pipeline_tag: 'image-text-to-text',
};

test('an official org release becomes a company-published item, not an anonymous upload', async () => {
  const [item] = await fetchHuggingFaceModels({ fetchImpl: hubResponse([KIMI]), now: NOW });

  assert.deepEqual(validateSourceItem(item), [], 'must satisfy the shared SourceItem contract');
  assert.equal(item.sourceType, 'hf');
  assert.equal(item.source, 'Moonshot AI (Kimi)');
  assert.equal(item.publisherType, 'company');
  assert.equal(item.url, 'https://huggingface.co/moonshotai/Kimi-K3');
  assert.equal(item.title, 'Kimi-K3 — Moonshot AI (Kimi)');
  assert.doesNotMatch(item.title, /released on Hugging Face/, 'shared boilerplate would collapse every release into one story');
  assert.deepEqual(item.reactions, { likes: 10398, downloads: 1456459 });
});

test('an upload outside a known org is community-published, so it cannot become an Official claim', async () => {
  const [item] = await fetchHuggingFaceModels({
    fetchImpl: hubResponse([{ ...KIMI, id: 'someone/Kimi-K3-Reupload' }]),
    now: NOW,
  });

  assert.equal(item.publisherType, 'community');
  assert.match(item.source, /someone/);
});

test('trending is dominated by long-lived favourites, so anything older than the window is dropped', async () => {
  const items = await fetchHuggingFaceModels({
    fetchImpl: hubResponse([KIMI, { ...KIMI, id: 'Qwen/Qwen3-Old', createdAt: '2026-01-01T00:00:00.000Z' }]),
    now: NOW,
    maxAgeDays: 30,
  });

  assert.deepEqual(items.map((i) => i.id), ['hf-moonshotai-Kimi-K3']);
});

test('low-interest and malformed entries are skipped rather than shipped', async () => {
  const items = await fetchHuggingFaceModels({
    fetchImpl: hubResponse([
      KIMI,
      { ...KIMI, id: 'Qwen/Qwen3-Tiny', likes: 3 },
      { likes: 999, createdAt: NOW.toISOString() },
      { ...KIMI, id: 'no-slash-id', likes: 999 },
      { ...KIMI, id: 'Qwen/Qwen3-NoDate', createdAt: undefined },
    ]),
    now: NOW,
    minLikes: 20,
  });

  assert.deepEqual(items.map((i) => i.id), ['hf-moonshotai-Kimi-K3']);
});

test('community quants and fine-tunes are downstream of the news, whatever their traction; a new lab is not', async () => {
  const quant = { ...KIMI, id: 'someone/Kimi-K3-GGUF', likes: 3000 };
  const finetune = { ...KIMI, id: 'someone/Kimi-K3-Uncensored-Heretic', likes: 900 };
  const newLab = { ...KIMI, id: 'meta-models/Muse-Glimmer-30B', likes: 1500 };
  const smallLab = { ...KIMI, id: 'meta-models/Muse-Glimmer-7B', likes: 120 };
  const ownQuant = { ...KIMI, id: 'moonshotai/Kimi-K3-FP8', likes: 50 };

  const items = await fetchHuggingFaceModels({
    fetchImpl: hubResponse([KIMI, quant, finetune, newLab, smallLab, ownQuant]),
    now: NOW,
    minLikes: 20,
    minLikesUnknownOrg: 300,
  });

  assert.deepEqual(items.map((i) => i.id), ['hf-moonshotai-Kimi-K3', 'hf-meta-models-Muse-Glimmer-30B', 'hf-moonshotai-Kimi-K3-FP8']);
});

test('an unreachable Hub yields no items instead of throwing (the pipeline falls back per source)', async () => {
  const dead = async () => {
    throw new Error('network down');
  };
  assert.deepEqual(await fetchHuggingFaceModels({ fetchImpl: dead, now: NOW }), []);

  const notJson = async () => ({ ok: true, status: 200, json: async () => ({ error: 'nope' }) });
  assert.deepEqual(await fetchHuggingFaceModels({ fetchImpl: notJson, now: NOW }), []);

  const http500 = async () => ({ ok: false, status: 500, json: async () => [] });
  assert.deepEqual(await fetchHuggingFaceModels({ fetchImpl: http500, now: NOW }), []);
});
