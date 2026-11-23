// Bounded passive activity reader for live sessions only. Cold reads use a
// tail, then consume append-only bytes. Never executes harness commands.
import { antigravityConversation, antigravitySessionId } from './antigravityLogs'
import fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { supportsActivity, type ActivitySession } from './sessionActivityProtocol'
import type { AgentActivity, SessionActivity, SubagentActivity } from '../shared/activity'
import { activitySnapshot, newActivityState, reduceActivity, type ActivityState } from './activityReducer'
import { getSubagentLogPaths } from './subagentLogs'

const READ_LIMIT = 256 * 1024
const CACHE_LIMIT = 2048
const SUMMARY_LIMIT = 20_000
const DETAIL_LIMIT = 40
const CHILD_READ_LIMIT = 256
const STALE_MS = 15 * 60 * 1000
// Between full passes only the last selection and new paths are re-stat'ed,
// so a resumed old child can take this long to enter the read cap.
const FULL_RANK_MS = 30 * 1000
const STAT_PROGRESS_EVERY = 64
const CLAUDE_HOT_LIMIT = 16
const CLAUDE_STAT_BATCH = 16
const CLAUDE_BACKFILL_RESERVE = 32
interface Cursor {
  state: ActivityState
  offset: number
  remainder: Buffer
  discardLine: boolean
  ino: number
  mtime: number
}

interface Summary {
  ino: number
  size: number
  mtime: number
  name?: string
  activity: AgentActivity
}
interface Ranking {
  at: number
  listed: Set<string>
  selected: string[]
}
interface Revision {
  ino: number
  size: number
  mtime: number
}
interface ClaudeMetadata {
  name?: string
  completion?: 'Stopped' | 'Turn finished'
}
interface ClaudeObservation {
  log: Revision | null
  meta: Revision | null
  metadata?: ClaudeMetadata | null
  transcript: AgentActivity
  name?: string
  child: SubagentActivity
}
interface ClaudeCandidate {
  logPath: string
  log: Revision | null
  meta?: Revision | null
}
interface ClaudeRanking {
  at: number
  children: Map<string, ClaudeObservation | undefined>
  hot: Set<string>
  pending: Map<string, ClaudeCandidate>
}

const unknown = (): AgentActivity => ({ phase: 'unknown', label: 'Activity unknown', tools: [] })

export class SessionActivityTracker {
  private cursors = new Map<string, Cursor>()
  // Completed, unchanged transcripts need no cold-tail replay after a cursor
  // eviction. These records retain no partial lines or pending-call maps.
  private summaries = new Map<string, Summary>()
  // One compact observation per listed child of a currently live parent.
  private claudeRankings = new Map<string, ClaudeRanking>()
  // Per parent log: which children the last capped scan read.
  private rankings = new Map<string, Ranking>()

  constructor(private readonly progress?: () => void, private readonly cursorLimit = CACHE_LIMIT) {}

