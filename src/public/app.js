// COMPANY HUD - frontend renderer

const REFRESH_FALLBACK_MS = 60_000 // fallback polling when SSE drops

function $(id) {
  return document.getElementById(id)
}

// ===== toast =====

const TOAST_LABELS = {
  STATE: 'STATE',
  BACKLOG: 'BACKLOG',
  TODAY: 'TODAY',
  COMPANY: 'COMPANY',
  MOCKUP: 'MOCKUP',
  HUD: 'HUD',
  TOOLS: 'TOOLS',
  PREVIEW: 'PREVIEW',
}

window.hud = window.hud || {}

// Notifications archived (per author preference). Remove the early `return` below to re-enable.
const TOASTS_ENABLED = false

function showToast(labelKey, text) {
  if (!TOASTS_ENABLED) return
  const container = $('toasts')
  if (!container) return
  const label = TOAST_LABELS[labelKey] || labelKey
  const toast = document.createElement('div')
  toast.className = `toast toast-${String(labelKey).toLowerCase()}`
  const time = new Date().toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  toast.innerHTML = `
    <div class="toast-label">▸ ${escapeHtml(label)}</div>
    <div class="toast-text">${escapeHtml(text || '')}</div>
    <div class="toast-time">${time}</div>
  `
  container.appendChild(toast)
  requestAnimationFrame(() => toast.classList.add('show'))
  setTimeout(() => {
    toast.classList.remove('show')
    setTimeout(() => toast.remove(), 400)
  }, 4500)
}

// ===== SSE =====

function setupSSE() {
  const es = new EventSource('/sse')
  es.addEventListener('hello', () => {
    console.log('🛰  SSE connected')
  })
  es.addEventListener('data-update', (e) => {
    try {
      const data = JSON.parse(e.data)
      if (data.changes && data.changes.length > 0) {
        for (const c of data.changes) {
          const text = c.path || c.filename || ''
          showToast(c.label, text)
        }
        // refresh on any change (covers state / backlog / today / status)
        refresh()
      }
    } catch (err) {
      console.error('SSE parse error', err)
    }
  })
  es.addEventListener('preview-url', (e) => {
    try {
      const data = JSON.parse(e.data)
      if (typeof data.url !== 'string' || !data.url) return
      // switch to PREVIEW tab + swap iframe URL
      if (window.hud?.showTab) window.hud.showTab('preview')
      if (window.hud?.loadPreview) window.hud.loadPreview(data.url)
      if (typeof data.viewport === 'number' && window.hud?.setPreviewViewport) {
        window.hud.setPreviewViewport(data.viewport)
      }
      showToast('PREVIEW', data.url)
    } catch (err) {
      console.error('SSE preview-url parse error', err)
    }
  })
  es.onerror = () => {
    console.warn('SSE error — EventSource will auto-reconnect')
  }
}

// ===== Daily baseline diff (4.6.5: "what changed since you opened it today") =====

const METRICS_BASELINE_KEY = 'orrith.metrics.baseline'

function todayLocalDate() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function extractMetricsValues(metrics) {
  const out = { github: {}, sentry: {}, cloudflare: {}, stripe: {}, custom: {} }
  if (metrics?.github?.repos) {
    for (const r of metrics.github.repos) {
      out.github[r.repo] = { stars: r.stars, forks: r.forks, openIssues: r.openIssues, watchers: r.watchers }
    }
  }
  if (metrics?.sentry) {
    out.sentry.unresolved = metrics.sentry.unresolvedIssues24h ?? 0
    out.sentry.projects = metrics.sentry.projects?.length ?? 0
  }
  if (metrics?.cloudflare) {
    out.cloudflare.workers = metrics.cloudflare.workers?.length ?? 0
    out.cloudflare.r2 = metrics.cloudflare.r2Buckets?.length ?? 0
    out.cloudflare.d1 = metrics.cloudflare.d1Databases?.length ?? 0
  }
  if (metrics?.stripe) {
    out.stripe.charges24h = metrics.stripe.recentCharges24h ?? 0
    out.stripe.activeSubs = metrics.stripe.activeSubscriptionsApprox ?? 0
  }
  return out
}

