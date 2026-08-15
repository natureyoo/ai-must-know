// Pure (DOM-free) dashboard logic, split out of app.js so it's importable
// from a Node test without needing a browser/document.

// Cards must show a summary of "3문장 이하" (item 17) — the API doesn't
// pre-truncate, so this trims to the first 3 sentences client-side. Decimal
// numbers/version strings ("GPT-5.2", "$1.2 billion") have a '.' that is not
// a sentence boundary, so those are masked before splitting and restored after.
export function firstSentences(text, n = 3) {
  const masked = text.replace(/(\d)\.(\d)/g, '$1{{DOT}}$2');
  const parts = masked.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [masked];
  return parts.slice(0, n).join(' ').replace(/\s+/g, ' ').trim().replace(/\{\{DOT\}\}/g, '.');
}

// Item 16: home screen shows today's top-N Must Know stories. Stories are
// assumed already sorted by the requested criterion (the API does the sort).
export function topStories(stories, n = 5) {
  return stories.slice(0, n);
}

// The dashboard defaults to Korean, but source text is English and
// src/translate only fills in what it managed to translate (no API key, a
// failed batch, an item collected before translation existed). Every field
// therefore falls back to the English original — a story is never blank or
// half-rendered because a translation is missing. `translated` lets the UI
// mark the ones still showing the original.
function sameText(a, b) {
  return a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function localized(view, lang = 'ko') {
  const ko = lang === 'ko';
  const title = (ko && view.titleKo) || view.title;
  const summary = (ko && view.summaryKo) || view.summary;
  return {
    title,
    // Feeds that ship no description leave summary === title; repeating the
    // headline underneath itself wastes the line a reader scans first.
    summary: sameText(summary, title) ? '' : summary,
    gist: (ko && view.gistKo) || '',
    verificationReason: (ko && view.verification.reasoningKo) || view.verification.reasoning,
    verificationLabel: (ko && view.verification.statusLabelKo) || view.verification.statusLabel,
    translated: Boolean(ko && view.titleKo),
  };
}

// A closed card shows the headline and, when translated, one line of gist.
// Nothing else — the body of the original stays behind the toggle below, so
// the grid can be scanned without reading paragraphs.
export function cardLead(text) {
  return text.gist;
}

// What the "원문 요약" toggle reveals: the original's content in at most two
// sentences. Empty only when there is nothing to add — no summary at all, or
// a summary the gist already says.
export function cardBrief(text) {
  const brief = firstSentences(text.summary, 2);
  return brief === cardLead(text) ? '' : brief;
}

// Viral score rewards accumulated engagement, so a story from two weeks ago
// can still outrank today's. That is correct for "what is big" and wrong for
// "what is new", hence a recency window on top of the ranking rather than a
// change to it. Filters on when the story broke (firstPublishedAt), not on
// its most recent repost.
export function withinDays(stories, days, now = new Date()) {
  if (!days) return stories;
  const cutoff = now.getTime() - days * 24 * 3600 * 1000;
  return stories.filter((s) => Date.parse(s.firstPublishedAt ?? s.latestPublishedAt) >= cutoff);
}

export function localizedRationale(score, lang = 'ko') {
  return (lang === 'ko' && score.rationaleKo) || score.rationale;
}

// How old the displayed snapshot is, in words. The page can be opened long
// after it was built (a static Pages deploy stays up until the next run), so
// "N시간 전" next to the absolute stamp is what stops a stale page from
// reading as live.
export function relativeAge(iso, now = new Date(), lang = 'ko') {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
  if (minutes < 60) return lang === 'ko' ? `${minutes}분 전` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return lang === 'ko' ? `${hours}시간 전` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return lang === 'ko' ? `${days}일 전` : `${days}d ago`;
}

// Collection runs once a day, so anything older than ~30h means a run was
// missed — worth flagging rather than silently showing yesterday's news as
// today's.
export function isStale(iso, now = new Date(), maxHours = 30) {
  return now.getTime() - Date.parse(iso) > maxHours * 3600 * 1000;
}

// "Ask an AI about this" — a prefilled prompt handed to claude.ai / chatgpt.com
// via their `q` query parameter. No backend, no key: the reader's own account
// answers, and it can open the 원문 URL itself, which is why the URL is in the
// prompt rather than a paraphrase of it. Kept short: it lives in a URL.
export function askPrompt(view, text, lang = 'ko') {
  const url = view.sources[0].url;
  const lead = text.gist || text.summary || '';
  return lang === 'ko'
    ? `다음 AI 업계 뉴스에 대해 알려줘. 먼저 원문 링크를 읽고, (1) 무슨 일이 있었는지 핵심을 정리하고 (2) 왜 중요한지, 배경 맥락과 함께 설명하고 (3) 과장이나 미확인 주장처럼 주의해서 봐야 할 부분이 있으면 짚어줘. 한국어로 답해줘.\n\n제목: ${view.title}\n${lead ? `요약: ${lead}\n` : ''}원문: ${url}`
    : `Tell me about this AI-industry story. Read the source link first, then (1) summarize what happened, (2) explain why it matters with background context, and (3) flag anything to be skeptical of (hype, unverified claims).\n\nTitle: ${view.title}\n${lead ? `Summary: ${lead}\n` : ''}Source: ${url}`;
}

export const ASK_TARGETS = [
  { key: 'claude', label: 'Claude', url: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
  { key: 'chatgpt', label: 'ChatGPT', url: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}` },
];
