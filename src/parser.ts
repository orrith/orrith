import { readFileSync, existsSync } from 'node:fs'

// ===== Types =====

export type SprintStep = { done: boolean; label: string }
export type Sprint = { name: string; steps: SprintStep[] }
export type StateData = {
  phase: string | null
  sprint: Sprint | null
  lastUpdated: string | null
}
export type CategoryStatus = 'ACTIVE' | 'PENDING' | 'FROZEN'
export type BacklogCategory = {
  id: string
  label: string
  status: CategoryStatus
  statusReason: string | null
  total: number
  done: number
  inSprint: number
  undone: number
}
export type BacklogSummary = {
  active: { total: number; undone: number; inSprint: number; done: number }
  pending: { total: number; undone: number; inSprint: number; done: number }
  frozen: { total: number; undone: number; inSprint: number; done: number }
}
export type BacklogData = { categories: BacklogCategory[]; summary: BacklogSummary }
export type TodosData = {
  date: string
  undone: string[]
  done: string[]
}
export type RoadmapStepStatus = 'done' | 'in_progress' | 'pending' | 'cancelled'
export type RoadmapStep = {
  status: RoadmapStepStatus
  marker: string
  label: string
  body: string | null
  isCurrent: boolean
}
export type RoadmapData = {
  name: string | null
  period: string | null
  goal: string | null
  steps: RoadmapStep[]
}

export interface StateParserConfig {
  phaseSection: string
  roadmapSection: string
}

export interface BacklogParserConfig {
  categoryRegex: string
}

const DEFAULT_STATE: StateParserConfig = { phaseSection: 'Current Phase', roadmapSection: 'Current Roadmap' }
const DEFAULT_BACKLOG: BacklogParserConfig = { categoryRegex: '^##\\s+([A-Z])\\.\\s+([^\\n]+)' }

// ===== Helpers =====

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findUpdatedLine(content: string): string | null {
  // Try common patterns: "Last Updated:", "**最終更新**:", "Updated:"
  const patterns = [
    /\*\*(?:Last Updated|Updated|最終更新)\*\*[:：]\s*([^\n]+)/,
    /(?:^|\n)(?:Last Updated|Updated|最終更新)[:：]\s*([^\n]+)/i,
  ]
  for (const re of patterns) {
    const m = content.match(re)
    if (m) return m[1].trim()
  }
  return null
}

function parseStepBlock(block: string): RoadmapStep[] {
  const steps: RoadmapStep[] = []
  const stepRegex = /^\s*-\s*(✅|🟡|⏳|❌)\s*Step\s*([\d.]+)[:：]?\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = stepRegex.exec(block)) !== null) {
    const marker = m[1]
    const status: RoadmapStepStatus =
      marker === '✅' ? 'done' : marker === '🟡' ? 'in_progress' : marker === '⏳' ? 'pending' : 'cancelled'
    const num = m[2]
    const rest = m[3].trim()
    const isCurrent = /←\s*(今ここ|here|now)/i.test(rest)
    const cleanedRest = rest.replace(/\s*←\s*(?:今ここ|here|now).*$/i, '').trim()
    const titleMatch = cleanedRest.match(/^(.+?)(?:（(.+)）)?$/)
    const title = titleMatch ? titleMatch[1].trim() : cleanedRest
    const body = titleMatch && titleMatch[2] ? titleMatch[2].trim() : null
    steps.push({ status, marker, label: `Step ${num}: ${title}`, body, isCurrent })
  }
  return steps
}

// ===== Public parsers =====

export function parseState(filePath: string, config: StateParserConfig = DEFAULT_STATE): StateData {
  if (!existsSync(filePath)) return { phase: null, sprint: null, lastUpdated: null }
  const content = readFileSync(filePath, 'utf-8')

  const phaseHeader = escapeRegex(config.phaseSection)
  const phaseRe = new RegExp(`##\\s*${phaseHeader}\\s*\\n+\\s*\\*\\*([^*]+)\\*\\*`)
  const phaseMatch = content.match(phaseRe)
  const phase = phaseMatch ? phaseMatch[1].trim() : null

  const lastUpdated = findUpdatedLine(content)

  const roadmapHeader = escapeRegex(config.roadmapSection)
  const roadmapRe = new RegExp(`##\\s*${roadmapHeader}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|\\n---\\n)`)
  const roadmapBlockMatch = content.match(roadmapRe)
  let sprint: Sprint | null = null
  if (roadmapBlockMatch) {
    const block = roadmapBlockMatch[1]
    const nameMatch = block.match(/\*\*([^*]+)\*\*/)
    if (nameMatch) {
      const stepLineRegex = /^\s*-\s*([✅🟡⏳❌])\s*Step\s*([\d.]+)[:：]?\s*(.+)$/gm
      const steps: SprintStep[] = []
      let m: RegExpExecArray | null
      while ((m = stepLineRegex.exec(block)) !== null) {
        steps.push({ done: m[1] === '✅', label: `Step ${m[2]}: ${m[3].trim()}` })
      }
      sprint = { name: nameMatch[1].trim(), steps }
    }
  }

  return { phase, sprint, lastUpdated }
}