/** Return the baseline values from localStorage. If none exists for today, create one and return null (no diff to show). */
function loadOrCreateBaseline(metrics) {
  const today = todayLocalDate()
  let baseline = null
  try {
    const raw = localStorage.getItem(METRICS_BASELINE_KEY)
    if (raw) baseline = JSON.parse(raw)
  } catch {}

  if (!baseline || baseline.date !== today) {
    const fresh = { date: today, data: extractMetricsValues(metrics) }
    try { localStorage.setItem(METRICS_BASELINE_KEY, JSON.stringify(fresh)) } catch {}
    return null  // First visit of the day: no diff yet
  }
  return baseline.data
}

function fmtDiff(curr, prev) {
  if (prev == null || curr == null) return ''
  const d = Number(curr) - Number(prev)
  if (!Number.isFinite(d) || d === 0) return ''
  const cls = d > 0 ? 'metric-diff-up' : 'metric-diff-down'
  const sign = d > 0 ? '+' : ''
  return `<span class="metric-diff ${cls}">${sign}${d.toLocaleString()}</span>`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function fetchOne(url, fallback) {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[fetch] ${url} -> ${res.status}`)
      return fallback
    }
    return await res.json()
  } catch (e) {
    console.warn(`[fetch] ${url} failed:`, e)
    return fallback
  }
}

async function fetchAll() {
  const [roadmaps, git, tasks, actions, metrics] = await Promise.all([
    fetchOne('/api/roadmaps', { roadmaps: [] }),
    fetchOne('/api/git', { branch: '?', ahead: 0, behind: 0, modified: [], untracked: [], staged: [], error: 'fetch failed' }),
    fetchOne('/api/tasks', { error: 'fetch failed', updatedAt: null, tasks: [] }),
    fetchOne('/api/actions?limit=30', { items: [] }),
    fetchOne('/api/metrics', { fetchedAt: 0 }),
  ])
  return { roadmaps, git, tasks, actions, metrics }
}

function renderOneRoadmap(roadmap, idx) {
  const total = roadmap.steps?.length || 0
  const done = roadmap.steps?.filter((s) => s.status === 'done').length || 0
  const inProgress = roadmap.steps?.filter((s) => s.status === 'in_progress').length || 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const stepsHtml = (roadmap.steps || [])
    .map((s) => {
      const cls = `roadmap-step rstep-${s.status}${s.isCurrent ? ' rstep-current' : ''}`
      const here = s.isCurrent ? '<span class="rstep-here">← here</span>' : ''
      const body = s.body ? `<div class="rstep-body">${escapeHtml(s.body)}</div>` : ''
      return `<div class="${cls}">
        <span class="rstep-mark">${escapeHtml(s.marker)}</span>
        <div class="rstep-content">
          <div class="rstep-label">${escapeHtml(s.label)}${here}</div>
          ${body}
        </div>
      </div>`
    })
    .join('')

  return `<details class="roadmap-card"${idx === 0 ? ' open' : ''}>
    <summary class="roadmap-summary">
      <span class="roadmap-summary-name">${escapeHtml(roadmap.name)}</span>
      <span class="roadmap-summary-meta">${pct}% (${done}/${total}${inProgress > 0 ? ` · in progress ${inProgress}` : ''})</span>
    </summary>
    <div class="roadmap-card-body">
      <div class="roadmap-header">
        ${roadmap.period ? `<div class="roadmap-period">${escapeHtml(roadmap.period)}</div>` : ''}
        ${roadmap.goal ? `<div class="roadmap-goal"><span class="rgoal-key">GOAL</span> ${escapeHtml(roadmap.goal)}</div>` : ''}
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
      <div class="roadmap-steps">${stepsHtml || '<div class="empty">no steps parsed</div>'}</div>
    </div>
  </details>`
}

function renderRoadmaps(payload) {
  const el = $('roadmap')
  const list = payload?.roadmaps || []
  if (list.length === 0) {
    el.innerHTML = '<div class="empty">no roadmaps (add `## ` headings to your roadmaps.md to populate)</div>'
    return
  }

  const legend = `<div class="roadmap-legend">
    <span><span class="lg-mark">✅</span> done</span>
    <span><span class="lg-mark">🟡</span> in progress</span>
    <span><span class="lg-mark">⏳</span> pending</span>
    <span><span class="lg-mark">❌</span> cancelled</span>
  </div>`

  el.innerHTML = legend + list.map((r, i) => renderOneRoadmap(r, i)).join('')
}

