// Offline fallback adapter: hard-coded, realistic items conforming to the
// shared source-item contract (src/adapters/sourceItem.js), used whenever
// live RSS/HN/GitHub collection is unavailable or for local demoing.
//
// Deliberately includes:
//  - a same-URL duplicate (items 1 & 2 — a blog post also submitted to HN)
//  - similar-title/claim duplicates with different URLs (mistral-* pair,
//    and the 3-way eu-ai-act-* cluster)
//  - all 7 categories
//  - cross-platform overlaps (gpt-5-2 rss+hn same URL; agentkit github+hn
//    same URL)
//  - a mix of company press releases, government, research-org, and
//    independent-media reporting
//  - a cluster (eu-ai-act-*) with a government primary source plus two
//    genuinely independent outlets — the only cluster meant to clear a
//    strict ">=2 independent sources" Verified bar
//  - a structural Disputed pair (neomind-*): a company benchmark claim and
//    an independent report that it doesn't reproduce, about the same event
//  - an Unverified candidate (hn-jailbreak-claim-unverified): a lone
//    community claim with no primary source and nothing else to compare it
//    against
//
// Timestamps are stored as offsets (hoursAgo / collectedDelayHours) rather
// than fixed dates, so the data stays "fresh" no matter when the app runs.
// Pass `now` explicitly in tests for deterministic timestamps.

import { assertValidSourceItem } from '../sourceItem.js';

