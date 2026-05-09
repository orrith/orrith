import express, { type Response } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { watch, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { parseState, parseBacklog, parseTodos, parseRoadmap, parseRoadmaps } from './parser.ts'
import { loadConfig, resolveSource, type CustomMetricsResult } from './config.ts'
import { fetchGitHubMetrics, type GitHubMetrics } from './adapters/github.ts'
import { fetchCloudflareMetrics, type CloudflareMetrics } from './adapters/cloudflare.ts'
import { fetchSentryMetrics, type SentryMetrics } from './adapters/sentry.ts'
import { fetchStripeMetrics, type StripeMetrics } from './adapters/stripe.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(__dirname, 'public')

const config = await loadConfig()
const PORT = parseInt(process.env.PORT ?? String(config.port), 10)
const ROOT = config.sources.root

const STATE_PATH = resolveSource(config, 'state')
const BACKLOG_PATH = resolveSource(config, 'backlog')
const ROADMAPS_PATH = resolveSource(config, 'roadmaps')
const TODOS_DIR = resolveSource(config, 'todosDir')

const app = express()
app.use(express.json({ limit: '64kb' }))

// CORS: only allow http://localhost / 127.0.0.1 (any port). This prevents a
// public website from reading /api/metrics (which can leak service info via
// cache) or pushing to /api/preview-url from a browser on the same machine.
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (typeof origin === 'string' && LOCAL_ORIGIN_RE.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Vary', 'Origin')
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type')
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  next()
})
app.options(/.*/, (_req, res) => {
  res.status(204).end()
})

// ===== SSE: real-time data updates =====

const sseClients = new Set<Response>()

