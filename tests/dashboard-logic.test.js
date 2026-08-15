import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSentences, topStories, localized, localizedRationale, cardLead, cardBrief, withinDays, relativeAge, isStale, askPrompt, ASK_TARGETS } from '../public/logic.js';
import { getFixtureItems } from '../src/adapters/fixtures/index.js';

const VIEW = {
  title: 'OpenAI ships GPT-5.2',
  titleKo: 'OpenAI, GPT-5.2 출시',
  summary: 'OpenAI released GPT-5.2 today.',
  summaryKo: 'OpenAI가 오늘 GPT-5.2를 공개했습니다.',
  gistKo: 'OpenAI가 GPT-5.2를 공개했습니다',
  verification: {
    status: 'verified',
    statusLabel: 'Verified',
    statusLabelKo: '검증됨',
    reasoning: 'Verified: 2 independent sources corroborate this.',
    reasoningKo: '검증됨: 독립 출처 2곳이 같은 내용을 뒷받침합니다.',
  },
};

test('firstSentences does not split on decimal points inside version numbers or dollar amounts', () => {
  const gpt = getFixtureItems().find((i) => i.id === 'rss-openai-gpt5-2-launch');
  const out = firstSentences(gpt.summary, 3);
  assert.match(out, /GPT-5\.2/);
  assert.match(out, /GPT-5\.1/);
  assert.doesNotMatch(out, /GPT-5\.\s+2/);

  const mistral = getFixtureItems().find((i) => i.id === 'rss-mistral-series-c-official');
  assert.match(firstSentences(mistral.summary, 3), /\$1\.2 billion/);
});

test('firstSentences caps at n sentences and never grows the text', () => {
  for (const item of getFixtureItems()) {
    const out = firstSentences(item.summary, 3);
    assert.ok(out.length <= item.summary.length, `truncated summary must not be longer than the original (${item.id})`);
    const sentenceEnders = out.match(/[.!?](?!\d)/g) || [];
    assert.ok(sentenceEnders.length <= 3, `expected at most 3 sentences for ${item.id}, got: ${out}`);
  }
});