const FIXTURE_TEMPLATES = [
  {
    id: 'rss-openai-gpt5-2-launch',
    sourceType: 'rss',
    source: 'OpenAI Blog',
    publisherType: 'company',
    category: 'models',
    title: 'OpenAI Announces GPT-5.2 with 2M-Token Context Window',
    url: 'https://openai.com/index/gpt-5-2/',
    summary:
      'OpenAI says GPT-5.2 extends context to 2 million tokens and improves multi-step reasoning benchmarks over GPT-5.1. The model is rolling out to ChatGPT Plus and API users this week.',
    hoursAgo: 8,
    collectedDelayHours: 0.37,
    reactions: { shares: 1240, estimatedReads: 86000 },
  },
  {
    id: 'hn-openai-gpt5-2-submission',
    sourceType: 'hn',
    source: 'Hacker News',
    publisherType: 'community',
    category: 'models',
    title: 'OpenAI announces GPT-5.2, extends context window to 2M tokens',
    url: 'https://openai.com/index/gpt-5-2/',
    summary:
      "Hacker News submission of OpenAI's GPT-5.2 announcement; discussion focuses on real-world context-window reliability.",
    hoursAgo: 6,
    collectedDelayHours: 3,
    reactions: { points: 842, comments: 391 },
  },
  {
    id: 'rss-anthropic-feature-circuits-research',
    sourceType: 'rss',
    source: 'Anthropic',
    publisherType: 'company',
    category: 'research',
    title: 'Anthropic Publishes New Interpretability Research on Feature Circuits',
    url: 'https://www.anthropic.com/research/feature-circuits-2026',
    summary:
      'Anthropic researchers describe a technique for tracing feature circuits inside a production-scale model. The write-up reports only internal evaluations.',
    hoursAgo: 47,
    collectedDelayHours: 1.08,
    reactions: { shares: 210, estimatedReads: 15400 },
  },
  {
    id: 'rss-mit-tech-review-anthropic-coverage',
    sourceType: 'rss',
    source: 'MIT Technology Review',
    publisherType: 'independent-media',
    category: 'research',
    title: "Anthropic's Latest Interpretability Work Could Help Explain Model Behavior",
    url: 'https://www.technologyreview.com/2026/08/05/anthropic-feature-circuits/',
    summary:
      "MIT Technology Review covers Anthropic's new feature-circuit tracing technique and asks outside researchers whether the method generalizes beyond the models Anthropic tested.",
    hoursAgo: 37.5,
    collectedDelayHours: 1.5,
    reactions: { shares: 305, estimatedReads: 19800 },
  },
  {
    id: 'rss-mistral-series-c-official',
    sourceType: 'rss',
    source: 'Mistral AI',
    publisherType: 'company',
    category: 'funding',
    title: 'Mistral AI Raises $1.2B Series C Led by New Investors',
    url: 'https://mistral.ai/news/series-c-2026',
    summary:
      'Mistral AI says it closed a $1.2 billion Series C round to fund model training infrastructure and enterprise expansion.',
    hoursAgo: 72,
    collectedDelayHours: 0.5,
    reactions: { shares: 340, estimatedReads: 22000 },
  },
  {
    id: 'rss-techcrunch-mistral-funding-report',
    sourceType: 'rss',
    source: 'TechCrunch',
    publisherType: 'independent-media',
    category: 'funding',
    title: 'Mistral AI Raises $1.2 Billion in Series C Round',
    url: 'https://techcrunch.com/2026/08/04/mistral-ai-series-c-funding/',
    summary:
      "TechCrunch confirms Mistral AI's $1.2 billion Series C, reporting the same investor group and valuation figures cited in the company's own announcement.",
    hoursAgo: 68.75,
    collectedDelayHours: 0.75,
    reactions: { shares: 512, estimatedReads: 41000 },
  },
  {
    id: 'github-agentkit-trending',
    sourceType: 'github',
    source: 'GitHub Trending',
    publisherType: 'community',
    category: 'open-source',
    title: 'opensource-ai/agentkit — lightweight multi-agent orchestration framework',
    url: 'https://github.com/opensource-ai/agentkit',
    summary:
      'A permissively-licensed framework for coordinating multiple LLM agents with shared tool access, trending on GitHub after a v2 release.',
    hoursAgo: 220,
    collectedDelayHours: 194,
    reactions: { stars: 8342, forks: 612, openIssues: 47, starsGainedToday: 1204 },
  },
  {
    id: 'hn-agentkit-hn-discussion',
    sourceType: 'hn',
    source: 'Hacker News',
    publisherType: 'community',
    category: 'open-source',
    title: 'Agentkit v2 – lightweight multi-agent orchestration framework',
    url: 'https://github.com/opensource-ai/agentkit',
    summary:
      'Hacker News thread linking directly to the agentkit repository; commenters compare it to heavier agent frameworks.',
    hoursAgo: 10,
    collectedDelayHours: 4,
    reactions: { points: 264, comments: 97 },
  },
  {
    id: 'github-smolvlm3-trending',
    sourceType: 'github',
    source: 'GitHub Trending',
    publisherType: 'community',
    category: 'models',
    title: 'vision-labs/smolvlm3 — open-weight 3B-parameter vision-language model',
    url: 'https://github.com/vision-labs/smolvlm3',
    summary:
      'A small open-weight vision-language model release, trending after benchmark comparisons against larger closed models circulated online.',
    hoursAgo: 30,
    collectedDelayHours: 6,
    reactions: { stars: 3120, forks: 201, openIssues: 22, starsGainedToday: 890 },
  },
  {
    id: 'github-mcp-tools-trending',
    sourceType: 'github',
    source: 'GitHub Trending',
    publisherType: 'community',
    category: 'open-source',
    title: 'protocol-tools/mcp-server-kit — starter kit for Model Context Protocol servers',
    url: 'https://github.com/protocol-tools/mcp-server-kit',
    summary:
      'A toolkit for building Model Context Protocol servers, trending as more editors and agents adopt MCP for tool access.',
    hoursAgo: 55,
    collectedDelayHours: 8,
    reactions: { stars: 1980, forks: 143, openIssues: 15, starsGainedToday: 340 },
  },
  {
    id: 'rss-perplexity-comet-launch',
    sourceType: 'rss',
    source: 'Perplexity',
    publisherType: 'company',
    category: 'products',
    title: 'Perplexity Launches Comet, an AI-Native Browser Agent',
    url: 'https://www.perplexity.ai/comet-launch',
    summary:
      "Perplexity's new browser lets an agent navigate pages and complete multi-step tasks on the user's behalf, launching first to Max subscribers.",
    hoursAgo: 88,
    collectedDelayHours: 1,
    reactions: { shares: 190, estimatedReads: 9800 },
  },
  {
    id: 'rss-ec-eu-ai-act-guidance-official',
    sourceType: 'rss',
    source: 'European Commission',
    publisherType: 'government',
    category: 'policy',
    title: 'European Commission Publishes Enforcement Guidance for High-Risk AI Systems',
    url: 'https://digital-strategy.ec.europa.eu/en/news/ai-act-enforcement-guidance-2026',
    summary:
      'The European Commission publishes formal guidance clarifying compliance timelines and obligations for providers of high-risk AI systems under the AI Act.',
    hoursAgo: 122,
    collectedDelayHours: 1.5,
    reactions: { shares: 180, estimatedReads: 12000 },
  },
  {
    id: 'rss-reuters-eu-ai-act-guidance',
    sourceType: 'rss',
    source: 'Reuters',
    publisherType: 'independent-media',
    category: 'policy',
    title: 'EU Publishes Enforcement Guidance for High-Risk AI Systems Under AI Act',
    url: 'https://www.reuters.com/technology/eu-ai-act-guidance-2026-08-02/',
    summary:
      'Reuters reports that EU regulators issued long-awaited guidance clarifying compliance timelines for providers of high-risk AI systems.',
    hoursAgo: 120.5,
    collectedDelayHours: 1.5,
    reactions: { shares: 268, estimatedReads: 18700 },
  },
  {
    id: 'rss-ap-eu-ai-act-guidance',
    sourceType: 'rss',
    source: 'Associated Press',
    publisherType: 'independent-media',
    category: 'policy',
    title: 'EU issues enforcement guidance for high-risk AI systems',
    url: 'https://apnews.com/article/eu-ai-act-guidance-2026',
    summary:
      "AP's independent reporting corroborates the European Commission's guidance timelines, citing its own review of the published document.",
    hoursAgo: 119,
    collectedDelayHours: 2,
    reactions: { shares: 221, estimatedReads: 16200 },
  },
  {
    id: 'rss-metr-frontier-eval-report',
    sourceType: 'rss',
    source: 'METR',
    publisherType: 'research-org',
    category: 'safety',
    title: 'METR Releases Dangerous Capability Evaluation for a Frontier Model',
    url: 'https://metr.org/blog/2026-08-01-frontier-model-eval/',
    summary:
      "METR, an independent evaluator, publishes results from a pre-deployment dangerous-capability assessment conducted with a frontier lab's cooperation.",
    hoursAgo: 140,
    collectedDelayHours: 1.17,
    reactions: { shares: 402, estimatedReads: 27000 },
  },
  {
    id: 'hn-jailbreak-claim-unverified',
    sourceType: 'hn',
    source: 'Hacker News',
    publisherType: 'community',
    category: 'safety',
    title: 'Claim: new jailbreak reliably bypasses safety filters on a frontier model',
    url: 'https://news.ycombinator.com/item?id=42918823',
    summary:
      'A submitter claims to have found a reliable jailbreak; there is no primary source, no vendor response, and no independent write-up confirming or refuting it — just an unresolved community thread.',
    hoursAgo: 18,
    collectedDelayHours: 1,
    reactions: { points: 356, comments: 210 },
  },
  {
    id: 'fixture-batch-newsletter-safety-roundup',
    sourceType: 'fixture',
    source: 'The Batch (DeepLearning.AI)',
    publisherType: 'independent-media',
    category: 'safety',
    title: 'Weekly Roundup: Frontier Safety Evaluations Gain Traction',
    url: 'https://www.deeplearning.ai/the-batch/weekly-roundup-safety-evals-2026-08-07/',
    summary:
      "A weekly AI newsletter roundup mentions several labs' safety evaluation efforts, aggregating coverage rather than reporting original findings.",
    hoursAgo: 2,
    collectedDelayHours: 1,
    reactions: { shares: 88, estimatedReads: 6400 },
  },
  {
    id: 'rss-neomind-benchmark-claim',
    sourceType: 'rss',
    source: 'NeoMind AI',
    publisherType: 'company',
    category: 'models',
    title: 'NeoMind AI Claims New Model Beats GPT-5.2 on Reasoning Benchmark',
    url: 'https://neomind.ai/blog/model-v3-benchmark-2026',
    summary:
      "NeoMind AI says its internally-run benchmark shows Model v3 scoring higher than GPT-5.2 on a standard reasoning suite. No third party has yet run the same test.",
    hoursAgo: 14,
    collectedDelayHours: 0.6,
    reactions: { shares: 150, estimatedReads: 8000 },
  },
  {
    id: 'hn-neomind-benchmark-disputed',
    sourceType: 'hn',
    source: 'Hacker News',
    publisherType: 'community',
    category: 'models',
    title: "NeoMind's New Model Benchmark Claims Against GPT-5.2 Don't Reproduce, Testers Say",
    url: 'https://news.ycombinator.com/item?id=42921004',
    summary:
      "Commenters who re-ran NeoMind's published benchmark report scores well below what NeoMind's blog post claims, and question the eval's methodology.",
    hoursAgo: 9,
    collectedDelayHours: 5,
    reactions: { points: 512, comments: 288 },
  },
  // Offline coverage for the two categories added after the original seven,
  // so the fixture set still exercises every filter chip with no network.
  {
    id: 'rss-nvidia-rubin-datacenter',
    sourceType: 'rss',
    source: 'NVIDIA Newsroom',
    publisherType: 'company',
    category: 'infrastructure',
    title: 'NVIDIA Ships Rubin-Class Racks to First Datacenter Customers',
    url: 'https://nvidianews.nvidia.com/news/rubin-rack-shipping/',
    summary:
      'NVIDIA says the first Rubin-class racks have shipped, with the company quoting 1.7x inference throughput per watt over the previous generation. Independent measurements are not yet available.',
    hoursAgo: 14,
    collectedDelayHours: 0.4,
    reactions: { shares: 610, estimatedReads: 41000 },
  },
  {
    id: 'rss-anthropic-api-price-cut',
    sourceType: 'rss',
    source: 'TechCrunch',
    publisherType: 'independent-media',
    category: 'business',
    title: 'Anthropic Cuts Batch API Pricing by 40% as Inference Competition Intensifies',
    url: 'https://techcrunch.com/2026/anthropic-batch-pricing/',
    summary:
      'Anthropic has cut batch API prices by 40%, the third price move among frontier vendors this quarter. Analysts read it as margin pressure from cheaper open-weight serving rather than a cost breakthrough.',
    hoursAgo: 20,
    collectedDelayHours: 0.5,
    reactions: { shares: 480, estimatedReads: 33000 },
  },
];

function buildItem(template, now) {
  const publishedAt = new Date(now.getTime() - template.hoursAgo * 3600 * 1000);
  const collectedAt = new Date(publishedAt.getTime() + template.collectedDelayHours * 3600 * 1000);
  const { hoursAgo, collectedDelayHours, reactions, ...rest } = template;
  return {
    ...rest,
    publishedAt: publishedAt.toISOString(),
    collectedAt: collectedAt.toISOString(),
    reactions: { ...reactions },
  };
}

// Returns a fresh array built relative to `now` (defaults to the real
// current time), so the data reads as "recent" no matter when it runs.
// Pass `now` explicitly for deterministic tests.
export function getFixtureItems({ now = new Date() } = {}) {
  const items = FIXTURE_TEMPLATES.map((template) => buildItem(template, now));
  for (const item of items) assertValidSourceItem(item);
  return items;
}
