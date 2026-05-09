/**
 * Cloudflare adapter — fetches account-level resource lists (Workers / R2 / D1).
 * Analytics (request counts, R2 class A ops) requires GraphQL API; deferred to v2.
 *
 * Required token permissions:
 *   Account.Workers Scripts:Read
 *   Account.D1:Read
 *   Account.R2:Read (Account)
 */

export interface CloudflareWorker {
  name: string
  modifiedOn: string | null
}

export interface CloudflareR2Bucket {
  name: string
  creationDate: string | null
}

export interface CloudflareD1Database {
  name: string
  uuid: string
  createdAt: string | null
}

export interface CloudflareMetrics {
  accountId: string
  workers: CloudflareWorker[]
  r2Buckets: CloudflareR2Bucket[]
  d1Databases: CloudflareD1Database[]
  fetchedAt: string
  errors?: { workers?: string; r2?: string; d1?: string }
}

const API_BASE = 'https://api.cloudflare.com/client/v4'

interface CFResponse<T> {
  success: boolean
  result?: T
  errors?: Array<{ code: number; message: string }>
}

async function cfGet<T>(path: string, token: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    const data = (await res.json()) as CFResponse<T>
    if (!data.success || !data.result) {
      const msg = data.errors?.[0]?.message ?? 'unknown error'
      return { ok: false, error: msg }
    }
    return { ok: true, data: data.result }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function fetchCloudflareMetrics(
  accountId: string,
  token: string,
): Promise<CloudflareMetrics> {
  const empty: CloudflareMetrics = {
    accountId,
    workers: [],
    r2Buckets: [],
    d1Databases: [],
    fetchedAt: new Date().toISOString(),
    errors: {},
  }

  if (!accountId || !token) {
    return { ...empty, errors: { workers: 'no accountId/token configured' } }
  }

  const [workersRes, r2Res, d1Res] = await Promise.all([
    cfGet<Array<{ id: string; modified_on?: string }>>(`/accounts/${accountId}/workers/scripts`, token),
    cfGet<{ buckets?: Array<{ name: string; creation_date?: string }> }>(`/accounts/${accountId}/r2/buckets`, token),
    cfGet<{ result?: Array<{ name: string; uuid: string; created_at?: string }> }>(`/accounts/${accountId}/d1/database`, token),
  ])

  const result: CloudflareMetrics = { ...empty, errors: {} }

  if (workersRes.ok) {
    result.workers = workersRes.data.map((w) => ({
      name: w.id,
      modifiedOn: w.modified_on ?? null,
    }))
  } else {
    result.errors!.workers = workersRes.error
  }

  if (r2Res.ok) {
    result.r2Buckets = (r2Res.data.buckets ?? []).map((b) => ({
      name: b.name,
      creationDate: b.creation_date ?? null,
    }))
  } else {
    result.errors!.r2 = r2Res.error
  }

  if (d1Res.ok) {
    // D1 list returns paginated structure; check both shapes
    const dbs = Array.isArray((d1Res.data as unknown as Array<unknown>))
      ? (d1Res.data as unknown as Array<{ name: string; uuid: string; created_at?: string }>)
      : (d1Res.data.result ?? [])
    result.d1Databases = dbs.map((d) => ({
      name: d.name,
      uuid: d.uuid,
      createdAt: d.created_at ?? null,
    }))
  } else {
    result.errors!.d1 = d1Res.error
  }

  // Clean empty errors object
  if (Object.keys(result.errors!).length === 0) delete result.errors

  return result
}
