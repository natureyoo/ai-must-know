// Dashboard frontend. Fetches real data from the /api/stories and
// /api/stories/:id endpoints — no hardcoded story data lives in this file.
// Routing is hash-based so the story detail view never needs a server-side
// route beyond the static files themselves.
//
// Korean is the default language: story text comes pre-translated from the
// API (src/translate) and everything else is rendered from the STRINGS table
// below. Every localized read goes through logic.js's `localized()`, which
// falls back to the English original when a translation is missing.

import { topStories, localized, localizedRationale, cardLead, cardBrief, withinDays, relativeAge, isStale } from './logic.js';

const CATEGORIES = ['research', 'models', 'products', 'open-source', 'policy', 'funding', 'safety'];
const PLATFORM_LABELS = { rss: 'RSS', hn: 'Hacker News', github: 'GitHub', hf: 'Hugging Face', fixture: 'Fixture' };

// One ranking, spelled out. The API still accepts ?sort=viral|credibility|
// impact|recent (src/server), but four opaque sort options on screen raised
// "what is this sorted by?" more often than they answered it — so the page
// shows the Must Know order and states the weights behind it instead.
const SORT = 'mustknow';

const STRINGS = {
  ko: {
    all: '전체',
    homeTitle: '오늘의 Must Know',
    homeTitleFiltered: (cat) => `${cat} — Must Know`,
    loading: '불러오는 중...',
    storyCount: (n, period) => `${n}개 스토리 · ${period} · Must Know 점수 순 = 화제성 40% + 산업 중요도 30% + 신뢰도 20% + 발행처 영향력 10% (+1차 출처 보너스)`,
    periodChip: (days) => (days ? `최근 ${days}일` : '전체 기간'),
    periodNote: (days) => (days ? `최근 ${days}일 발행` : '전체 기간'),
    emptyRecent: '이 기간에 발행된 스토리가 없습니다. 기간을 넓혀보세요.',
    empty: '이 필터에 해당하는 스토리가 없습니다.',
    loadFailed: (msg) => `데이터를 불러오지 못했습니다: ${msg}`,
    notFound: '해당 스토리를 찾을 수 없습니다.',
    back: '← 홈으로',
    asOf: (stamp, ago) => `데이터 기준 ${stamp} · ${ago}`,
    asOfStale: '갱신 지연',
    asOfSchedule: '매일 오전 5시(KST) 자동 갱신',
    source: '원문',
    evidence: '근거',
    briefToggle: '원문 요약',
    takeToggle: 'AI 관점 · 왜 중요한가',
    takeDisclaimer: '이 항목은 원문을 바탕으로 AI가 작성한 해석입니다. 사실 확인은 원문·근거 링크를 확인하세요.',
    published: (date, ago) => `발행 ${date} · ${ago}`,
    whyScore: '점수 산출 근거 보기',
    whyVerification: '검증 판단 이유',
    independentSources: (n) => `독립 출처 ${n}개`,
    timeline: '타임라인',
    reactions: '플랫폼별 반응',
    sources: '관련 출처 · 근거',
    noReactionData: '반응 데이터 없음',
    untranslated: '원문(영어)',
    footerPre: '모든 요약과 점수는 ',
    footerPost: ' 가 반환하는 실데이터를 기반으로 렌더링됩니다.',
    langToggle: 'EN',
    scoreLabels: {
      mustKnow: 'Must Know',
      viral: '화제성',
      influence: '발행처 영향력',
      credibility: '신뢰도',
      impact: '산업 중요도',
    },
    categories: {
      research: '연구',
      models: '모델',
      products: '제품',
      'open-source': '오픈소스',
      policy: '정책',
      funding: '투자',
      safety: '안전',
    },
  },
  en: {
    all: 'All',
    homeTitle: "Today's Must Know",
    homeTitleFiltered: (cat) => `${cat} — Must Know`,
    loading: 'Loading...',
    storyCount: (n, period) => `${n} stories · ${period} · ranked by Must Know = viral 40% + industry impact 30% + credibility 20% + publisher influence 10% (+primary-source bonus)`,
    periodChip: (days) => (days ? `Last ${days} days` : 'All time'),
    periodNote: (days) => (days ? `published in the last ${days} days` : 'all time'),
    emptyRecent: 'Nothing was published in this window. Try a wider one.',
    empty: 'No stories match this filter.',
    loadFailed: (msg) => `Could not load data: ${msg}`,
    notFound: 'Story not found.',
    back: '← Back',
    asOf: (stamp, ago) => `Data as of ${stamp} · ${ago}`,
    asOfStale: 'update overdue',
    asOfSchedule: 'refreshed daily at 05:00 KST',
    source: 'Original',
    evidence: 'Evidence',
    briefToggle: 'Summary',
    takeToggle: 'AI take · why it matters',
    takeDisclaimer: 'Written by AI from the original. Check the source and evidence links before relying on it.',
    published: (date, ago) => `Published ${date} · ${ago}`,
    whyScore: 'Why these scores?',
    whyVerification: 'Why this verification status?',
    independentSources: (n) => `${n} independent source${n === 1 ? '' : 's'}`,
    timeline: 'Timeline',
    reactions: 'Reactions by platform',
    sources: 'Sources & evidence',
    noReactionData: 'no reaction data',
    untranslated: 'original (EN)',
    footerPre: 'Every summary and score is rendered from live data returned by ',
    footerPost: '.',
    langToggle: '한국어',
    scoreLabels: {
      mustKnow: 'Must Know',
      viral: 'Viral',
      influence: 'Publisher influence',
      credibility: 'Credibility',
      impact: 'Industry impact',
    },
    categories: {
      research: 'Research',
      models: 'Models',
      products: 'Products',
      'open-source': 'Open Source',
      policy: 'Policy',
      funding: 'Funding',
      safety: 'Safety',
    },
  },
};

