import { existsSync } from 'node:fs'
import path from 'node:path'

export type Preset = 'pixel' | 'visor' | 'monolith' | 'doodle' | 'minimal'

/** A single field rendered as one cell in a custom adapter's card. */
export interface CustomMetricField {
  /** Short label shown above the value (e.g. "stars", "MRR") */
  label: string
  /** The value to display (number or string) */
  value: string | number
  /** Optional sub-text shown under the value (e.g. "+5 today") */
  sub?: string
}

/** Result returned by a CustomAdapter.fetch() call. */
export interface CustomMetricsResult {
  /** Cells displayed in the card body (4 per row by default). */
  fields: CustomMetricField[]
  /** Optional footer text under the cells. */
  meta?: string
  /** ISO timestamp of when this snapshot was fetched. */
  fetchedAt: string
  /** Optional error message; if present, the card is rendered in error style. */
  error?: string
}

/**
 * Custom adapter contract. Define one in orrith.config.js to pull data
 * from any service (Vercel / Supabase / Plausible / Lemon Squeezy / npm / etc).
 *
 * Example:
 *   {
 *     name: 'vercel',
 *     label: 'VERCEL',
 *     fetch: async () => {
 *       const r = await fetch('https://api.vercel.com/v9/projects', {
 *         headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
 *       })
 *       const data = await r.json()
 *       return {
 *         fields: [{ label: 'projects', value: data.projects?.length ?? 0 }],
 *         fetchedAt: new Date().toISOString(),
 *       }
 *     },
 *   }
 */
export interface CustomAdapter {
  /** Unique id (used as section key). Lowercase recommended. */
  name: string
  /** Display name (uppercase recommended; rendered as "▾ {LABEL}") */
  label: string
  /** Async function returning a CustomMetricsResult. Called every cache TTL. */
  fetch: () => Promise<CustomMetricsResult>
}

export interface OrrithConfig {
  sources: {
    /** Watch root (absolute or relative to cwd). Default: cwd */
    root: string
    /** STATE markdown file (relative to root). Default: undefined (disabled) */
    state?: string
    /** Backlog markdown file (relative to root). Default: undefined */
    backlog?: string
    /** Roadmaps markdown file (relative to root). Default: undefined */
    roadmaps?: string
    /** Todos directory (relative to root). Files like {YYYY-MM-DD}.md inside. Default: undefined */
    todosDir?: string
  }
  watch: {
    /** Additional directories (relative to root) to watch. Default: [] */
    additionalRoots: string[]
    /** Path parts to exclude from watch events. Default: common build / vcs dirs */
    excludeParts: string[]
    /** File extension regex to exclude. Default: images / locks / logs */
    excludeExt: RegExp
  }
  parsers: {
    state: { phaseSection: string; roadmapSection: string }
    backlog: { categoryRegex: string }
  }
  /** External data sources. Tokens read from env (preferred) or config (publish-unsafe). */
  metrics?: {
    github?: {
      /** Repos to track, e.g. ['orrith/orrith', 'me/closetly'] */
      repos: string[]
      /** PAT. Prefer env GITHUB_TOKEN. Inline config not recommended for public repos. */
      token?: string
    }
    cloudflare?: {
      /** CF Account ID (from dash URL). Prefer env CLOUDFLARE_ACCOUNT_ID. */
      accountId?: string
      /** API token with Workers/R2/D1 read perms. Prefer env CLOUDFLARE_API_TOKEN. */
      apiToken?: string
    }
    sentry?: {
      /** Org slug (e.g. 'my-org'). Prefer env SENTRY_ORG. */
      orgSlug?: string
      /** Auth token with org:read + project:read + event:read. Prefer env SENTRY_TOKEN. */
      authToken?: string
    }
    stripe?: {
      /** Secret key (sk_live_... or sk_test_...). Prefer env STRIPE_SECRET_KEY. */
      secretKey?: string
    }
    /**
     * User-defined adapters. Each entry's `fetch` returns whatever data you want
     * displayed as a card under METRICS. See README "Extending: Custom Adapters".
     */
    custom?: CustomAdapter[]
  }
  preset: Preset
  port: number
}