  private async read(logPath: string, kind: 'claude' | 'codex' | 'antigravity'): Promise<AgentActivity> {
    let file
    try {
      file = await fs.open(logPath, 'r')
      const stat = await file.stat()
      let cursor = this.cursors.get(logPath)
      const cached = this.summaries.get(logPath)
      if (!cursor && cached && cached.ino === stat.ino && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
        return observed(cached.activity)
      }
      if (!cursor || cursor.ino !== stat.ino || stat.size < cursor.offset ||
        (stat.size === cursor.offset && stat.mtimeMs !== cursor.mtime)) {
        cursor = { state: newActivityState(), offset: Math.max(0, stat.size - READ_LIMIT), remainder: Buffer.alloc(0), discardLine: false, ino: stat.ino, mtime: stat.mtimeMs }
        // A cold tail starts mid-line. Drop it, even if it happens to parse.
        if (cursor.offset > 0) cursor.discardLine = true
      }
      if (stat.size > cursor.offset) {
        // If the consumer falls far behind, resync to a bounded tail and
        // discard prior state rather than claiming continuity across a gap.
        if (stat.size - cursor.offset > READ_LIMIT) {
          cursor = { state: newActivityState(), offset: stat.size - READ_LIMIT, remainder: Buffer.alloc(0), discardLine: true, ino: stat.ino, mtime: stat.mtimeMs }
        }
        const buffer = Buffer.alloc(Math.min(READ_LIMIT, stat.size - cursor.offset))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset)
        const bytes = Buffer.concat([cursor.remainder, buffer.subarray(0, bytesRead)])
        let start = 0
        for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, start)) {
          if (cursor.discardLine) cursor.discardLine = false
          else if (end - start <= READ_LIMIT) {
            try { reduceActivity(cursor.state, JSON.parse(bytes.toString('utf8', start, end)), kind) } catch { /* corrupt envelope */ }
          } else cursor.state = newActivityState()
          start = end + 1
        }
        cursor.remainder = Buffer.from(bytes.subarray(start))
        if (cursor.remainder.length > READ_LIMIT) {
          cursor.remainder = Buffer.alloc(0)
          cursor.discardLine = true
          cursor.state = newActivityState()
        }
        cursor.offset += bytesRead
      }
      cursor.mtime = stat.mtimeMs
      this.cursors.delete(logPath)
      this.cursors.set(logPath, cursor)
      while (this.cursors.size > this.cursorLimit) this.cursors.delete(this.cursors.keys().next().value!)
      const activity = activitySnapshot(cursor.state)
      this.summaries.delete(logPath)
      this.summaries.set(logPath, { ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, name: cursor.state.name, activity })
      if (this.summaries.size > SUMMARY_LIMIT) this.summaries.delete(this.summaries.keys().next().value!)
      return observed(activity)
    } catch {
      this.cursors.delete(logPath)
      this.summaries.delete(logPath)
      return unknown()
    } finally {
      await file?.close()
      this.progress?.()
    }
  }

  private async readClaudeChild(
    { logPath, log, meta }: ClaudeCandidate,
    last: ClaudeObservation | undefined,
  ): Promise<ClaudeObservation> {
    const id = childId(logPath)
    const reuseTranscript = last && sameRevision(last.log, log)
    if (!log) {
      this.cursors.delete(logPath)
      this.summaries.delete(logPath)
    }
    const transcript = reuseTranscript ? last.transcript : log ? await this.read(logPath, 'claude') : unknown()
    const summary = this.summaries.get(logPath)
    const name = reuseTranscript ? last.name : log ? summary?.name : undefined
    const sidecar = meta === undefined ? await statRevision(metaPath(logPath)) : meta
    const metadata = last && last.metadata !== null && sameRevision(last.meta, sidecar)
      ? last.metadata : await readClaudeMetadata(logPath, sidecar)
    // The sidecar can only override lifecycle evidence if strictly newer.
    const transcriptRevision = reuseTranscript ? last.log : log && summary ? summary : null
    const activity = metadata?.completion && sidecar && transcriptRevision && sidecar.mtime > transcriptRevision.mtime
      ? { ...transcript, phase: 'idle' as const, label: metadata.completion, tools: [] }
      : transcript
    return {
      log: transcriptRevision, meta: sidecar, metadata, transcript, name,
      child: { id, name: metadata?.name ?? name ?? id, activity },
    }
  }

  private async claudeChildren(parentLog: string, paths: string[]): Promise<SubagentActivity[]> {
    const now = Date.now()
    let ranking = this.claudeRankings.get(parentLog)
    const initial = !ranking
    if (!ranking) {
      ranking = { at: now, children: new Map(), hot: new Set(), pending: new Map() }
      this.claudeRankings.set(parentLog, ranking)
    }
    const { children, hot, pending } = ranking
    const listed = new Set(paths)
    for (const logPath of children.keys()) {
      if (listed.has(logPath)) continue
      children.delete(logPath)
      pending.delete(logPath)
      hot.delete(logPath)
      this.cursors.delete(logPath)
      this.summaries.delete(logPath)
    }

    const full = initial || now - ranking.at >= FULL_RANK_MS
    if (full) ranking.at = now
    const probes: { logPath: string; fresh: boolean; live: boolean; last: ClaudeObservation | undefined }[] = []
    for (const logPath of paths) {
      const fresh = !children.has(logPath)
      const last = children.get(logPath)
      const live = !!last && isLive(observed(last.child.activity))
      if (full || paths.length <= CLAUDE_HOT_LIMIT || fresh || live || hot.has(logPath)) probes.push({ logPath, fresh, live, last })
      if (fresh) children.set(logPath, undefined)
    }
    const urgent: (ClaudeCandidate & { live: boolean })[] = []
    for (let offset = 0; offset < probes.length; offset += CLAUDE_STAT_BATCH) {
      const batch = await Promise.all(probes.slice(offset, offset + CLAUDE_STAT_BATCH).map(async probe => ({
        ...probe,
        log: await statRevision(probe.logPath),
        meta: probe.last ? await statRevision(metaPath(probe.logPath)) : undefined,
      })))
      for (const { logPath, fresh, live, last, log, meta } of batch) {
        if (last && last.metadata !== null && sameRevision(last.log, log) && sameRevision(last.meta, meta)) {
          pending.delete(logPath)
          continue
        }
        const prior = pending.get(logPath)
        const candidate = { logPath, log, meta }
        pending.set(logPath, candidate)
        const changedWhilePending = prior && !sameRevision(prior.log, log)
        if (fresh || live || last || changedWhilePending || hot.has(logPath)) urgent.push({ ...candidate, live })
      }
      if ((offset + CLAUDE_STAT_BATCH) % STAT_PROGRESS_EVERY === 0) this.progress?.()
    }

    // A small set of recent children is checked closely even after they
    // report idle. A slow sweep drops hot entries that have gone quiet.
    const nextHot = urgent.sort(recentFirst).slice(0, CLAUDE_HOT_LIMIT).map(candidate => candidate.logPath)
    ranking.hot = new Set([...new Set([...nextHot, ...(full ? [] : hot)])].slice(0, CLAUDE_HOT_LIMIT))
    urgent.sort((a, b) => Number(b.live) - Number(a.live) || recentFirst(a, b))
    // Reserve room on slow sweeps for paths that would otherwise stay behind
    // the active set indefinitely. Map insertion order is maintained even as
    // we update queued revisions on subsequent sweeps.
    const urgentLimit = full && !initial ? CHILD_READ_LIMIT - CLAUDE_BACKFILL_RESERVE : CHILD_READ_LIMIT
    const selected = new Map<string, ClaudeCandidate>(urgent.slice(0, urgentLimit).map(candidate => [candidate.logPath, candidate]))
    if (full && !initial) {
      for (const [logPath, candidate] of pending) {
        if (selected.size === CHILD_READ_LIMIT) break
        if (!selected.has(logPath)) selected.set(logPath, candidate)
      }
    }
    // Sequential async reads keep filesystem fanout bounded.
    for (const [logPath, candidate] of selected) {
      children.set(logPath, await this.readClaudeChild(candidate, children.get(logPath)))
      pending.delete(logPath)
      this.progress?.()
    }
    const result: SubagentActivity[] = []
    for (const [logPath, last] of children) {
      if (last && !pending.has(logPath)) result.push({ ...last.child, activity: observed(last.child.activity) })
    }
    return result
  }

  // Long-lived sessions accumulate thousands of finished children. The read
  // cap keeps children last seen working, then the most recently written,
  // rather than whichever names sort first. A full stat pass runs at most
  // every FULL_RANK_MS; between passes only the previous selection and newly
  // listed paths are re-stat'ed.
  private async select(parentLog: string, paths: string[]): Promise<string[]> {
    if (paths.length <= CHILD_READ_LIMIT) {
      this.rankings.delete(parentLog)
      return paths
    }
    const now = Date.now()
    const prev = this.rankings.get(parentLog)
    const candidates = !prev || now - prev.at >= FULL_RANK_MS ? paths
      : [...new Set([...prev.selected, ...paths.filter(p => !prev.listed.has(p))])]
    const current = new Set(paths)
    const stamped: { logPath: string; live: boolean; mtime: number }[] = []
    for (const logPath of candidates) {
      if (!current.has(logPath)) continue
      let mtime = -Infinity
      try { mtime = (await fs.stat(logPath)).mtimeMs } catch { /* missing files sort last */ }
      const last = this.summaries.get(logPath)
      const live = !!last && isLive(observed(last.activity))
      stamped.push({ logPath, live, mtime })
      if (stamped.length % STAT_PROGRESS_EVERY === 0) this.progress?.()
    }
    stamped.sort((a, b) => Number(b.live) - Number(a.live) || b.mtime - a.mtime || a.logPath.localeCompare(b.logPath))
    const selected = stamped.slice(0, CHILD_READ_LIMIT).map(s => s.logPath)
    this.rankings.delete(parentLog)
    this.rankings.set(parentLog, { at: prev && candidates !== paths ? prev.at : now, listed: current, selected })
    while (this.rankings.size > CHILD_READ_LIMIT) this.rankings.delete(this.rankings.keys().next().value!)
    return selected
  }

  async enrich<T extends ActivitySession>(sessions: T[]): Promise<(T & { activity?: SessionActivity })[]> {
    const result: (T & { activity?: SessionActivity })[] = []
    const activeClaudeParents = new Set<string>()
    for (const session of sessions) {
      if (!supportsActivity(session)) {
        result.push(session)
        continue
      }
      const kind = session.agentType as 'claude' | 'codex' | 'antigravity'
      const parentLog = session.logFilePath!
      const main = await this.read(parentLog, kind)
      const paths = [...new Set(getSubagentLogPaths(parentLog, kind, session.agentSessionId!))].filter(p => p !== parentLog)
      let children: SubagentActivity[]
      if (kind === 'claude') {
        activeClaudeParents.add(parentLog)
        children = await this.claudeChildren(parentLog, paths)
      } else {
        children = []
        for (const logPath of await this.select(parentLog, paths)) {
          const agyId = kind === 'antigravity' ? antigravitySessionId(logPath) : null
          const id = agyId ?? childId(logPath)
          const activity = await this.read(logPath, kind)
          const name = (agyId && antigravityConversation(agyId)?.agent_name.slice(0, 120)) || this.cursors.get(logPath)?.state.name || this.summaries.get(logPath)?.name || id
          children.push({ id, name, activity })
        }
      }
      const running = children.filter(c => c.activity.phase === 'model' || c.activity.phase === 'tool').length
      const uncertain = children.filter(c => c.activity.phase === 'unknown').length + paths.length - children.length
      const blocked = children.filter(c => c.activity.phase === 'blocked').length
      children.sort((a, b) => priority(a.activity) - priority(b.activity) || a.id.localeCompare(b.id))
      const activity: SessionActivity = {
        main, running, unknown: uncertain, blocked, total: paths.length,
        subagents: children.slice(0, DETAIL_LIMIT), truncated: paths.length > DETAIL_LIMIT,
      }
      result.push({ ...session, activity })
    }
    for (const parentLog of this.claudeRankings.keys()) {
      if (!activeClaudeParents.has(parentLog)) this.claudeRankings.delete(parentLog)
    }
    return result
  }
}