// Item 16 asks for today's top 5 as cards; those are always the first five
// here. The grid shows more below them so the ranking is inspectable at a
// glance rather than needing a sort/filter round-trip per story.
const TOP_N = 24;

// The window defaults to 7 days: the viral score keeps well-engaged older
// stories near the top, which is right for ranking and wrong for a page
// titled "오늘의 Must Know". 30 days is offered because a Hugging Face model
// dates from when its repo was created, which is often weeks before it
// trends — narrowing to 7 days hides most open-weight releases. Widening the
// window is honest; back-dating them to "today" would not be.
const PERIODS = [7, 30, 0];
const state = { category: '', days: 7, lang: localStorage.getItem('lang') || 'ko', dataAsOf: null };

const t = () => STRINGS[state.lang];

const homeView = document.getElementById('home-view');
const detailView = document.getElementById('detail-view');
const cardGrid = document.getElementById('card-grid');
const homeStatus = document.getElementById('home-status');
const homeTitle = document.getElementById('home-title');
const chipsContainer = document.getElementById('category-chips');
const periodChips = document.getElementById('period-chips');
const asOfEl = document.getElementById('data-asof');
const footerNote = document.getElementById('footer-note');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(state.lang === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// The as-of stamp is always shown in KST regardless of the viewer's clock:
// the collection schedule is defined in KST, so a stamp in some other zone
// would not line up with "매일 오전 5시 갱신".
function formatKst(iso) {
  return new Date(iso).toLocaleString(state.lang === 'ko' ? 'ko-KR' : 'en-US', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' KST';
}

// When the story broke, in KST like the as-of stamp, plus how long ago —
// "8월 8일" alone does not tell a reader whether that is old news.
function publishedLine(iso) {
  const date = new Date(iso).toLocaleDateString(state.lang === 'ko' ? 'ko-KR' : 'en-US', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
  });
  return t().published(date, relativeAge(iso, new Date(), state.lang));
}

function categoryLabel(category) {
  return t().categories[category] || category || 'uncategorized';
}

function badgeClass(status) {
  return `badge badge-${status}`;
}

function renderAsOf() {
  if (!state.dataAsOf) {
    asOfEl.textContent = '';
    return;
  }
  const stale = isStale(state.dataAsOf);
  asOfEl.className = `data-asof${stale ? ' stale' : ''}`;
  asOfEl.innerHTML =
    `<span>${escapeHtml(t().asOf(formatKst(state.dataAsOf), relativeAge(state.dataAsOf, new Date(), state.lang)))}</span>` +
    `<span class="asof-note">${escapeHtml(stale ? t().asOfStale : t().asOfSchedule)}</span>`;
}

// Compact score strip: the four axes as labelled numbers, with the full
// rationale for all five kept one click away (item 11) instead of stacked on
// the card, so a card can be read at a glance.
function scorePills(scores) {
  const labels = t().scoreLabels;
  return ['viral', 'influence', 'credibility', 'impact']
    .map((key) => `<span class="pill"><span class="pill-label">${escapeHtml(labels[key])}</span><span class="pill-value">${scores[key].value}</span></span>`)
    .join('');
}

function rationaleList(scores) {
  const labels = t().scoreLabels;
  return ['mustKnow', 'viral', 'influence', 'credibility', 'impact']
    .map((key) => `<li><b>${escapeHtml(labels[key])} ${scores[key].value}</b> — ${escapeHtml(localizedRationale(scores[key], state.lang))}</li>`)
    .join('');
}

// One toggle per card. It carries the AI take when there is one — that is
// the only thing on the card the reader cannot get from the headline — and
// falls back to the original's summary otherwise (English mode, or a story
// collected before takes existed).
function takeOrBrief(view, brief) {
  const take = state.lang === 'ko' ? view.takeKo : null;
  if (take) {
    return `<details class="rationale card-take"><summary>${escapeHtml(t().takeToggle)}</summary><p>${escapeHtml(take)}</p><p class="take-note">${escapeHtml(t().takeDisclaimer)}</p></details>`;
  }
  if (!brief) return '';
  return `<details class="rationale card-brief"><summary>${escapeHtml(t().briefToggle)}</summary><p>${escapeHtml(brief)}</p></details>`;
}

function renderCard(view) {
  const s = view.scores;
  const text = localized(view, state.lang);
  const lead = cardLead(text);
  const brief = cardBrief(text);
  const platforms = view.platforms.map((p) => `<span class="platform-tag">${PLATFORM_LABELS[p] || p}</span>`).join('');
  const primary = view.sources[0];
  const evidenceLinks = view.sources
    .slice(0, 3)
    .map((src) => `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(src.source)}</a>`)
    .join(' · ');

  return `
    <article class="card">
      <div class="card-head">
        <div class="meta-row">
          <span class="${badgeClass(view.verification.status)}">${escapeHtml(text.verificationLabel)}</span>
          <span class="platform-tag tag-category">${escapeHtml(categoryLabel(view.category))}</span>
          ${platforms}
          ${text.translated ? '' : `<span class="platform-tag tag-untranslated">${escapeHtml(t().untranslated)}</span>`}
        </div>
        <div class="mustknow-badge" title="${escapeHtml(t().scoreLabels.mustKnow)}">
          <span class="mustknow-value">${s.mustKnow.value}</span>
          <span class="mustknow-caption">Must Know</span>
        </div>
      </div>
      <h2 class="card-title"><a href="#/story/${encodeURIComponent(view.id)}">${escapeHtml(text.title)}</a></h2>
      <p class="card-date">${escapeHtml(publishedLine(view.firstPublishedAt))}</p>
      ${lead ? `<p class="card-gist">${escapeHtml(lead)}</p>` : ''}
      ${takeOrBrief(view, brief)}
      <div class="score-pills">${scorePills(s)}</div>
      <details class="rationale">
        <summary>${escapeHtml(t().whyVerification)}</summary>
        <p>${escapeHtml(text.verificationReason)}</p>
      </details>
      <details class="rationale">
        <summary>${escapeHtml(t().whyScore)}</summary>
        <ul class="rationale-list">${rationaleList(s)}</ul>
      </details>
      <div class="card-links">
        <a href="${escapeHtml(primary.url)}" target="_blank" rel="noopener">${escapeHtml(t().source)}</a>
        <span>${escapeHtml(t().evidence)}: ${evidenceLinks}</span>
      </div>
    </article>
  `;
}

async function fetchStories() {
  const params = new URLSearchParams({ sort: SORT });
  if (state.category) params.set('category', state.category);
  const res = await fetch(`/api/stories?${params}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function renderHome() {
  detailView.hidden = true;
  homeView.hidden = false;
  homeStatus.textContent = t().loading;
  cardGrid.innerHTML = '';

  try {
    const body = await fetchStories();
    state.dataAsOf = body.dataAsOf ?? state.dataAsOf;
    renderAsOf();
    const inWindow = withinDays(body.stories, state.days);
    const top = topStories(inWindow, TOP_N);
    homeTitle.textContent = state.category ? t().homeTitleFiltered(categoryLabel(state.category)) : t().homeTitle;
    if (top.length === 0) {
      homeStatus.textContent = '';
      const message = state.days && body.stories.length > 0 ? t().emptyRecent : t().empty;
      cardGrid.innerHTML = `<div class="empty-box">${escapeHtml(message)}</div>`;
      return;
    }
    homeStatus.textContent = t().storyCount(top.length, t().periodNote(state.days));
    cardGrid.innerHTML = top.map(renderCard).join('');
  } catch (err) {
    homeStatus.textContent = '';
    cardGrid.innerHTML = `<div class="error-box">${escapeHtml(t().loadFailed(err.message))}</div>`;
  }
}

function renderTimeline(timeline) {
  return timeline
    .map(
      (item) => `<li><time>${formatDate(item.publishedAt)}</time><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.source)}</a> — ${escapeHtml(item.title)}</li>`,
    )
    .join('');
}

function renderReactionsByPlatform(map) {
  return Object.entries(map)
    .map(([platform, entries]) => {
      const rows = entries
        .map((e) => `<div class="reaction-item"><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.source)}</a>: ${Object.entries(e.reactions).map(([k, v]) => `${v} ${k}`).join(', ') || escapeHtml(t().noReactionData)}</div>`)
        .join('');
      return `<div class="platform-block"><h3>${PLATFORM_LABELS[platform] || platform}</h3>${rows}</div>`;
    })
    .join('');
}

function renderSourceList(sources) {
  return sources
    .map(
      (s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a><div class="source-meta">${escapeHtml(s.source)} · ${escapeHtml(s.publisherType)} · ${formatDate(s.publishedAt)}</div></li>`,
    )
    .join('');
}