const DEFAULT_CONFIG: OrrithConfig = {
  sources: {
    root: process.cwd(),
  },
  watch: {
    additionalRoots: [],
    excludeParts: [
      'node_modules',
      '.git',
      'dist',
      '.next',
      '.nuxt',
      '.output',
      '.wrangler',
      '.playwright-mcp',
    ],
    excludeExt: /\.(png|jpe?g|webp|ico|lock|log|map|tsbuildinfo)$/i,
  },
  parsers: {
    state: {
      phaseSection: 'Current Phase',
      roadmapSection: 'Current Roadmap',
    },
    backlog: {
      categoryRegex: '^##\\s+([A-Z])\\.\\s+([^\\n]+)',
    },
  },
  preset: 'pixel',
  port: 3838,
}

export async function loadConfig(cwd: string = process.cwd()): Promise<OrrithConfig> {
  const candidates = ['orrith.config.js', 'orrith.config.mjs']
  for (const name of candidates) {
    const filePath = path.join(cwd, name)
    if (!existsSync(filePath)) continue
    const mod = await import(filePath)
    const userConfig = (mod.default ?? mod) as Partial<OrrithConfig>
    return mergeConfig(DEFAULT_CONFIG, userConfig, cwd)
  }
  return { ...DEFAULT_CONFIG, sources: { ...DEFAULT_CONFIG.sources, root: cwd } }
}

function mergeConfig(
  base: OrrithConfig,
  user: Partial<OrrithConfig>,
  cwd: string,
): OrrithConfig {
  const root = user.sources?.root
    ? path.isAbsolute(user.sources.root)
      ? user.sources.root
      : path.resolve(cwd, user.sources.root)
    : cwd
  return {
    sources: { ...base.sources, ...(user.sources ?? {}), root },
    watch: { ...base.watch, ...(user.watch ?? {}) },
    parsers: {
      state: { ...base.parsers.state, ...(user.parsers?.state ?? {}) },
      backlog: { ...base.parsers.backlog, ...(user.parsers?.backlog ?? {}) },
    },
    preset: user.preset ?? base.preset,
    port: user.port ?? base.port,
    metrics: mergeMetrics(base.metrics, user.metrics),
  }
}

function mergeMetrics(
  base: OrrithConfig['metrics'],
  user: OrrithConfig['metrics'],
): OrrithConfig['metrics'] {
  if (!base && !user) return undefined
  const m = { ...(base ?? {}), ...(user ?? {}) }
  // Token override priority: env > user config > base
  if (m.github) {
    m.github = {
      ...m.github,
      token: process.env.GITHUB_TOKEN ?? m.github.token,
    }
  }
  if (m.cloudflare) {
    m.cloudflare = {
      ...m.cloudflare,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? m.cloudflare.accountId,
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? m.cloudflare.apiToken,
    }
  }
  if (m.sentry) {
    m.sentry = {
      ...m.sentry,
      orgSlug: process.env.SENTRY_ORG ?? m.sentry.orgSlug,
      authToken: process.env.SENTRY_TOKEN ?? m.sentry.authToken,
    }
  }
  if (m.stripe) {
    m.stripe = {
      ...m.stripe,
      secretKey: process.env.STRIPE_SECRET_KEY ?? m.stripe.secretKey,
    }
  }
  return m
}

/** Resolve a source path (relative to root) to absolute. Returns null if not configured. */
export function resolveSource(config: OrrithConfig, key: keyof OrrithConfig['sources']): string | null {
  const val = config.sources[key]
  if (!val || key === 'root') return key === 'root' ? config.sources.root : null
  return path.isAbsolute(val as string) ? (val as string) : path.join(config.sources.root, val as string)
}