function renderActions(actions) {
  if (!actions || !actions.items) return ''
  if (actions.items.length === 0) {
    return `<div class="status-section">
      <h3>▾ ACTIONS <span class="muted">(Claude tool log)</span></h3>
      <div class="status-empty">no actions logged yet (hook not wired or PostToolUse not fired)</div>
    </div>`
  }
  const rows = actions.items
    .slice(0, 30)
    .map((a) => {
      const time = (a.ts || '').slice(11, 19)
      const target = a.target ? `<span class="action-target">${escapeHtml(a.target)}</span>` : ''
      return `<div class="action-row">
        <span class="action-time">${escapeHtml(time)}</span>
        <span class="action-tool">${escapeHtml(a.tool || '?')}</span>
        ${target}
      </div>`
    })
    .join('')
  return `<div class="status-section">
    <h3>▾ ACTIONS <span class="muted">(newest first · ${actions.items.length})</span></h3>
    ${rows}
  </div>`
}

function renderStatus(git, tasks, actions) {
  const el = $('status-body')
  if (!el) return

  const fileList = (kind, files) =>
    files.length > 0
      ? files.map((f) => `<div class="file-line file-${kind}">${escapeHtml(f)}</div>`).join('')
      : '<div class="status-empty">none</div>'

  const isClean = !git.error && !git.staged?.length && !git.modified?.length && !git.untracked?.length

  const gitMeta = `<div class="status-meta">
    <span>BRANCH: <strong>${escapeHtml(git.branch || '?')}</strong></span>
    <span>AHEAD: <strong>${git.ahead ?? 0}</strong></span>
    <span>BEHIND: <strong>${git.behind ?? 0}</strong></span>
  </div>`

  const gitSection = `<div class="status-section">
    <h3>▾ GIT</h3>
    ${git.error ? `<div class="status-empty">${escapeHtml(git.error)}</div>` : gitMeta}
    ${git.staged?.length ? `<h4 class="status-sub">STAGED <span class="muted">(${git.staged.length})</span></h4>${fileList('staged', git.staged)}` : ''}
    ${git.modified?.length ? `<h4 class="status-sub">MODIFIED <span class="muted">(${git.modified.length})</span></h4>${fileList('modified', git.modified)}` : ''}
    ${git.untracked?.length ? `<h4 class="status-sub">UNTRACKED <span class="muted">(${git.untracked.length})</span></h4>${fileList('untracked', git.untracked)}` : ''}
    ${isClean ? '<div class="status-empty">working tree clean</div>' : ''}
  </div>`

  let tasksSection
  if (tasks.error || !tasks.tasks?.length) {
    tasksSection = `<div class="status-section">
      <h3>▾ TASKS</h3>
      <div class="status-empty">${escapeHtml(tasks.error || 'no tasks')}</div>
    </div>`
  } else {
    const rows = tasks.tasks
      .map(
        (t) => `<div class="task-row task-${escapeHtml(t.status)}">
        <span class="task-id">#${escapeHtml(t.id)}</span>
        <span class="task-status task-status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>
        <span class="task-subject">${escapeHtml(t.subject)}</span>
      </div>`,
      )
      .join('')
    tasksSection = `<div class="status-section">
      <h3>▾ TASKS <span class="muted">(${tasks.tasks.length})</span></h3>
      ${tasks.updatedAt ? `<div class="status-meta"><span>UPDATED: ${escapeHtml(tasks.updatedAt)}</span></div>` : ''}
      ${rows}
    </div>`
  }

  el.innerHTML = gitSection + tasksSection + renderActions(actions)
}

function updateTime() {
  const now = new Date()
  const t = now.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  $('time').textContent = t
}

