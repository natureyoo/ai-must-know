// Assigns one of five verification states to a Story (src/processing/dedup.js)
// based on its constituent SourceItems' publisherType and content agreement.
//
// Key rule (item 13): a `company`-published item is primary evidence only
// that the company made the announcement — it never counts toward the
// "independent" tally, no matter how many company items exist or how many
// platforms repost the same company URL.
//
// Key rule (item 14): "Verified" requires >=2 independent sources. Items
// that share a URL are the same document being redistributed (e.g. an HN
// submission linking to a company's own blog post), not separate
// corroboration, so they're grouped into one "origin" before counting.

export const VERIFICATION_STATUSES = ['verified', 'official-claim', 'reported', 'disputed', 'unverified'];

export const VERIFICATION_STATUS_LABELS = {
  verified: 'Verified',
  'official-claim': 'Official claim',
  reported: 'Reported',
  disputed: 'Disputed',
  unverified: 'Unverified',
};

// The dashboard defaults to Korean, so every judgement it renders needs a
// Korean rendering too. These are template-generated (unlike story text,
// which comes from sources and goes through src/translate), so they're
// written here in both languages rather than sent to a translation API.
export const VERIFICATION_STATUS_LABELS_KO = {
  verified: '검증됨',
  'official-claim': '공식 발표',
  reported: '보도됨',
  disputed: '반박 있음',
  unverified: '미확인',
};

// Institutional/professional publisher types whose independent reporting is
// credible on its own. `community` (forum posts, HN threads) is real
// evidence but not "reporting" — a lone community claim stays Unverified
// per item 12's definition, matching the fixture's jailbreak-claim case.
//
// ponytail: `government` counts toward the credible-independent tally even
// when it's the self-announcing party (e.g. a regulator announcing its own
// guidance) — unlike `company`, item 13 doesn't single it out. That means a
// government self-announcement plus exactly one outside outlet could reach
// Verified; two distinct publishers is still more than "a single influential
// source," so this is left as-is rather than special-cased for a scenario
// no fixture exercises.
const CREDIBLE_INDEPENDENT_TYPES = ['independent-media', 'research-org', 'government'];

// ponytail: lexical conflict markers, not semantic claim comparison —
// upgrade to real NLP claim-diffing if fixture-scale phrasing stops catching
// real disputes (mirrors the same tradeoff dedup.js makes for title similarity).
const DISPUTE_PATTERN =
  /\bdisputed?\b|\bdon'?t reproduce\b|\bdoesn'?t reproduce\b|\bfails? to reproduce\b|\bunable to reproduce\b|\bcan'?t (?:verify|reproduce)\b|\bdenies?\b|\brefutes?\b|\bcontradicts?\b/i;

