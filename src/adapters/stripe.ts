/**
 * Stripe adapter — fetches balance + active subscriptions + 24h charges.
 *
 * Auth: Stripe Secret Key (sk_live_... or sk_test_...)
 * Required: read access to balance, subscriptions, charges
 *
 * Note: Stripe API is paginated. v1 returns approx counts (capped at 100).
 * Full MRR calculation across all subscriptions = v2 work.
 */

export interface StripeBalanceLine {
  currency: string  // 'usd', 'jpy'
  amount: number    // in smallest currency unit (cents/yen)
}

export interface StripeMetrics {
  balanceAvailable: StripeBalanceLine[]
  balancePending: StripeBalanceLine[]
  /** active subscriptions in last page; ≤100 (use Stripe Sigma for full counts) */
  activeSubscriptionsApprox: number
  activeSubscriptionsHasMore: boolean
  /** charges in last 24h */
  recentCharges24h: number
  recentChargesAmount24h: StripeBalanceLine[]
  livemode: boolean | null
  fetchedAt: string
  errors?: { balance?: string; subscriptions?: string; charges?: string }
}

const API_BASE = 'https://api.stripe.com/v1'

export async function fetchStripeMetrics(secretKey: string): Promise<StripeMetrics> {
  const empty: StripeMetrics = {
    balanceAvailable: [],
    balancePending: [],
    activeSubscriptionsApprox: 0,
    activeSubscriptionsHasMore: false,
    recentCharges24h: 0,
    recentChargesAmount24h: [],
    livemode: null,
    fetchedAt: new Date().toISOString(),
    errors: {},
  }

  if (!secretKey) {
    return { ...empty, errors: { balance: 'no Stripe secret key configured' } }
  }

  const headers = {
    Authorization: `Bearer ${secretKey}`,
    Accept: 'application/json',
  }

  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60

  const [balanceRes, subsRes, chargesRes] = await Promise.all([
    stripeFetch<{ available: StripeBalanceLine[]; pending: StripeBalanceLine[]; livemode?: boolean }>(`/balance`, headers),
    stripeFetch<{ data: unknown[]; has_more: boolean }>(`/subscriptions?status=active&limit=100`, headers),
    stripeFetch<{ data: Array<{ amount: number; currency: string; status: string }>; has_more: boolean }>(
      `/charges?created[gte]=${dayAgo}&limit=100`,
      headers,
    ),
  ])

  const result: StripeMetrics = { ...empty, errors: {} }

  if (balanceRes.ok) {
    result.balanceAvailable = balanceRes.data.available ?? []
    result.balancePending = balanceRes.data.pending ?? []
    if (typeof balanceRes.data.livemode === 'boolean') result.livemode = balanceRes.data.livemode
  } else {
    result.errors!.balance = balanceRes.error
  }

  if (subsRes.ok) {
    result.activeSubscriptionsApprox = subsRes.data.data?.length ?? 0
    result.activeSubscriptionsHasMore = !!subsRes.data.has_more
  } else {
    result.errors!.subscriptions = subsRes.error
  }

  if (chargesRes.ok) {
    const succeeded = chargesRes.data.data?.filter((c) => c.status === 'succeeded') ?? []
    result.recentCharges24h = succeeded.length
    // sum by currency
    const sumByCurrency = new Map<string, number>()
    for (const c of succeeded) {
      sumByCurrency.set(c.currency, (sumByCurrency.get(c.currency) ?? 0) + c.amount)
    }
    result.recentChargesAmount24h = Array.from(sumByCurrency.entries()).map(([currency, amount]) => ({ currency, amount }))
  } else {
    result.errors!.charges = chargesRes.error
  }

  if (Object.keys(result.errors!).length === 0) delete result.errors
  return result
}

async function stripeFetch<T>(
  path: string,
  headers: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 100)}` }
    }
    return { ok: true, data: (await res.json()) as T }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
