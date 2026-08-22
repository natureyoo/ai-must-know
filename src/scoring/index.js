// Computes the four independent 0-100 scores (Viral, Publisher influence,
// Credibility, Industry impact) plus a derived Must-know score for each
// Story (src/processing/dedup.js), each with a human-readable rationale.
//
// Core principle (do not collapse): influence and credibility are computed
// from disjoint inputs. Publisher influence never looks at verification
// status; credibility never looks at publisher influence or reach. A
// single hugely-influential company post is capped by
// VERIFICATION_CREDIBILITY_BASE['official-claim'] regardless of its
// influence score.

import { assessVerification } from '../verification/index.js';
import { storyActivityAt } from '../processing/dedup.js';

const HOUR_MS = 3600 * 1000;

const PUBLISHER_BASE_INFLUENCE = {
  government: 80,
  company: 75,
  'independent-media': 70,
  'research-org': 65,
  community: 35,
};

const CATEGORY_IMPACT_WEIGHT = {
  safety: 90,
  research: 85,
  models: 80,
  policy: 80,
  infrastructure: 70,
  funding: 65,
  'open-source': 60,
  business: 60,
  products: 55,
};

// Credibility is keyed entirely off the round_004 verification status, not
// re-derived here — this is deliberate so verification stays the single
// source of truth for "how well-corroborated is this."
const VERIFICATION_CREDIBILITY_BASE = {
  verified: 90,
  reported: 65,
  'official-claim': 45,
  disputed: 30,
  unverified: 20,
};

// Editorial stance: surface what insiders are talking about — viral signal
// leads, and a story anchored by a primary source (the org's own post,
// paper, or release) gets a flat bonus. Credibility stays a visible badge
// but no longer dominates the ranking (media coverage != importance).
const MUST_KNOW_WEIGHTS = { viral: 0.4, influence: 0.1, credibility: 0.2, impact: 0.3 };
export const PRIMARY_SOURCE_BONUS = 10;
const PRIMARY_PUBLISHER_TYPES = new Set(['company', 'research-org', 'government']);

// Deliberately small. The four scores answer "how big is this"; the recency
// window answers "is this from this week". Neither prefers today's news over
// Monday's *inside* the window, so the top of the page turned over slowly
// even when nothing was wrong with it. This tips ties toward the newer story
// without letting a thin item outrank a major release: at 8 points it moves
// a story past neighbours within ~8 points of it, no further.
//
// Decays to zero over 7 days and stays zero after, so it reshuffles the
// 최근 7일 tab and leaves the 30일/전체 기간 ordering as it was — those tabs
// are the "what was big" views and should not be re-sorted by clock.
export const RECENCY_BONUS = 8;
const RECENCY_DECAY_DAYS = 7;