function renderMetrics(metrics) {
  const el = $('metrics')
  if (!el) return
  const sections = []
  const baseline = loadOrCreateBaseline(metrics)

  // GitHub
  const github = metrics?.github
  if (github && github.repos && github.repos.length > 0) {
    const cards = github.repos.map((r) => {
      if (r.error) {
        return `<div class="metric-card metric-error">
          <div class="metric-repo">${escapeHtml(r.repo)}</div>
          <div class="metric-error-msg">${escapeHtml(r.error)}</div>
        </div>`
      }
      const pushed = r.pushedAt ? new Date(r.pushedAt).toLocaleDateString() : '-'
      const prev = baseline?.github?.[r.repo]
      return `<div class="metric-card">
        <div class="metric-repo">${escapeHtml(r.repo)}</div>
        <div class="metric-grid">
          <div class="metric-cell"><span class="metric-label">★ stars</span><span class="metric-value">${r.stars.toLocaleString()}${fmtDiff(r.stars, prev?.stars)}</span></div>
          <div class="metric-cell"><span class="metric-label">⑂ forks</span><span class="metric-value">${r.forks.toLocaleString()}${fmtDiff(r.forks, prev?.forks)}</span></div>
          <div class="metric-cell"><span class="metric-label">◉ issues</span><span class="metric-value">${r.openIssues.toLocaleString()}${fmtDiff(r.openIssues, prev?.openIssues)}</span></div>
          <div class="metric-cell"><span class="metric-label">👁 watchers</span><span class="metric-value">${r.watchers.toLocaleString()}${fmtDiff(r.watchers, prev?.watchers)}</span></div>
        </div>
        <div class="metric-meta">last push: ${escapeHtml(pushed)} · branch: ${escapeHtml(r.defaultBranch || '-')}</div>
      </div>`
    })
    const fetched = github.fetchedAt ? new Date(github.fetchedAt).toLocaleTimeString() : '-'
    sections.push(`<div class="metrics-section">
      <h3>▾ GITHUB <span class="muted">(fetched ${escapeHtml(fetched)})</span></h3>
      <div class="metrics-cards">${cards.join('')}</div>
    </div>`)
  }

  // Sentry
  const sentry = metrics?.sentry
  if (sentry) {
    const errParts = []
    if (sentry.errors?.projects) errParts.push(`projects: ${sentry.errors.projects}`)
    if (sentry.errors?.issues) errParts.push(`issues: ${sentry.errors.issues}`)
    const errBlock = errParts.length
      ? `<div class="metric-error-msg">${escapeHtml(errParts.join(' · '))}</div>`
      : ''
    const platforms = new Set(sentry.projects.map((p) => p.platform).filter(Boolean))
    const projectList = sentry.projects.length
      ? `<div class="metric-meta">${sentry.projects.map((p) => escapeHtml(p.slug)).join(' · ')}</div>`
      : ''
    const sPrev = baseline?.sentry
    const card = `<div class="metric-card${errParts.length ? ' metric-error' : ''}">
      <div class="metric-repo">org ${escapeHtml(sentry.orgSlug)}</div>
      <div class="metric-grid">
        <div class="metric-cell"><span class="metric-label">📦 projects</span><span class="metric-value">${sentry.projects.length}${fmtDiff(sentry.projects.length, sPrev?.projects)}</span></div>
        <div class="metric-cell"><span class="metric-label">▲ unresolved 24h</span><span class="metric-value">${sentry.unresolvedIssues24h ?? '-'}${fmtDiff(sentry.unresolvedIssues24h, sPrev?.unresolved)}</span></div>
        <div class="metric-cell"><span class="metric-label">platforms</span><span class="metric-value">${platforms.size}</span></div>
      </div>
      ${projectList}
      ${errBlock}
    </div>`
    const fetched = sentry.fetchedAt ? new Date(sentry.fetchedAt).toLocaleTimeString() : '-'
    sections.push(`<div class="metrics-section">
      <h3>▾ SENTRY <span class="muted">(fetched ${escapeHtml(fetched)})</span></h3>
      <div class="metrics-cards">${card}</div>
    </div>`)
  }

  // Stripe
  const stripe = metrics?.stripe
  if (stripe) {
    const errParts = []
    if (stripe.errors?.balance) errParts.push(`balance: ${stripe.errors.balance}`)
    if (stripe.errors?.subscriptions) errParts.push(`subs: ${stripe.errors.subscriptions}`)
    if (stripe.errors?.charges) errParts.push(`charges: ${stripe.errors.charges}`)
    const errBlock = errParts.length
      ? `<div class="metric-error-msg">${escapeHtml(errParts.join(' · '))}</div>`
      : ''
    const fmtMoney = (lines) => {
      if (!lines || lines.length === 0) return '$0'
      return lines.map((l) => {
        const code = l.currency.toUpperCase()
        const display = ['JPY', 'KRW'].includes(code) ? l.amount : (l.amount / 100).toFixed(2)
        return `${display} ${code}`
      }).join(' / ')
    }
    const subsLabel = stripe.activeSubscriptionsHasMore ? `${stripe.activeSubscriptionsApprox}+` : `${stripe.activeSubscriptionsApprox}`
    const mode = stripe.livemode === false ? ' <span class="metric-badge">test</span>' : ''
    const card = `<div class="metric-card${errParts.length ? ' metric-error' : ''}">
      <div class="metric-repo">stripe${mode}</div>
      <div class="metric-grid">
        <div class="metric-cell"><span class="metric-label">💳 active subs</span><span class="metric-value">${subsLabel}</span></div>
        <div class="metric-cell"><span class="metric-label">⚡ charges 24h</span><span class="metric-value">${stripe.recentCharges24h}</span></div>
        <div class="metric-cell"><span class="metric-label">$ available</span><span class="metric-value metric-money">${escapeHtml(fmtMoney(stripe.balanceAvailable))}</span></div>
        <div class="metric-cell"><span class="metric-label">… pending</span><span class="metric-value metric-money">${escapeHtml(fmtMoney(stripe.balancePending))}</span></div>
      </div>
      ${stripe.recentChargesAmount24h.length ? `<div class="metric-meta">24h revenue: ${escapeHtml(fmtMoney(stripe.recentChargesAmount24h))}</div>` : ''}
      ${errBlock}
    </div>`
    const fetched = stripe.fetchedAt ? new Date(stripe.fetchedAt).toLocaleTimeString() : '-'
    sections.push(`<div class="metrics-section">
      <h3>▾ STRIPE <span class="muted">(fetched ${escapeHtml(fetched)})</span></h3>
      <div class="metrics-cards">${card}</div>
    </div>`)
  }

  // Cloudflare
  const cf = metrics?.cloudflare
  if (cf) {
    const errParts = []
    if (cf.errors?.workers) errParts.push(`workers: ${cf.errors.workers}`)
    if (cf.errors?.r2) errParts.push(`r2: ${cf.errors.r2}`)
    if (cf.errors?.d1) errParts.push(`d1: ${cf.errors.d1}`)
    const errBlock = errParts.length
      ? `<div class="metric-error-msg">${escapeHtml(errParts.join(' · '))}</div>`
      : ''
    const cPrev = baseline?.cloudflare
    const card = `<div class="metric-card${errParts.length ? ' metric-error' : ''}">
      <div class="metric-repo">account ${escapeHtml(cf.accountId.slice(0, 8))}…</div>
      <div class="metric-grid">
        <div class="metric-cell"><span class="metric-label">⚡ workers</span><span class="metric-value">${cf.workers.length}${fmtDiff(cf.workers.length, cPrev?.workers)}</span></div>
        <div class="metric-cell"><span class="metric-label">🪣 r2 buckets</span><span class="metric-value">${cf.r2Buckets.length}${fmtDiff(cf.r2Buckets.length, cPrev?.r2)}</span></div>
        <div class="metric-cell"><span class="metric-label">🗄 d1 dbs</span><span class="metric-value">${cf.d1Databases.length}${fmtDiff(cf.d1Databases.length, cPrev?.d1)}</span></div>
        <div class="metric-cell"><span class="metric-label">total resources</span><span class="metric-value">${cf.workers.length + cf.r2Buckets.length + cf.d1Databases.length}</span></div>
      </div>
      ${errBlock}
    </div>`
    const fetched = cf.fetchedAt ? new Date(cf.fetchedAt).toLocaleTimeString() : '-'
    sections.push(`<div class="metrics-section">
      <h3>▾ CLOUDFLARE <span class="muted">(fetched ${escapeHtml(fetched)})</span></h3>
      <div class="metrics-cards">${card}</div>
    </div>`)
  }

  // Custom adapters
  const custom = metrics?.custom
  if (custom && Array.isArray(custom)) {
    for (const entry of custom) {
      const r = entry.result || {}
      const errBlock = r.error
        ? `<div class="metric-error-msg">${escapeHtml(r.error)}</div>`
        : ''
      const fields = Array.isArray(r.fields) ? r.fields : []
      const fieldsHtml = fields.length
        ? `<div class="metric-grid">${fields.map((f) => `
            <div class="metric-cell">
              <span class="metric-label">${escapeHtml(f.label || '')}</span>
              <span class="metric-value">${escapeHtml(String(f.value ?? ''))}</span>
              ${f.sub ? `<span class="metric-label">${escapeHtml(f.sub)}</span>` : ''}
            </div>`).join('')}</div>`
        : ''
      const metaBlock = r.meta ? `<div class="metric-meta">${escapeHtml(r.meta)}</div>` : ''
      const card = `<div class="metric-card${r.error ? ' metric-error' : ''}">
        <div class="metric-repo">${escapeHtml(entry.name)}</div>
        ${fieldsHtml}
        ${metaBlock}
        ${errBlock}
      </div>`
      const fetched = r.fetchedAt ? new Date(r.fetchedAt).toLocaleTimeString() : '-'
      sections.push(`<div class="metrics-section">
        <h3>▾ ${escapeHtml(entry.label || entry.name.toUpperCase())} <span class="muted">(fetched ${escapeHtml(fetched)})</span></h3>
        <div class="metrics-cards">${card}</div>
      </div>`)
    }
  }

  if (sections.length === 0) {
    el.innerHTML = '<div class="empty">no metrics configured (set <code>metrics.github</code>, <code>metrics.cloudflare</code>, or <code>metrics.custom</code> in orrith.config.js)</div>'
    return
  }
  el.innerHTML = sections.join('')
}