function scoreCard(key, score) {
  return `
    <div class="score-card">
      <h3>${escapeHtml(t().scoreLabels[key])}</h3>
      <div class="big-value">${score.value}</div>
      <p>${escapeHtml(localizedRationale(score, state.lang))}</p>
    </div>
  `;
}

async function renderDetail(id) {
  homeView.hidden = true;
  detailView.hidden = false;
  detailView.innerHTML = `<p class="status-line">${escapeHtml(t().loading)}</p>`;

  try {
    const res = await fetch(`/api/stories/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      detailView.innerHTML = `<a class="back-link" href="#/">${escapeHtml(t().back)}</a><div class="error-box">${escapeHtml(t().notFound)}</div>`;
      return;
    }
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const view = await res.json();
    const s = view.scores;
    const text = localized(view, state.lang);

    detailView.innerHTML = `
      <a class="back-link" href="#/">${escapeHtml(t().back)}</a>
      <div class="detail-header">
        <span class="${badgeClass(view.verification.status)}">${escapeHtml(text.verificationLabel)}</span>
        <h1>${escapeHtml(text.title)}</h1>
        <p class="card-date">${escapeHtml(publishedLine(view.firstPublishedAt))}</p>
        ${text.gist ? `<p class="card-gist">${escapeHtml(text.gist)}</p>` : ''}
        ${text.summary ? `<p class="card-summary">${escapeHtml(text.summary)}</p>` : ''}
        <p class="verification-reason">${escapeHtml(text.verificationReason)} (${escapeHtml(t().independentSources(view.verification.independentSourceCount))})</p>
        <div class="meta-row">
          ${view.platforms.map((p) => `<span class="platform-tag">${PLATFORM_LABELS[p] || p}</span>`).join('')}
          <span class="platform-tag tag-category">${escapeHtml(categoryLabel(view.category))}</span>
        </div>
      </div>

      ${state.lang === 'ko' && view.takeKo ? `
      <div class="panel panel-take">
        <h2>${escapeHtml(t().takeToggle)}</h2>
        <p>${escapeHtml(view.takeKo)}</p>
        <p class="take-note">${escapeHtml(t().takeDisclaimer)}</p>
      </div>` : ''}

      <div class="detail-scores">
        ${scoreCard('mustKnow', s.mustKnow)}
        ${scoreCard('viral', s.viral)}
        ${scoreCard('influence', s.influence)}
        ${scoreCard('credibility', s.credibility)}
        ${scoreCard('impact', s.impact)}
      </div>

      <div class="panel">
        <h2>${escapeHtml(t().timeline)}</h2>
        <ul class="timeline">${renderTimeline(view.timeline)}</ul>
      </div>

      <div class="panel">
        <h2>${escapeHtml(t().reactions)}</h2>
        ${renderReactionsByPlatform(view.reactionsByPlatform)}
      </div>

      <div class="panel">
        <h2>${escapeHtml(t().sources)}</h2>
        <ul class="source-list">${renderSourceList(view.sources)}</ul>
      </div>
    `;
  } catch (err) {
    detailView.innerHTML = `<a class="back-link" href="#/">${escapeHtml(t().back)}</a><div class="error-box">${escapeHtml(t().loadFailed(err.message))}</div>`;
  }
}

function route() {
  const match = location.hash.match(/^#\/story\/(.+)$/);
  if (match) {
    renderDetail(decodeURIComponent(match[1]));
  } else {
    renderHome();
  }
}

// Re-renders every piece of chrome that isn't rebuilt by route() — the
// controls and the footer keep their DOM across language switches.
function applyLanguage() {
  document.documentElement.lang = state.lang;
  document.getElementById('lang-toggle').textContent = t().langToggle;

  for (const chip of chipsContainer.querySelectorAll('.chip')) {
    chip.textContent = chip.dataset.category ? t().categories[chip.dataset.category] : t().all;
  }
  for (const chip of periodChips.querySelectorAll('.chip')) {
    chip.textContent = t().periodChip(Number(chip.dataset.days));
  }

  // Preserve whatever href the snapshot link already has — the static build
  // (scripts/build-static.js) rewrites it to point at the JSON snapshot.
  const link = footerNote.querySelector('a');
  footerNote.innerHTML = `${escapeHtml(t().footerPre)}<a href="${escapeHtml(link.getAttribute('href'))}">${escapeHtml(link.textContent)}</a>${escapeHtml(t().footerPost)}`;

  renderAsOf();
}

function buildPeriodChips() {
  for (const days of PERIODS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip${days === state.days ? ' active' : ''}`;
    btn.dataset.days = String(days);
    periodChips.appendChild(btn);
  }
}

function buildCategoryChips() {
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.category = cat;
    chipsContainer.appendChild(btn);
  }
}

function initControls() {
  buildPeriodChips();
  buildCategoryChips();

  chipsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.category = btn.dataset.category;
    for (const chip of chipsContainer.querySelectorAll('.chip')) chip.classList.toggle('active', chip === btn);
    renderHome();
  });

  periodChips.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.days = Number(btn.dataset.days);
    for (const chip of periodChips.querySelectorAll('.chip')) chip.classList.toggle('active', chip === btn);
    renderHome();
  });

  document.getElementById('lang-toggle').addEventListener('click', () => {
    state.lang = state.lang === 'ko' ? 'en' : 'ko';
    localStorage.setItem('lang', state.lang);
    applyLanguage();
    route();
  });
}

function initTheme() {
  const stored = localStorage.getItem('theme');
  const preferred = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(preferred);

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

initTheme();
initControls();
applyLanguage();
window.addEventListener('hashchange', route);
route();