function recencyBonus(activityAt, now) {
  const ageDays = (now.getTime() - activityAt) / (24 * HOUR_MS);
  return RECENCY_BONUS * clamp(1 - ageDays / RECENCY_DECAY_DAYS, 0, 1);
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

// Floor of 24h: collection runs once a day, so anything younger is measured
// as if a day old. The old 0.5h floor turned a 3-point HN thread found 36
// minutes after posting into "5/hr" — the 92nd percentile — and put it in
// the top ten above 700-point releases. This stands in for a real
// growth-rate signal: without repeated collection snapshots we can't observe
// an actual delta, so total-reactions-over-age is the best available proxy
// for "how fast is this accumulating" — an old post with many stale
// reactions gets a low rate, a new fast-rising one gets a high rate.
//
// ponytail: single-snapshot rate proxy, not a real time-series growth
// rate — upgrade to delta-between-collections once collect.js runs on a
// schedule and stores historical reaction counts.
function ageHours(item, now) {
  return Math.max(24, (now.getTime() - Date.parse(item.publishedAt)) / HOUR_MS);
}

function reactionMagnitude(item) {
  return Object.values(item.reactions).reduce((sum, v) => sum + v, 0);
}

function hourlyRate(item, now) {
  return reactionMagnitude(item) / ageHours(item, now);
}

function describeReactions(item) {
  const entries = Object.entries(item.reactions);
  if (entries.length === 0) return 'no reaction data';
  return entries.map(([k, v]) => `${v} ${k}`).join(', ');
}

// Korean labels for the rationale strings below. Rationales are generated
// from templates (not from source text), so both languages are produced here
// rather than sent through src/translate — the dashboard defaults to Korean
// and "왜 이 점수인가"는 번역 실패와 무관하게 항상 읽혀야 한다.
const REACTION_LABELS_KO = {
  points: '포인트',
  comments: '댓글',
  stars: '스타',
  forks: '포크',
  estimatedReads: '예상 조회',
};
const PUBLISHER_TYPE_KO = {
  government: '정부',
  company: '기업',
  'independent-media': '독립 언론',
  'research-org': '연구기관',
  community: '커뮤니티',
};
const CATEGORY_KO = {
  safety: '안전',
  research: '연구',
  models: '모델',
  policy: '정책·규제',
  infrastructure: '인프라',
  funding: '투자',
  'open-source': '오픈소스',
  business: '산업',
  products: '제품',
};

function describeReactionsKo(item) {
  const entries = Object.entries(item.reactions);
  if (entries.length === 0) return '반응 데이터 없음';
  return entries.map(([k, v]) => `${REACTION_LABELS_KO[k] ?? k} ${v}`).join(', ');
}

// Percentile rank of `value` within `pool` (0-100). A pool of 0-1 items
// has nothing to rank against, so it gets a neutral 50 rather than a
// false 100 (best-of-one is not evidence of virality).
function percentileRank(value, pool) {
  if (pool.length <= 1) return 50;
  let less = 0;
  let equal = 0;
  for (const v of pool) {
    if (v < value) less++;
    else if (v === value) equal++;
  }
  return ((less + equal / 2) / pool.length) * 100;
}

function computeViralScore(items, now, ratesByPlatform) {
  const platforms = new Set(items.map((i) => i.sourceType));
  const perItem = items.map((item) => {
    const rate = hourlyRate(item, now);
    const pct = percentileRank(rate, ratesByPlatform.get(item.sourceType));
    return { item, rate, pct };
  });
  const best = perItem.reduce((a, b) => (b.pct > a.pct ? b : a));
  const extraPlatforms = platforms.size - 1;
  const crossPlatformBonus = Math.min(20, extraPlatforms * 8);
  const value = clamp(best.pct + crossPlatformBonus);

  const rationale =
    `${Math.round(best.pct)}th percentile hourly engagement rate on ${best.item.sourceType} ` +
    `(${describeReactions(best.item)}, ${best.rate.toFixed(1)}/hr since publish ${ageHours(best.item, now).toFixed(1)}h ago)` +
    (extraPlatforms > 0
      ? `, +${crossPlatformBonus} cross-platform bonus for appearing on ${platforms.size} platforms (${[...platforms].join(', ')}).`
      : `.`);

  const rationaleKo =
    `${best.item.sourceType} 내 시간당 반응 증가율 백분위 ${Math.round(best.pct)} ` +
    `(${describeReactionsKo(best.item)}, 게시 ${ageHours(best.item, now).toFixed(1)}시간 경과·시간당 ${best.rate.toFixed(1)})` +
    (extraPlatforms > 0
      ? `, 플랫폼 ${platforms.size}곳(${[...platforms].join(', ')})에 동시 등장해 +${crossPlatformBonus}.`
      : `.`);

  return { value: Math.round(value), rationale, rationaleKo };
}

function computePublisherInfluence(items) {
  const perItem = items.map((item) => {
    const base = PUBLISHER_BASE_INFLUENCE[item.publisherType];
    const reach = item.reactions.estimatedReads ?? item.reactions.stars ?? null;
    const reachLabel = item.reactions.estimatedReads != null ? 'estimated reads' : 'GitHub stars';
    const bonus = reach != null ? clamp(Math.log10(reach + 1) * 6 - 20, -15, 15) : 0;
    return { item, score: clamp(base + bonus), base, reach, reachLabel };
  });
  const best = perItem.reduce((a, b) => (b.score > a.score ? b : a));

  const rationale =
    `"${best.item.source}" is a ${best.item.publisherType} publisher (base ${best.base}/100 institutional reach)` +
    (best.reach != null ? `, adjusted by ${best.reach.toLocaleString()} ${best.reachLabel}.` : '.');

  const reachLabelKo = best.reachLabel === 'estimated reads' ? '예상 조회수' : 'GitHub 스타';
  const rationaleKo =
    `"${best.item.source}"는 ${PUBLISHER_TYPE_KO[best.item.publisherType] ?? best.item.publisherType} 발행처로 ` +
    `기관 영향력 기본 ${best.base}/100` +
    (best.reach != null ? `, ${reachLabelKo} ${best.reach.toLocaleString()}회를 반영해 조정.` : '.');

  return { value: Math.round(best.score), rationale, rationaleKo };
}

function computeCredibilityScore(verification) {
  const base = VERIFICATION_CREDIBILITY_BASE[verification.status];
  const bonus =
    verification.status === 'verified' ? clamp((verification.independentSourceCount - 2) * 3, 0, 10) : 0;
  const value = clamp(base + bonus);

  const rationale = `${verification.statusLabel} status (${verification.independentSourceCount} independent source${verification.independentSourceCount === 1 ? '' : 's'}) sets a base of ${base}/100 — ${verification.reasoning}`;

  const rationaleKo = `${verification.statusLabelKo} 상태(독립 출처 ${verification.independentSourceCount}곳)라 기본 ${base}/100 — ${verification.reasoningKo}`;

  return { value: Math.round(value), rationale, rationaleKo };
}

// Reach percentile is computed per item *within its own platform's
// magnitude pool* (same principle as computeViralScore) and the story
// takes its best-placed item — summing raw reaction counts across
// sourceTypes first would mix incompatible units (rss `estimatedReads` in
// the tens of thousands vs. hn `points` in the hundreds) and bias every
// rss-touching story upward regardless of true relative reach.
function computeIndustryImpact(items, magnitudeByPlatform) {
  const category = items.find((i) => i.category)?.category ?? null;
  const categoryWeight = category ? CATEGORY_IMPACT_WEIGHT[category] : 50;
  const perItemPct = items.map((item) => ({
    item,
    pct: percentileRank(reactionMagnitude(item), magnitudeByPlatform.get(item.sourceType)),
  }));
  const best = perItemPct.reduce((a, b) => (b.pct > a.pct ? b : a));
  const platformCount = new Set(items.map((i) => i.sourceType)).size;
  const coverageBonus = clamp((platformCount - 1) * 5, 0, 15);
  const value = clamp(categoryWeight * 0.5 + best.pct * 0.4 + coverageBonus);

  const rationale =
    `Category "${category ?? 'uncategorized'}" weighted ${categoryWeight}/100 for industry significance, ` +
    `${Math.round(best.pct)}th percentile total engagement vs. other ${best.item.sourceType} items (best of this story's ${items.length} item(s))` +
    (platformCount > 1 ? `, +${coverageBonus} for coverage across ${platformCount} platforms.` : '.');

  const rationaleKo =
    `"${category ? CATEGORY_KO[category] ?? category : '미분류'}" 카테고리의 산업 중요도 가중치 ${categoryWeight}/100, ` +
    `동일 플랫폼(${best.item.sourceType}) 대비 총 반응 백분위 ${Math.round(best.pct)}(이 스토리의 ${items.length}개 항목 중 최고)` +
    (platformCount > 1 ? `, 플랫폼 ${platformCount}곳으로 확산돼 +${coverageBonus}.` : '.');

  return { value: Math.round(value), rationale, rationaleKo };
}

function computeMustKnowScore({ viral, influence, credibility, impact }, items = [], now = new Date()) {
  const hasPrimary = items.some((i) => PRIMARY_PUBLISHER_TYPES.has(i.publisherType));
  const bonus = hasPrimary ? PRIMARY_SOURCE_BONUS : 0;
  const fresh = items.length ? recencyBonus(storyActivityAt(items), now) : 0;
  const ageDays = items.length ? (now.getTime() - storyActivityAt(items)) / (24 * HOUR_MS) : 0;
  const value = clamp(
    viral.value * MUST_KNOW_WEIGHTS.viral +
      influence.value * MUST_KNOW_WEIGHTS.influence +
      credibility.value * MUST_KNOW_WEIGHTS.credibility +
      impact.value * MUST_KNOW_WEIGHTS.impact +
      bonus +
      fresh,
  );

  const rationale =
    `Weighted blend: viral ${viral.value}×${MUST_KNOW_WEIGHTS.viral} + influence ${influence.value}×${MUST_KNOW_WEIGHTS.influence} + ` +
    `credibility ${credibility.value}×${MUST_KNOW_WEIGHTS.credibility} + impact ${impact.value}×${MUST_KNOW_WEIGHTS.impact}` +
    (bonus ? ` + ${bonus} primary-source bonus (official post/paper/release present)` : '') +
    (fresh >= 0.5 ? ` + ${fresh.toFixed(1)} recency (last covered ${ageDays.toFixed(1)}d ago, decays to 0 at ${RECENCY_DECAY_DAYS}d)` : '') +
    ` = ${Math.round(value)}/100.`;

  const rationaleKo =
    `가중 합산: 화제성 ${viral.value}×${MUST_KNOW_WEIGHTS.viral} + 영향력 ${influence.value}×${MUST_KNOW_WEIGHTS.influence} + ` +
    `신뢰도 ${credibility.value}×${MUST_KNOW_WEIGHTS.credibility} + 중요도 ${impact.value}×${MUST_KNOW_WEIGHTS.impact}` +
    (bonus ? ` + 1차 출처 보너스 ${bonus}(공식 발표·논문·릴리스 있음)` : '') +
    (fresh >= 0.5 ? ` + 최신성 ${fresh.toFixed(1)}(마지막 보도 ${ageDays.toFixed(1)}일 전, ${RECENCY_DECAY_DAYS}일이면 0)` : '') +
    ` = ${Math.round(value)}/100.`;

  return { value: Math.round(value), rationale, rationaleKo };
}

function scoreStory(story, { now, ratesByPlatform, magnitudeByPlatform }) {
  const items = story.items;
  const verification = assessVerification(story);

  const viral = computeViralScore(items, now, ratesByPlatform);
  const influence = computePublisherInfluence(items);
  const credibility = computeCredibilityScore(verification);
  const impact = computeIndustryImpact(items, magnitudeByPlatform);
  const mustKnow = computeMustKnowScore({ viral, influence, credibility, impact }, items, now);

  return {
    storyId: story.id,
    title: story.title,
    verification,
    scores: { viral, influence, credibility, impact, mustKnow },
  };
}

// Scores every story in one batch, so viral's within-platform percentile
// and industry-impact's engagement percentile are computed against the
// real distribution of *this* batch rather than one story in isolation.
export function scoreStories(stories, { now = new Date() } = {}) {
  const ratesByPlatform = new Map();
  const magnitudeByPlatform = new Map();
  for (const item of stories.flatMap((s) => s.items)) {
    const rate = hourlyRate(item, now);
    if (!ratesByPlatform.has(item.sourceType)) ratesByPlatform.set(item.sourceType, []);
    ratesByPlatform.get(item.sourceType).push(rate);

    const magnitude = reactionMagnitude(item);
    if (!magnitudeByPlatform.has(item.sourceType)) magnitudeByPlatform.set(item.sourceType, []);
    magnitudeByPlatform.get(item.sourceType).push(magnitude);
  }

  return stories.map((story) => scoreStory(story, { now, ratesByPlatform, magnitudeByPlatform }));
}

export function scoreStoryStandalone(story, { now = new Date() } = {}) {
  return scoreStories([story], { now })[0];
}