async function refresh() {
  try {
    const data = await fetchAll()
    renderRoadmaps(data.roadmaps)
    renderMetrics(data.metrics)
    renderStatus(data.git, data.tasks, data.actions)
    $('status').textContent = '● ONLINE'
    $('status').style.color = 'var(--ok)'
  } catch (err) {
    console.error(err)
    $('status').textContent = '● ERROR'
    $('status').style.color = 'var(--danger)'
  }
}

// ===== preview (internal browser) =====

const PREVIEW_URL_KEY = 'hud:preview:lastUrl'
const PREVIEW_VP_KEY = 'hud:preview:viewport'
const HUD_MODE_KEY = 'hud:mode'

function setupPreview() {
  const form = $('preview-url-form')
  const input = $('preview-url')
  const frame = $('preview-frame')
  const wrap = frame?.parentElement
  const emptyHint = $('preview-empty')
  const presets = $('preview-presets')
  const viewports = $('preview-viewports')
  if (!form || !input || !frame) return

  function load(url) {
    if (!url) return
    input.value = url
    frame.src = url
    frame.classList.remove('is-empty')
    if (emptyHint) emptyHint.classList.add('is-hidden')
    try {
      localStorage.setItem(PREVIEW_URL_KEY, url)
    } catch {}
  }

  function setViewport(vp) {
    const w = parseInt(vp, 10)
    if (!wrap) return
    wrap.style.setProperty('--vp-width', w > 0 ? `${w}px` : '100%')
    viewports?.querySelectorAll('.preview-vp').forEach((b) => {
      b.classList.toggle('preview-vp-active', b.dataset.viewport === String(w))
    })
    try {
      localStorage.setItem(PREVIEW_VP_KEY, String(w))
    } catch {}
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    load(input.value.trim())
  })

  presets?.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    const action = target.dataset.action
    const url = target.dataset.url
    if (action === 'reload') {
      const current = frame.getAttribute('src')
      if (current) frame.src = current
      return
    }
    if (action === 'open') {
      const current = frame.getAttribute('src') || input.value.trim()
      if (current) window.open(current, '_blank', 'noopener')
      return
    }
    if (url) load(url)
  })

  viewports?.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    const vp = target.dataset.viewport
    if (vp !== undefined) setViewport(vp)
  })

  // restore
  try {
    const last = localStorage.getItem(PREVIEW_URL_KEY)
    if (last) load(last)
    const vp = localStorage.getItem(PREVIEW_VP_KEY)
    if (vp) setViewport(vp)
  } catch {}

  // expose for SSE-driven auto push
  window.hud.loadPreview = load
  window.hud.setPreviewViewport = setViewport
}

