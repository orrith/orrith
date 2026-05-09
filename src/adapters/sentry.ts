/**
 * Sentry adapter — fetches projects list + recent issue counts for an org.
 *
 * Required token scope: org:read, project:read, event:read (issue counts)
 * Token: Sentry user settings → Auth Tokens → Create New Token
 */

export interface SentryProject {
  slug: string
  name: string
  platform: string | null
  status: string  // 'active' | 'disabled' | etc
  lastEventAt: string | null
}

export interface SentryMetrics {
  orgSlug: string
  projects: SentryProject[]
  unresolvedIssues24h: number | null
  fetchedAt: string
  errors?: { projects?: string; issues?: string }
}

const API_BASE = 'https://sentry.io/api/0'

export async function fetchSentryMetrics(
  orgSlug: string,
  authToken: string,
): Promise<SentryMetrics> {
  const empty: SentryMetrics = {
    orgSlug,
    projects: [],
    unresolvedIssues24h: null,
    fetchedAt: new Date().toISOString(),
    errors: {},
  }

  if (!orgSlug || !authToken) {
    return { ...empty, errors: { projects: 'no orgSlug/token configured' } }
  }

  const headers = { Authorization: `Bearer ${authToken}`, Accept: 'application/json' }

  // Fetch projects + issues in parallel
  const [projectsRes, issuesRes] = await Promise.all([
    sentryFetch<Array<Record<string, unknown>>>(`/organizations/${orgSlug}/projects/`, headers),
    sentryFetch<Array<Record<string, unknown>>>(
      `/organizations/${orgSlug}/issues/?statsPeriod=24h&query=is:unresolved&limit=100`,
      headers,
    ),
  ])

  const result: SentryMetrics = { ...empty, errors: {} }

  if (projectsRes.ok) {
    result.projects = projectsRes.data.map((p) => ({
      slug: String(p.slug ?? ''),
      name: String(p.name ?? ''),
      platform: typeof p.platform === 'string' ? p.platform : null,
      status: String(p.status ?? 'unknown'),
      lastEventAt: typeof p.lastEvent === 'string' ? p.lastEvent : null,
    }))
  } else {
    result.errors!.projects = projectsRes.error
  }

  if (issuesRes.ok) {
    result.unresolvedIssues24h = issuesRes.data.length
  } else {
    result.errors!.issues = issuesRes.error
  }

  if (Object.keys(result.errors!).length === 0) delete result.errors
  return result
}

async function sentryFetch<T>(
  path: string,
  headers: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    const data = (await res.json()) as T
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