test('topStories returns the first N items and defaults to 5 (item 16: today\'s Must Know 5)', () => {
  const stories = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}` }));
  const top = topStories(stories);
  assert.equal(top.length, 5);
  assert.deepEqual(top.map((s) => s.id), ['s0', 's1', 's2', 's3', 's4']);
});

test('topStories does not mutate or reorder the input array', () => {
  const stories = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const top = topStories(stories, 2);
  assert.deepEqual(stories.map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(top.map((s) => s.id), ['a', 'b']);
});

test('topStories returns fewer than N when there are fewer stories than N', () => {
  const stories = [{ id: 'only-one' }];
  assert.equal(topStories(stories, 5).length, 1);
});

test('Korean is the default rendering when a translation exists', () => {
  const text = localized(VIEW, 'ko');
  assert.equal(text.title, 'OpenAI, GPT-5.2 출시');
  assert.equal(text.summary, 'OpenAI가 오늘 GPT-5.2를 공개했습니다.');
  assert.equal(text.gist, 'OpenAI가 GPT-5.2를 공개했습니다');
  assert.equal(text.verificationLabel, '검증됨');
  assert.match(text.verificationReason, /독립 출처 2곳/);
  assert.equal(text.translated, true);
});

test('English mode always shows the untranslated original, gist included', () => {
  const text = localized(VIEW, 'en');
  assert.equal(text.title, 'OpenAI ships GPT-5.2');
  assert.equal(text.summary, 'OpenAI released GPT-5.2 today.');
  assert.equal(text.gist, '', 'the one-line gist only exists in Korean');
  assert.equal(text.verificationLabel, 'Verified');
  assert.equal(text.translated, false);
});

test('a story with no Korean row falls back to English rather than rendering blank', () => {
  const untranslated = { ...VIEW, titleKo: null, summaryKo: null, gistKo: null };
  const text = localized(untranslated, 'ko');
  assert.equal(text.title, 'OpenAI ships GPT-5.2');
  assert.equal(text.summary, 'OpenAI released GPT-5.2 today.');
  assert.equal(text.gist, '');
  assert.equal(text.translated, false, 'the UI marks it as showing the original');
});

test('a summary that merely repeats the title is dropped instead of printed twice', () => {
  const echoed = {
    ...VIEW,
    summary: '  OpenAI ships   GPT-5.2 ',
    summaryKo: 'OpenAI, GPT-5.2 출시',
  };
  assert.equal(localized(echoed, 'en').summary, '', 'whitespace/case differences still count as the same text');
  assert.equal(localized(echoed, 'ko').summary, '');
  assert.equal(localized(VIEW, 'ko').summary, 'OpenAI가 오늘 GPT-5.2를 공개했습니다.', 'a real summary survives');
});

test('the closed card shows only the gist; the original content stays in the toggle', () => {
  const text = localized(VIEW, 'ko');
  assert.equal(cardLead(text), 'OpenAI가 GPT-5.2를 공개했습니다');
  assert.equal(cardBrief(text), 'OpenAI가 오늘 GPT-5.2를 공개했습니다.');
});

test('a one-sentence summary still gets its own toggle rather than being promoted to the card', () => {
  const untranslated = localized({ ...VIEW, titleKo: null, summaryKo: null, gistKo: null }, 'ko');
  assert.equal(cardLead(untranslated), '', 'no gist yet → the closed card is headline-only');
  assert.equal(cardBrief(untranslated), 'OpenAI released GPT-5.2 today.');
});

test('the toggle is dropped only when there is genuinely nothing to reveal', () => {
  assert.equal(cardBrief({ gist: 'OpenAI가 GPT-5.2를 공개했습니다', summary: '' }), '', 'a title-echo summary leaves nothing to expand');
  assert.equal(cardBrief({ gist: '같은 문장입니다.', summary: '같은 문장입니다.' }), '', 'never open a toggle onto the line already on the card');
});

test('the toggle caps the original at two sentences, however long the source is', () => {
  const long = { gist: '', summary: 'One. Two. Three. Four.' };
  assert.equal(cardBrief(long), 'One. Two.');
});

test('score rationales follow the language, falling back to English when untranslated', () => {
  const score = { value: 80, rationale: 'Weighted blend: ...', rationaleKo: '가중 합산: ...' };
  assert.equal(localizedRationale(score, 'ko'), '가중 합산: ...');
  assert.equal(localizedRationale(score, 'en'), 'Weighted blend: ...');
  assert.equal(localizedRationale({ value: 80, rationale: 'only English' }, 'ko'), 'only English');
});

test('relativeAge describes the age of the displayed snapshot in both languages', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  assert.equal(relativeAge('2026-08-09T11:30:00.000Z', now, 'ko'), '30분 전');
  assert.equal(relativeAge('2026-08-09T09:00:00.000Z', now, 'ko'), '3시간 전');
  assert.equal(relativeAge('2026-08-07T12:00:00.000Z', now, 'ko'), '2일 전');
  assert.equal(relativeAge('2026-08-09T09:00:00.000Z', now, 'en'), '3h ago');
});

test('relativeAge never reports a negative age for a clock slightly ahead of the snapshot', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  assert.equal(relativeAge('2026-08-09T12:05:00.000Z', now, 'ko'), '0분 전');
});

test('isStale flags a missed daily run but not a normal same-day-old snapshot', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  assert.equal(isStale('2026-08-09T05:00:00.000Z', now), false, '7h old is a normal daily snapshot');
  assert.equal(isStale('2026-08-08T20:00:00.000Z', now), false, '16h old is still within one cycle');
  assert.equal(isStale('2026-08-08T04:00:00.000Z', now), true, '32h old means a run was missed');
});

test('the recency window keeps what broke inside it and drops what did not', () => {
  const now = new Date('2026-08-10T00:00:00.000Z');
  const stories = [
    { id: 'today', firstPublishedAt: '2026-08-09T20:00:00.000Z' },
    { id: 'six-days', firstPublishedAt: '2026-08-04T01:00:00.000Z' },
    { id: 'twelve-days', firstPublishedAt: '2026-07-29T00:00:00.000Z' },
  ];

  assert.deepEqual(withinDays(stories, 7, now).map((s) => s.id), ['today', 'six-days']);
  assert.deepEqual(withinDays(stories, 0, now).map((s) => s.id), ['today', 'six-days', 'twelve-days'], 'no window = no filtering');
});

test('the window uses when the story broke, not a later repost of it', () => {
  const now = new Date('2026-08-10T00:00:00.000Z');
  const revived = [{ id: 'old-story', firstPublishedAt: '2026-07-20T00:00:00.000Z', latestPublishedAt: '2026-08-09T00:00:00.000Z' }];
  assert.deepEqual(withinDays(revived, 7, now), [], 'a fresh repost must not resurrect three-week-old news');
});

test('askPrompt hands the AI the headline, the gist and the source URL, and fits in a URL', () => {
  const view = { title: 'Mistral OCR 4.1', sources: [{ url: 'https://mistral.ai/news/ocr-4-1' }] };
  const ko = askPrompt(view, { gist: '문단 단위 bbox 지원', summary: '' }, 'ko');
  assert.ok(ko.includes('Mistral OCR 4.1') && ko.includes('문단 단위 bbox 지원') && ko.includes('https://mistral.ai/news/ocr-4-1'));
  const en = askPrompt(view, { gist: '', summary: 'Adds paragraph-level boxes.' }, 'en');
  assert.ok(en.includes('Adds paragraph-level boxes.') && !en.includes('요약'));
  for (const target of ASK_TARGETS) {
    const href = target.url(ko);
    assert.ok(href.startsWith('https://') && href.length < 2000, `${target.key} link must stay a sane URL`);
  }
});
