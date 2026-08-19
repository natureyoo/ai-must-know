// Live adapter: GitHub public REST API (item 3). GitHub has no official
// "trending" endpoint, so this approximates it via the search API: AI-topic
// repos pushed in the last week, sorted by stars. Reads an optional token
// from process.env.GITHUB_TOKEN for a higher rate limit — never hardcode a
// value, never write one to any file. Never throws — a failed or
// rate-limited request just yields an empty array.

import { assertValidSourceItem } from '../sourceItem.js';

const SEARCH_URL = 'https://api.github.com/search/repositories';

function idFor(id) {
  return `github-${id}`;
}

function isoDateDaysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function fetchGithubItems({
  fetchImpl = fetch,
  now = new Date(),
  token = process.env.GITHUB_TOKEN,
  perPage = 20,
  timeoutMs = 8000,
} = {}) {
  // `created:>` rather than `pushed:>`: sorting all-time repos by stars just
  // returns the same multi-year giants (AutoGPT et al.) that happen to have
  // had a commit this week. Restricting to recently *created* repos makes the
  // star count a proxy for current momentum, which is what "trending" means.
  const query = `topic:artificial-intelligence created:>${isoDateDaysAgo(now, 60)}`;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    payload = await res.json();
  } catch {
    return [];
  }

  const repos = Array.isArray(payload?.items) ? payload.items : [];
  const items = [];
  for (const repo of repos) {
    // Star farms: "AI Object Remover 2026 – Erase Distractions & Keep HD
    // Quality" with 116 stars, 0 forks, 0 issues, created this week — six of
    // them a day, all with the same star count. Real momentum has forks.
    if ((repo.forks_count ?? 0) < 5) continue;
    try {
      const item = {
        id: idFor(repo.id),
        sourceType: 'github',
        source: 'GitHub',
        // Always 'community': the search API gives no reliable signal to tell an
        // official org repo (e.g. openai/*) from an individual's, and guessing
        // wrong would let a company's own repo count as an independent source
        // in verification's tally (src/verification/index.js excludes 'company').
        publisherType: 'community',
        category: 'open-source',
        title: `${repo.full_name} — ${repo.description || 'trending AI repository'}`,
        url: repo.html_url,
        summary: repo.description || `A trending AI-related GitHub repository with ${repo.stargazers_count ?? 0} stars.`,
        publishedAt: repo.pushed_at,
        collectedAt: now.toISOString(),
        reactions: {
          stars: repo.stargazers_count ?? 0,
          forks: repo.forks_count ?? 0,
          openIssues: repo.open_issues_count ?? 0,
        },
      };
      assertValidSourceItem(item);
      items.push(item);
    } catch {
      // malformed/incomplete repo entry — skip it, not the whole batch
    }
  }
  return items;
}
