// Live adapter: trending models on the Hugging Face Hub (public JSON API,
// no key). This is the source that actually carries open-weight releases —
// Kimi, Qwen, DeepSeek, MiniMax, GLM, Llama. Those labs often ship the model
// first and blog about it later (or never in English), so a feed-only
// collector misses them entirely or picks them up days late as secondhand
// coverage.
//
// Never throws: an unreachable Hub or a shape change yields no items, and the
// collect pipeline falls back to fixtures for this source alone.

import { assertValidSourceItem } from '../sourceItem.js';

const API_URL = 'https://huggingface.co/api/models';

// An upload under an org's own namespace is that org publishing its own
// release — primary evidence that the model exists, not that its benchmark
// claims hold (the verification layer keeps that distinction). Anything
// outside this list is a community re-upload, quant, or fine-tune, and is
// treated as `community`: real signal, but not the lab speaking.
export const KNOWN_ORGS = {
  'moonshotai': 'Moonshot AI (Kimi)',
  'deepseek-ai': 'DeepSeek',
  'Qwen': 'Qwen (Alibaba)',
  'MiniMaxAI': 'MiniMax',
  'zai-org': 'Z.ai (GLM)',
  'meta-llama': 'Meta Llama',
  'mistralai': 'Mistral AI',
  'google': 'Google',
  'openai': 'OpenAI',
  'microsoft': 'Microsoft',
  'nvidia': 'NVIDIA',
  'allenai': 'Allen Institute for AI',
  'LiquidAI': 'Liquid AI',
  'ibm-granite': 'IBM Granite',
  'baidu': 'Baidu',
  'tencent': 'Tencent',
  'ByteDance': 'ByteDance',
  'stabilityai': 'Stability AI',
  'black-forest-labs': 'Black Forest Labs',
};

// A model page is a release announcement, so it belongs to `models` — except
// where the pipeline makes it plainly something else.
function categoryFor(pipelineTag) {
  if (!pipelineTag) return 'models';
  if (/^(text-to-image|image-to-image|text-to-video|image-text-to-video|text-to-speech|automatic-speech-recognition)$/.test(pipelineTag)) {
    return 'products';
  }
  return 'models';
}

function summarize(model, orgLabel) {
  const parts = [`${orgLabel} published the ${model.id} model weights on Hugging Face`];
  if (model.pipeline_tag) parts.push(`for ${model.pipeline_tag}`);
  const extras = [];
  if (Number.isFinite(model.likes)) extras.push(`${model.likes.toLocaleString()} likes`);
  if (Number.isFinite(model.downloads)) extras.push(`${model.downloads.toLocaleString()} downloads`);
  return `${parts.join(' ')}. ${extras.length ? `It has ${extras.join(' and ')} on the Hub.` : ''}`.trim();
}

export async function fetchHuggingFaceModels({
  fetchImpl = fetch,
  now = new Date(),
  limit = 60,
  // A model that shipped seven weeks ago and is still the most-liked thing
  // on the Hub is news this dashboard should carry — Kimi-K3 (57 days,
  // 10.4k likes) and GLM-5.2 (54 days, 4.9k) were both being dropped by a
  // 30-day cutoff. The page's own recency filter then decides visibility,
  // against the model's real publication date.
  maxAgeDays = 120,
  minLikes = 20,
  // Trending is full of community quants and fine-tunes of the week's hit
  // model ("...-GGUF", "...-Uncensored-v7"), which are downstream of the news
  // rather than the news. A lab's own upload clears `minLikes`; anyone else's
  // has to be a genuine phenomenon to make the page.
  minLikesUnknownOrg = 300,
  timeoutMs = 10000,
} = {}) {
  const url = `${API_URL}?sort=trendingScore&direction=-1&limit=${limit}`;

  let payload;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    payload = await res.json();
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const cutoff = now.getTime() - maxAgeDays * 24 * 3600 * 1000;
  const items = [];

  for (const model of payload) {
    if (!model?.id || typeof model.id !== 'string' || !model.id.includes('/')) continue;
    const [org, name] = model.id.split('/');
    const known = KNOWN_ORGS[org];

    // Trending is dominated by long-lived favourites; without an age cutoff a
    // model from months ago would keep reappearing as today's news.
    const publishedAt = Date.parse(model.createdAt ?? '');
    if (!Number.isFinite(publishedAt) || publishedAt < cutoff) continue;
    const floor = known ? minLikes : Math.max(minLikes, minLikesUnknownOrg);
    if (Number.isFinite(model.likes) && model.likes < floor) continue;

    const item = {
      id: `hf-${model.id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`,
      sourceType: 'hf',
      source: known ?? `Hugging Face: ${org}`,
      publisherType: known ? 'company' : 'community',
      category: categoryFor(model.pipeline_tag),
      // No shared boilerplate in the title. "<id> released on Hugging Face"
      // gave every model the tokens "released/hugging/face", which pushed
      // short-id models over dedup's Jaccard threshold and — through
      // union-find transitivity — collapsed the entire day's releases into
      // one story. Model name plus org is distinctive per release, and still
      // overlaps enough to merge with press coverage of the same launch.
      title: `${name} — ${known ?? org}`,
      url: `https://huggingface.co/${model.id}`,
      summary: summarize(model, known ?? org),
      publishedAt: new Date(publishedAt).toISOString(),
      collectedAt: now.toISOString(),
      reactions: {
        likes: Number.isFinite(model.likes) ? model.likes : 0,
        downloads: Number.isFinite(model.downloads) ? model.downloads : 0,
      },
    };

    try {
      assertValidSourceItem(item);
    } catch {
      continue;
    }
    items.push(item);
  }

  return items;
}