export function parseBacklog(filePath: string, config: BacklogParserConfig = DEFAULT_BACKLOG): BacklogData {
  const empty: BacklogSummary = {
    active: { total: 0, undone: 0, inSprint: 0, done: 0 },
    pending: { total: 0, undone: 0, inSprint: 0, done: 0 },
    frozen: { total: 0, undone: 0, inSprint: 0, done: 0 },
  }
  if (!existsSync(filePath)) return { categories: [], summary: empty }
  const content = readFileSync(filePath, 'utf-8')

  // Strip archive section (matches `## アーカイブ` or `## Archive`)
  const activeContent = content.split(/^##\s*(?:アーカイブ|Archive)/m)[0]

  const categories: BacklogCategory[] = []
  // Use config.categoryRegex to extract id + heading. Then split body by next category or ---.
  const headingRe = new RegExp(config.categoryRegex, 'gm')
  const headings: { id: string; rest: string; index: number }[] = []
  let hm: RegExpExecArray | null
  while ((hm = headingRe.exec(activeContent)) !== null) {
    headings.push({ id: hm[1], rest: hm[2].trim(), index: hm.index })
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const start = h.index + activeContent.slice(h.index).indexOf('\n') + 1
    const end = i < headings.length - 1 ? headings[i + 1].index : activeContent.length
    const body = activeContent.slice(start, end)

    const statusMatch = h.rest.match(/\[(ACTIVE|PENDING|FROZEN)(?::([^\]]+))?\]/)
    const status: CategoryStatus = (statusMatch?.[1] as CategoryStatus) ?? 'ACTIVE'
    const statusReason = statusMatch?.[2]?.trim() ?? null
    const label = h.rest.replace(/\[(ACTIVE|PENDING|FROZEN)(?::[^\]]+)?\]/, '').trim()

    const done = (body.match(/`?\[x\]`?/g) || []).length
    const inSprint = (body.match(/`?\[S\d+\]`?/g) || []).length
    const undone = (body.match(/`?\[\s\]`?/g) || []).length
    const total = done + inSprint + undone

    categories.push({ id: h.id, label, status, statusReason, total, done, inSprint, undone })
  }

  const summary: BacklogSummary = {
    active: { total: 0, undone: 0, inSprint: 0, done: 0 },
    pending: { total: 0, undone: 0, inSprint: 0, done: 0 },
    frozen: { total: 0, undone: 0, inSprint: 0, done: 0 },
  }
  for (const c of categories) {
    const bucket = c.status === 'ACTIVE' ? summary.active : c.status === 'PENDING' ? summary.pending : summary.frozen
    bucket.total += c.total
    bucket.undone += c.undone
    bucket.inSprint += c.inSprint
    bucket.done += c.done
  }

  return { categories, summary }
}

export function parseTodos(filePath: string, date: string): TodosData {
  if (!existsSync(filePath)) return { date, undone: [], done: [] }
  const content = readFileSync(filePath, 'utf-8')
  const undone: string[] = []
  const done: string[] = []
  for (const line of content.split('\n')) {
    const undoneMatch = line.match(/^\s*-\s*\[\s\]\s*(.+)/)
    const doneMatch = line.match(/^\s*-\s*\[x\]\s*(.+)/)
    if (undoneMatch) undone.push(cleanText(undoneMatch[1]))
    else if (doneMatch) done.push(cleanText(doneMatch[1]))
  }
  return { date, undone, done }
}

function cleanText(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s*\|\s*(?:優先度|priority):\s*\S+/gi, '')
    .replace(/\s*\|\s*(?:期限|due):\s*\S+/gi, '')
    .trim()
}

export function parseRoadmap(filePath: string, config: StateParserConfig = DEFAULT_STATE): RoadmapData {
  const empty: RoadmapData = { name: null, period: null, goal: null, steps: [] }
  if (!existsSync(filePath)) return empty
  const content = readFileSync(filePath, 'utf-8')

  const roadmapHeader = escapeRegex(config.roadmapSection)
  const blockRe = new RegExp(`##\\s*${roadmapHeader}\\s*\\n+([\\s\\S]*?)(?=\\n---\\n)`)
  const blockMatch = content.match(blockRe)
  if (!blockMatch) return empty
  const block = blockMatch[1]

  const headerMatch = block.match(/\*\*([^*]+)\*\*(?:[\s\S]*?（([^）]+)）)?/)
  const name = headerMatch ? headerMatch[1].trim() : null
  const period = headerMatch && headerMatch[2] ? headerMatch[2].replace(/\*\*/g, '').trim() : null

  const goalMatch = block.match(/-\s*\*\*(?:ゴール|Goal)[^*]*\*\*[:：]\s*([^\n]+)/i)
  const goal = goalMatch ? goalMatch[1].replace(/\*\*/g, '').trim() : null

  return { name, period, goal, steps: parseStepBlock(block) }
}

export function parseRoadmaps(filePath: string): RoadmapData[] {
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf-8')

  // strip frontmatter
  const body = content.replace(/^---[\s\S]*?\n---\n/, '')
  const sections = body.split(/^##\s+/m).slice(1)
  const roadmaps: RoadmapData[] = []

  for (const section of sections) {
    const headingMatch = section.match(/^([^\n]+)\n/)
    if (!headingMatch) continue
    const heading = headingMatch[1].trim()

    // skip operational sections (multilingual)
    if (/^(凡例|運用ルール|アーカイブ|廃案|参照|関連|Legend|Operation|Archive|Cancelled|References|Related)/i.test(heading)) continue

    const block = section.slice(headingMatch[0].length)

    const periodMatch = block.match(/-\s*\*\*(?:期間|Period)\*\*[:：]\s*([^\n]+)/i)
    const period = periodMatch ? periodMatch[1].replace(/\*\*/g, '').trim() : null

    const goalMatch = block.match(/-\s*\*\*(?:ゴール|Goal)\*\*[:：]\s*([^\n]+)/i)
    const goal = goalMatch ? goalMatch[1].replace(/\*\*/g, '').trim() : null

    const steps = parseStepBlock(block)
    if (steps.length === 0 && !goal && !period) continue

    roadmaps.push({ name: heading, period, goal, steps })
  }

  return roadmaps
}