// ===== tabs =====

const HUD_TAB_KEY = 'hud:tab'
const TAB_IDS = ['roadmap', 'metrics', 'status', 'preview']

function setupTabs() {
  const tabs = document.querySelectorAll('.hud-tab')
  const panels = document.querySelectorAll('.panel[data-tab]')
  if (!tabs.length || !panels.length) return

  function showTab(id) {
    if (!TAB_IDS.includes(id)) id = 'today'
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === id))
    panels.forEach((p) => p.classList.toggle('is-tab-hidden', p.dataset.tab !== id))
    try {
      localStorage.setItem(HUD_TAB_KEY, id)
    } catch {}
  }

  tabs.forEach((t) =>
    t.addEventListener('click', () => {
      const id = t.dataset.tab
      if (id) showTab(id)
    }),
  )

  function getCurrentTabIdx() {
    const saved = (() => {
      try {
        return localStorage.getItem(HUD_TAB_KEY)
      } catch {
        return null
      }
    })()
    const idx = TAB_IDS.indexOf(saved || 'today')
    return idx >= 0 ? idx : 0
  }

  // Cmd+←/→ for prev/next tab, Cmd+1..5 to jump to a specific tab
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = getCurrentTabIdx()
      const next = (cur - 1 + TAB_IDS.length) % TAB_IDS.length
      showTab(TAB_IDS[next])
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const cur = getCurrentTabIdx()
      const next = (cur + 1) % TAB_IDS.length
      showTab(TAB_IDS[next])
      return
    }
    const idx = parseInt(e.key, 10) - 1
    if (idx >= 0 && idx < TAB_IDS.length) {
      e.preventDefault()
      showTab(TAB_IDS[idx])
    }
  })

  // restore
  let saved = null
  try {
    saved = localStorage.getItem(HUD_TAB_KEY)
  } catch {}
  showTab(saved || 'roadmap')

  // expose for SSE-driven auto push
  window.hud.showTab = showTab
}