function childId(logPath: string): string {
  return path.basename(logPath, '.jsonl').replace(/^agent-/, '')
}

function metaPath(logPath: string): string {
  return logPath.replace(/\.jsonl$/, '.meta.json')
}

function recentFirst(a: ClaudeCandidate, b: ClaudeCandidate): number {
  return (b.log?.mtime ?? -Infinity) - (a.log?.mtime ?? -Infinity) || a.logPath.localeCompare(b.logPath)
}

async function statRevision(filePath: string): Promise<Revision | null> {
  try {
    const stat: Stats = await fs.stat(filePath)
    if (stat.isFile()) return { ino: stat.ino, size: stat.size, mtime: stat.mtimeMs }
  } catch { /* A missing or unreadable file provides no evidence. */ }
  return null
}

function sameRevision(a: Revision | null, b: Revision | null | undefined): boolean {
  return a === b || !!(a && b && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime)
}

// null marks a failed read of a known sidecar, so the next probe retries.
async function readClaudeMetadata(logPath: string, sidecar: Revision | null): Promise<ClaudeMetadata | null | undefined> {
  if (!sidecar || sidecar.size > 16 * 1024) return
  let text: string
  try { text = await fs.readFile(metaPath(logPath), 'utf8') }
  catch { return null }
  try {
    const raw = JSON.parse(text)
    const name = typeof raw.description === 'string' ? raw.description : typeof raw.agentType === 'string' ? raw.agentType : undefined
    const completion = raw.stoppedByUser === true ? 'Stopped' : raw.finished === true ? 'Turn finished' : undefined
    return { name: name?.slice(0, 120), completion }
  } catch { /* An absent or malformed sidecar provides no evidence. */ }
}

function isLive(activity: AgentActivity): boolean {
  return activity.phase === 'model' || activity.phase === 'tool' || activity.phase === 'blocked'
}

function priority(activity: AgentActivity): number {
  return activity.phase === 'blocked' ? 0 : activity.phase === 'idle' ? 3 : activity.phase === 'unknown' ? 2 : 1
}

function observed(activity: AgentActivity): AgentActivity {
  // Silence is uncertainty, never proof of completion.
  if (isLive(activity) && activity.updatedAt && Date.now() - Date.parse(activity.updatedAt) > STALE_MS) {
    return { ...activity, phase: 'unknown', label: 'No lifecycle signal for 15m', tools: [] }
  }
  return activity
}
