/**
 * GitHub adapter — fetches public repo metrics (stars / forks / open issues).
 * Auth optional; PAT raises rate limit from 60/h to 5000/h.
 */

export interface GitHubRepoMetric {
  repo: string  // "owner/repo"
  stars: number
  forks: number
  openIssues: number
  watchers: number
  defaultBranch: string | null
  pushedAt: string | null
  error?: string
}

export interface GitHubMetrics {
  repos: GitHubRepoMetric[]
  fetchedAt: string
}

export async function fetchGitHubMetrics(
  repos: string[],
  token?: string,
): Promise<GitHubMetrics> {
  const results = await Promise.all(repos.map((repo) => fetchOne(repo, token)))
  return { repos: results, fetchedAt: new Date().toISOString() }
}

async function fetchOne(repo: string, token?: string): Promise<GitHubRepoMetric> {
  const empty: GitHubRepoMetric = {
    repo,
    stars: 0,
    forks: 0,
    openIssues: 0,
    watchers: 0,
    defaultBranch: null,
    pushedAt: null,
  }
  if (!repo.includes('/')) {
    return { ...empty, error: 'invalid repo format (expected owner/repo)' }
  }
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers })
    if (!res.ok) {
      return { ...empty, error: `HTTP ${res.status} ${res.statusText}` }
    }
    const data = (await res.json()) as Record<string, unknown>
    return {
      repo,
      stars: Number(data.stargazers_count ?? 0),
      forks: Number(data.forks_count ?? 0),
      openIssues: Number(data.open_issues_count ?? 0),
      watchers: Number(data.subscribers_count ?? data.watchers_count ?? 0),
      defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : null,
      pushedAt: typeof data.pushed_at === 'string' ? data.pushed_at : null,
    }
  } catch (e) {
    return { ...empty, error: String(e) }
  }
}