// ===== Service Worker (for PWA install) =====

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => console.log('🛡  SW registered:', reg.scope))
      .catch((err) => console.warn('SW registration failed', err))
  })
}

// Apply preset: localStorage (user choice) > server config > default 'pixel'
const PRESET_KEY = 'orrith.preset'
const VALID_PRESETS = ['pixel', 'visor', 'monolith', 'doodle', 'minimal']

async function applyPreset() {
  let preset = null
  try {
    const saved = localStorage.getItem(PRESET_KEY)
    if (saved && VALID_PRESETS.includes(saved)) preset = saved
  } catch {}
  if (!preset) {
    try {
      const res = await fetch('/api/config')
      if (res.ok) {
        const cfg = await res.json()
        if (cfg.preset && VALID_PRESETS.includes(cfg.preset)) preset = cfg.preset
      }
    } catch {}
  }
  preset = preset || 'pixel'
  document.body.dataset.preset = preset
  const select = document.getElementById('preset-select')
  if (select) select.value = preset
}

function setupPresetSelect() {
  const select = document.getElementById('preset-select')
  if (!select) return
  select.addEventListener('change', (e) => {
    const v = e.target.value
    if (!VALID_PRESETS.includes(v)) return
    document.body.dataset.preset = v
    try { localStorage.setItem(PRESET_KEY, v) } catch {}
  })
}

setInterval(updateTime, 1000)
setInterval(refresh, REFRESH_FALLBACK_MS)
updateTime()
applyPreset()
setupPresetSelect()
refresh()
// preview-url SSE depends on window.hud.showTab/loadPreview, so initialize tabs/preview first
setupTabs()
setupPreview()
setupSSE()
