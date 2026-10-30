// Bounded passive activity reader for live sessions only. Cold reads use a
// tail, then consume append-only bytes. Never executes harness commands.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Session } from '../shared/types'
import type { AgentActivity, SessionActivity, SubagentActivity } from '../shared/activity'
import { activitySnapshot, newActivityState, reduceActivity, type ActivityState } from './activityReducer'
import { getSubagentLogPaths } from './subagentLogs'

const READ_LIMIT = 256 * 1024
const CACHE_LIMIT = 2048
const DETAIL_LIMIT = 40
const CHILD_READ_LIMIT = 256
const STALE_MS = 15 * 60 * 1000
interface Cursor {
  state: ActivityState
  offset: number
  remainder: Buffer
  discardLine: boolean
  ino: number
  mtime: number
}

const unknown = (): AgentActivity => ({ phase: 'unknown', label: 'Activity unknown', tools: [] })

export class SessionActivityTracker {
  private cursors = new Map<string, Cursor>()

  private async read(logPath: string, kind: 'claude' | 'codex'): Promise<AgentActivity> {
    let file
    try {
      file = await fs.open(logPath, 'r')
      const stat = await file.stat()
      let cursor = this.cursors.get(logPath)
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
      while (this.cursors.size > CACHE_LIMIT) this.cursors.delete(this.cursors.keys().next().value!)
      const activity = activitySnapshot(cursor.state)
      // Missing completion after a crash must not become a permanent count.
      // Silence is uncertainty, never proof that the agent finished.
      if ((activity.phase === 'model' || activity.phase === 'tool' || activity.phase === 'blocked') &&
        activity.updatedAt && Date.now() - Date.parse(activity.updatedAt) > STALE_MS) {
        return { ...activity, phase: 'unknown', label: 'No lifecycle signal for 15m', tools: [] }
      }
      return activity
    } catch {
      this.cursors.delete(logPath)
      return unknown()
    } finally {
      await file?.close()
    }
  }

  private async child(logPath: string, kind: 'claude' | 'codex'): Promise<SubagentActivity> {
    const id = path.basename(logPath, '.jsonl').replace(/^agent-/, '')
    let activity = await this.read(logPath, kind)
    let name = this.cursors.get(logPath)?.state.name ?? id
    if (kind === 'claude') {
      try {
        const metaPath = logPath.replace(/\.jsonl$/, '.meta.json')
        const stat = await fs.stat(metaPath)
        if (stat.size <= 16 * 1024) {
          const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
          if (typeof meta.description === 'string') name = meta.description.slice(0, 120)
          else if (typeof meta.agentType === 'string') name = meta.agentType.slice(0, 120)
          // finished is observed in current local versions, not a stable API.
          // Only use it when metadata is at least as fresh as the transcript.
          const transcript = this.cursors.get(logPath)
          if (meta.finished === true && transcript && stat.mtimeMs >= transcript.mtime) {
            activity = { ...activity, phase: 'idle', label: 'Turn finished', tools: [] }
          }
        }
      } catch { /* older versions need not have a metadata sidecar */ }
    }
    return { id, name, activity }
  }

  async enrich(sessions: Session[]): Promise<Session[]> {
    const result: Session[] = []
    for (const session of sessions) {
      if (session.remote || session.source !== 'managed' || !session.logFilePath || !session.agentSessionId ||
        (session.agentType !== 'claude' && session.agentType !== 'codex')) {
        result.push(session)
        continue
      }
      const kind = session.agentType
      const main = await this.read(session.logFilePath, kind)
      const paths = [...new Set(getSubagentLogPaths(session.logFilePath, kind, session.agentSessionId))].filter(p => p !== session.logFilePath)
      const children: SubagentActivity[] = []
      // Sequential async reads keep filesystem fanout bounded.
      for (const logPath of paths.slice(0, CHILD_READ_LIMIT)) children.push(await this.child(logPath, kind))
      const running = children.filter(c => c.activity.phase === 'model' || c.activity.phase === 'tool').length
      const uncertain = children.filter(c => c.activity.phase === 'unknown').length + Math.max(0, paths.length - CHILD_READ_LIMIT)
      const blocked = children.filter(c => c.activity.phase === 'blocked').length
      children.sort((a, b) => priority(a.activity) - priority(b.activity) || a.id.localeCompare(b.id))
      const activity: SessionActivity = {
        main, running, unknown: uncertain, blocked, total: paths.length,
        subagents: children.slice(0, DETAIL_LIMIT), truncated: paths.length > DETAIL_LIMIT,
      }
      result.push({ ...session, activity })
    }
    return result
  }
}

function priority(activity: AgentActivity): number {
  return activity.phase === 'idle' ? 2 : activity.phase === 'unknown' ? 1 : 0
}