app.get('/sse', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write(`event: hello\ndata: connected\n\n`)
  sseClients.add(res)
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`)
    } catch {
      sseClients.delete(res)
      clearInterval(heartbeat)
    }
  }, 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
  })
})

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of sseClients) {
    try {
      c.write(payload)
    } catch {
      sseClients.delete(c)
    }
  }
}

// ===== file watch → SSE push =====

function shouldIgnore(relPath: string): boolean {
  for (const part of config.watch.excludeParts) {
    if (relPath.includes(`${part}/`) || relPath === part || relPath.startsWith(`${part}/`)) return true
  }
  if (config.watch.excludeExt.test(relPath)) return true
  return false
}

function classify(absPath: string): { label: string; key: string } | null {
  if (STATE_PATH && absPath === STATE_PATH) return { label: 'STATE', key: 'STATE' }
  if (BACKLOG_PATH && absPath === BACKLOG_PATH) return { label: 'BACKLOG', key: 'BACKLOG' }
  if (ROADMAPS_PATH && absPath === ROADMAPS_PATH) return { label: 'ROADMAP', key: 'ROADMAP' }
  if (TODOS_DIR && absPath.startsWith(TODOS_DIR + path.sep)) {
    const m = path.basename(absPath).match(/^(\d{4}-\d{2}-\d{2})\.md$/)
    if (m) return { label: 'TODAY', key: 'TODAY' }
  }
  const rel = path.relative(ROOT, absPath)
  if (rel.startsWith('..')) return null
  return { label: 'FILE', key: `FILE:${rel}` }
}

interface Change {
  label: string
  filename: string
  path: string
  time: number
}
const recentChanges = new Map<string, Change>()
let debounceTimer: NodeJS.Timeout | null = null

function scheduleBroadcast(change: Change, key: string) {
  recentChanges.set(key, change)
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    const changes = Array.from(recentChanges.values())
    recentChanges.clear()
    console.log(`📡 broadcast: ${changes.map((c) => `${c.label} ${c.path}`).join(', ')}`)
    broadcast('data-update', { changes })
  }, 200)
}

const watchRoots = [
  { dir: ROOT, prefix: '' },
  ...config.watch.additionalRoots.map((r) => ({
    dir: path.isAbsolute(r) ? r : path.join(ROOT, r),
    prefix: r,
  })),
]

for (const root of watchRoots) {
  try {
    const watcher = watch(root.dir, { persistent: true, recursive: true }, (_evt, filename) => {
      if (!filename) return
      const fname = filename.toString()
      const absPath = path.join(root.dir, fname)
      const rel = path.relative(ROOT, absPath).replace(/\\/g, '/')
      if (shouldIgnore(rel)) return
      const cls = classify(absPath)
      if (!cls) return
      scheduleBroadcast(
        { label: cls.label, filename: path.basename(fname), path: rel, time: Date.now() },
        cls.key,
      )
    })
    watcher.on('error', (err) => {
      console.warn(`⚠️  watcher error for ${root.prefix || 'root'}: ${(err as Error).message}`)
    })
    console.log(`👁  watching ${root.prefix || ROOT} (recursive)`)
  } catch (e) {
    console.warn(`⚠️  failed to watch ${root.dir}: ${e}`)
  }
}

// ===== API endpoints =====

app.get('/api/state', (_req, res) => {
  if (!STATE_PATH) {
    res.json({ phase: null, sprint: null, lastUpdated: null })
    return
  }
  try {
    res.json(parseState(STATE_PATH, config.parsers.state))
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.get('/api/backlog', (_req, res) => {
  if (!BACKLOG_PATH) {
    res.json({ categories: [], summary: null })
    return
  }
  try {
    res.json(parseBacklog(BACKLOG_PATH, config.parsers.backlog))
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

function todayLocal(): string {
  // local timezone date — users in JST/PST/etc all get their local "today"
  const now = new Date()
  const offsetMs = now.getTimezoneOffset() * 60 * 1000
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10)
}

app.get('/api/today', (_req, res) => {
  if (!TODOS_DIR) {
    res.json({ date: todayLocal(), undone: [], done: [] })
    return
  }
  try {
    const today = todayLocal()
    res.json(parseTodos(path.join(TODOS_DIR, `${today}.md`), today))
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.get('/api/roadmap', (_req, res) => {
  if (!STATE_PATH) {
    res.json({ name: null, period: null, goal: null, steps: [] })
    return
  }
  try {
    res.json(parseRoadmap(STATE_PATH, config.parsers.state))
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.get('/api/roadmaps', (_req, res) => {
  try {
    if (ROADMAPS_PATH && existsSync(ROADMAPS_PATH)) {
      res.json({ roadmaps: parseRoadmaps(ROADMAPS_PATH) })
      return
    }
    if (STATE_PATH) {
      const single = parseRoadmap(STATE_PATH, config.parsers.state)
      res.json({ roadmaps: single.name ? [single] : [] })
      return
    }
    res.json({ roadmaps: [] })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ===== git status =====

interface GitStatus {
  branch: string
  ahead: number
  behind: number
  modified: string[]
  untracked: string[]
  staged: string[]
  error?: string
}

function getGitStatus(): GitStatus {
  const result: GitStatus = {
    branch: '',
    ahead: 0,
    behind: 0,
    modified: [],
    untracked: [],
    staged: [],
  }
  try {
    result.branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    try {
      result.ahead = parseInt(execSync('git rev-list --count @{u}..HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(), 10) || 0
    } catch {}
    try {
      result.behind = parseInt(execSync('git rev-list --count HEAD..@{u}', { cwd: ROOT, encoding: 'utf8' }).trim(), 10) || 0
    } catch {}
    const porcelain = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' })
    for (const line of porcelain.split('\n')) {
      if (!line) continue
      const code = line.slice(0, 2)
      const file = line.slice(3)
      if (code === '??') result.untracked.push(file)
      else if (code[0] && code[0] !== ' ' && code[0] !== '?') result.staged.push(file)
      else if (code[1] && code[1] !== ' ') result.modified.push(file)
    }
  } catch (e) {
    result.error = String(e)
  }
  return result
}

app.get('/api/git', (_req, res) => {
  res.json(getGitStatus())
})

// ===== preview URL push (optional feature) =====
let lastPreviewUrl: string | null = null

app.post('/api/preview-url', (req, res) => {
  // Reject cross-origin POSTs that aren't from localhost — prevents a malicious
  // public site from forcing every connected SSE client's iframe to load an
  // attacker-controlled URL.
  const origin = req.headers.origin
  if (typeof origin === 'string' && !LOCAL_ORIGIN_RE.test(origin)) {
    res.status(403).json({ error: 'cross-origin POST not allowed' })
    return
  }
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (!url) {
    res.status(400).json({ error: 'url (string) required in JSON body' })
    return
  }
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'url must start with http:// or https://' })
    return
  }
  lastPreviewUrl = url
  const payload: { url: string; viewport?: number; ts: string } = {
    url,
    ts: new Date().toISOString(),
  }
  const vp = req.body?.viewport
  if (typeof vp === 'number' && vp >= 0) payload.viewport = vp
  console.log(`📺 preview-url push: ${url}${vp ? ` (vp=${vp})` : ''}`)
  broadcast('preview-url', payload)
  res.json({ ok: true, url, clients: sseClients.size })
})

app.get('/api/preview-url', (_req, res) => {
  res.json({ url: lastPreviewUrl })
})

// ===== external metrics =====

interface CustomEntry {
  name: string
  label: string
  result: CustomMetricsResult
}

interface MetricsCache {
  github?: GitHubMetrics
  cloudflare?: CloudflareMetrics
  sentry?: SentryMetrics
  stripe?: StripeMetrics
  custom?: CustomEntry[]
  fetchedAt: number
}
let metricsCache: MetricsCache = { fetchedAt: 0 }
const METRICS_TTL_MS = 60_000 // 1 min

async function getMetrics(): Promise<MetricsCache> {
  const now = Date.now()
  if (now - metricsCache.fetchedAt < METRICS_TTL_MS) return metricsCache

  const next: MetricsCache = { fetchedAt: now }
  const tasks: Promise<void>[] = []

  if (config.metrics?.github?.repos?.length) {
    tasks.push(
      fetchGitHubMetrics(config.metrics.github.repos, config.metrics.github.token).then((r) => {
        next.github = r
      }),
    )
  }
  if (config.metrics?.cloudflare?.accountId && config.metrics.cloudflare.apiToken) {
    tasks.push(
      fetchCloudflareMetrics(config.metrics.cloudflare.accountId, config.metrics.cloudflare.apiToken).then((r) => {
        next.cloudflare = r
      }),
    )
  }
  if (config.metrics?.sentry?.orgSlug && config.metrics.sentry.authToken) {
    tasks.push(
      fetchSentryMetrics(config.metrics.sentry.orgSlug, config.metrics.sentry.authToken).then((r) => {
        next.sentry = r
      }),
    )
  }
  if (config.metrics?.stripe?.secretKey) {
    tasks.push(
      fetchStripeMetrics(config.metrics.stripe.secretKey).then((r) => {
        next.stripe = r
      }),
    )
  }
  if (config.metrics?.custom?.length) {
    next.custom = []
    for (const adapter of config.metrics.custom) {
      tasks.push(
        adapter
          .fetch()
          .then((result) => {
            next.custom!.push({ name: adapter.name, label: adapter.label, result })
          })
          .catch((e) => {
            next.custom!.push({
              name: adapter.name,
              label: adapter.label,
              result: {
                fields: [],
                fetchedAt: new Date().toISOString(),
                error: String(e),
              },
            })
          }),
      )
    }
  }
  await Promise.all(tasks)
  metricsCache = next
  return next
}

app.get('/api/metrics', async (_req, res) => {
  try {
    const m = await getMetrics()
    res.json(m)
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ===== config introspection (for client-side preset loading) =====

app.get('/api/config', (_req, res) => {
  res.json({ preset: config.preset, port: PORT })
})

app.use(express.static(PUBLIC_DIR))

// Bind to loopback only — orrith is a personal local tool, not a network service.
// Don't expose it via ngrok / Tailscale / 0.0.0.0; tokens in /api/metrics
// would leak to anyone on the network.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🌌 orrith running at http://localhost:${PORT}`)
  console.log(`   preset: ${config.preset}`)
  console.log(`   root:   ${ROOT}`)
})