function normalizeUrl(url) {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

function groupByOrigin(items) {
  const groups = new Map();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

function isCompanyOrigin(originItems) {
  return originItems.some((it) => it.publisherType === 'company');
}

function isCredibleIndependentOrigin(originItems) {
  return !isCompanyOrigin(originItems) && originItems.some((it) => CREDIBLE_INDEPENDENT_TYPES.includes(it.publisherType));
}

function originNames(origins) {
  return [...new Set(origins.flatMap((o) => o.map((it) => it.source)))].join(', ');
}

// Independence is about distinct *publishers*, not distinct URLs or item
// counts. One origin = one voice, even if it contains multiple items (e.g.
// a Reuters article plus an HN submission of that same URL) — only the
// credible-typed item's source names the voice, so the HN repost inside
// that origin doesn't add a second name. Same-publisher origins (two
// different articles from the same outlet) also collapse via the Set.
function independentSourceNames(credibleOrigins) {
  return new Set(
    credibleOrigins.map((o) => o.find((it) => CREDIBLE_INDEPENDENT_TYPES.includes(it.publisherType)).source),
  );
}

function originKeyForItem(origins, item) {
  return origins.findIndex((o) => o.includes(item));
}

// A dispute requires two items from *different* origins that disagree — a
// lone item can't conflict with itself.
function findDisputePair(items, origins) {
  const disputer = items.find((it) => DISPUTE_PATTERN.test(`${it.title} ${it.summary}`));
  if (!disputer) return null;
  const disputerOrigin = originKeyForItem(origins, disputer);
  const original = items.find((it) => originKeyForItem(origins, it) !== disputerOrigin);
  if (!original) return null;
  return { disputer, original };
}

export function assessVerification(story) {
  const items = story.items;
  const origins = groupByOrigin(items);
  const companyOrigins = origins.filter(isCompanyOrigin);
  const credibleIndependentOrigins = origins.filter(isCredibleIndependentOrigin);
  const independentNames = independentSourceNames(credibleIndependentOrigins);
  const independentSourceCount = independentNames.size;
  const independentNamesLabel = [...independentNames].join(', ');

  const evidence = items.map((it) => ({
    url: it.url,
    source: it.source,
    sourceType: it.sourceType,
    publisherType: it.publisherType,
    publishedAt: it.publishedAt,
  }));

  const dispute = findDisputePair(items, origins);
  let status;
  let reasoning;
  let reasoningKo;

  if (dispute) {
    status = 'disputed';
    reasoning =
      `Disputed: "${dispute.disputer.source}" reports content that conflicts with "${dispute.original.source}"'s account ` +
      `of the same story, so this cannot be marked Verified or Official claim until the conflict resolves.`;
    reasoningKo =
      `반박 있음: "${dispute.disputer.source}"의 보도가 같은 사안에 대한 "${dispute.original.source}"의 설명과 충돌합니다. ` +
      `충돌이 해소되기 전까지 검증됨·공식 발표로 분류하지 않습니다.`;
  } else if (independentSourceCount >= 2) {
    status = 'verified';
    reasoning =
      `Verified: ${independentSourceCount} independent, non-company sources ` +
      `(${independentNamesLabel}) corroborate this` +
      (companyOrigins.length > 0 ? `, beyond the original announcement from ${originNames(companyOrigins)}.` : '.');
    reasoningKo =
      `검증됨: 당사자가 아닌 독립 출처 ${independentSourceCount}곳(${independentNamesLabel})이 같은 내용을 뒷받침합니다` +
      (companyOrigins.length > 0 ? ` (${originNames(companyOrigins)}의 원 발표와는 별개).` : '.');
  } else if (independentSourceCount === 1) {
    status = 'reported';
    reasoning =
      `Reported: credible independent coverage exists (${independentNamesLabel}), but only 1 independent ` +
      `source corroborates this — short of the 2 required for Verified, so primary evidence is still insufficient.`;
    reasoningKo =
      `보도됨: 신뢰할 만한 독립 보도(${independentNamesLabel})가 있지만 독립 출처가 1곳뿐입니다. ` +
      `검증됨에 필요한 2곳에 못 미쳐 1차 근거가 아직 부족합니다.`;
  } else if (companyOrigins.length > 0) {
    status = 'official-claim';
    reasoning =
      `Official claim: only the announcing part${companyOrigins.length > 1 ? 'ies' : 'y'} ` +
      `(${originNames(companyOrigins)}) ${companyOrigins.length > 1 ? 'have' : 'has'} published this. A company's own ` +
      `announcement is primary evidence that it was made, not that its claims are independently verified — no independent ` +
      `source corroborates it yet.`;
    reasoningKo =
      `공식 발표: 당사자(${originNames(companyOrigins)})만 이 내용을 발표했습니다. 기업의 자체 발표는 ` +
      `"그런 발표가 있었다"는 사실의 1차 근거일 뿐, 발표 안의 주장이 독립적으로 검증됐다는 뜻은 아닙니다. ` +
      `아직 이를 뒷받침하는 독립 출처가 없습니다.`;
  } else {
    status = 'unverified';
    reasoning =
      `Unverified: only community-sourced or unconfirmed material (${originNames(origins)}) exists — no official primary ` +
      `source and no credible independent reporting corroborates this yet.`;
    reasoningKo =
      `미확인: 커뮤니티 발신이거나 확인되지 않은 자료(${originNames(origins)})뿐입니다. ` +
      `공식 1차 출처도, 신뢰할 만한 독립 보도도 아직 없습니다.`;
  }

  return {
    status,
    statusLabel: VERIFICATION_STATUS_LABELS[status],
    statusLabelKo: VERIFICATION_STATUS_LABELS_KO[status],
    reasoning,
    reasoningKo,
    evidence,
    independentSourceCount,
  };
}

export function attachVerification(story) {
  return { ...story, verification: assessVerification(story) };
}
