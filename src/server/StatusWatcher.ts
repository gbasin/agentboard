import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { Session } from '../shared/types'
import { discoverLogFiles, type LogFileInfo } from './logDiscovery'
import { parseLogLine } from './logParser'
import { transitionStatus } from './statusMachine'
import type { SessionRegistry } from './SessionRegistry'

interface WatchState {
  sessionId: string
  logFile: string | null
  watcher: fs.FSWatcher | null
  position: number
  remainder: string
  status: Session['status']
  lastActivity: number
  pendingToolUse: number | null // timestamp when tool_use was seen, null if no pending tool
}

// How long to wait after tool_use before showing needs_approval
// Short delay so quick auto-approved tools don't flash the notification
const TOOL_STALL_THRESHOLD_MS = 3000

export class StatusWatcher {
  private states = new Map<string, WatchState>()
  private stallTimer: NodeJS.Timeout | null = null

  constructor(private registry: SessionRegistry) {
    this.registry.on('session-removed', (sessionId) => {
      this.stopWatching(sessionId)
    })
  }

  start(): void {
    if (this.stallTimer) {
      return
    }

    // Check for stalled tool uses frequently (every 200ms)
    this.stallTimer = setInterval(() => {
      this.checkStalls()
    }, 200)
  }

  stop(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }

    for (const sessionId of this.states.keys()) {
      this.stopWatching(sessionId)
    }
  }

  async syncSessions(sessions: Session[]): Promise<void> {
    const incoming = new Set(sessions.map((session) => session.id))

    for (const sessionId of Array.from(this.states.keys())) {
      if (!incoming.has(sessionId)) {
        this.stopWatching(sessionId)
      }
    }

    const sessionsByPath = new Map<string, Session[]>()
    for (const session of sessions) {
      const group = sessionsByPath.get(session.projectPath)
      if (group) {
        group.push(session)
      } else {
        sessionsByPath.set(session.projectPath, [session])
      }
    }

    const assignments = new Map<string, string | null>()

    await Promise.all(
      Array.from(sessionsByPath.entries()).map(async ([projectPath, group]) => {
        const logFiles = await discoverLogFiles(projectPath)
        const groupAssignments = this.assignLogFiles(group, logFiles)
        for (const [sessionId, logFile] of groupAssignments.entries()) {
          assignments.set(sessionId, logFile)
        }
      })
    )

    for (const session of sessions) {
      await this.ensureWatching(session, assignments.get(session.id) ?? null)
    }
  }

  private async ensureWatching(
    session: Session,
    logFile: string | null
  ): Promise<void> {
    const current = this.states.get(session.id)

    if (!logFile) {
      if (current?.logFile) {
        this.stopWatching(session.id)
      }
      if (session.status !== 'unknown' || session.logFile) {
        this.registry.updateSession(session.id, {
          status: 'unknown',
          logFile: undefined,
        })
      }
      return
    }

    if (current && current.logFile === logFile) {
      return
    }

    if (current) {
      this.stopWatching(session.id)
    }

    await this.startWatching(session, logFile)
  }

  private assignLogFiles(
    sessions: Session[],
    logFiles: LogFileInfo[]
  ): Map<string, string | null> {
    const assignments = new Map<string, string | null>()

    if (logFiles.length === 0) {
      for (const session of sessions) {
        assignments.set(session.id, null)
      }
      return assignments
    }

    const available = new Map<string, number>(
      logFiles.map((file) => [file.path, file.mtimeMs])
    )

    for (const session of sessions) {
      const currentLog = this.states.get(session.id)?.logFile
      if (currentLog && available.has(currentLog)) {
        assignments.set(session.id, currentLog)
        available.delete(currentLog)
      }
    }

    const remainingSessions = sessions.filter(
      (session) => !assignments.has(session.id)
    )
    const remainingLogs = Array.from(available.entries()).map(
      ([path, mtimeMs]) => ({ path, mtimeMs })
    )

    const toTimestamp = (value: string) => {
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? 0 : parsed
    }

    remainingSessions.sort(
      (a, b) => toTimestamp(b.lastActivity) - toTimestamp(a.lastActivity)
    )
    remainingLogs.sort((a, b) => b.mtimeMs - a.mtimeMs)

    for (let i = 0; i < remainingSessions.length; i += 1) {
      assignments.set(remainingSessions[i].id, remainingLogs[i]?.path ?? null)
    }

    return assignments
  }

  private async startWatching(session: Session, logFile: string): Promise<void> {
    const state: WatchState = {
      sessionId: session.id,
      logFile,
      watcher: null,
      position: 0,
      remainder: '',
      status: session.status,
      lastActivity: Date.parse(session.lastActivity) || Date.now(),
      pendingToolUse: null,
    }

    this.states.set(session.id, state)
    this.registry.updateSession(session.id, { logFile })

    await this.bootstrapFromTail(session, state)

    state.watcher = fs.watch(logFile, async (eventType) => {
      if (eventType === 'change') {
        await this.readNewLines(state)
      }
    })
  }

  private stopWatching(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) {
      return
    }

    state.watcher?.close()
    this.states.delete(sessionId)
  }

  private async bootstrapFromTail(
    session: Session,
    state: WatchState
  ): Promise<void> {
    try {
      const stat = await fsp.stat(state.logFile || '')
      const size = stat.size
      const maxBytes = 64 * 1024
      const start = Math.max(0, size - maxBytes)
      const handle = await fsp.open(state.logFile || '', 'r')
      const buffer = Buffer.alloc(size - start)
      await handle.read(buffer, 0, buffer.length, start)
      await handle.close()

      const content = buffer.toString('utf8')
      const lines = content.split('\n')
      if (start > 0) {
        lines.shift()
      }

      state.position = size
      state.remainder = content.endsWith('\n') ? '' : lines.pop() || ''

      let nextStatus = state.status
      for (const line of lines) {
        const event = parseLogLine(line)
        if (event) {
          nextStatus = transitionStatus(nextStatus, event)
          state.lastActivity = Date.now()
        }
      }

      if (nextStatus === 'unknown') {
        nextStatus = transitionStatus(nextStatus, { type: 'log_found' })
      }

      state.status = nextStatus
      this.registry.updateSession(session.id, {
        status: nextStatus,
        lastActivity: new Date(state.lastActivity).toISOString(),
      })
    } catch {
      // ignore bootstrap failures
    }
  }

  private async readNewLines(state: WatchState): Promise<void> {
    if (!state.logFile) {
      return
    }

    try {
      const stat = await fsp.stat(state.logFile)
      if (stat.size < state.position) {
        state.position = 0
        state.remainder = ''
      }

      if (stat.size === state.position) {
        return
      }

      const toRead = stat.size - state.position
      const handle = await fsp.open(state.logFile, 'r')
      const buffer = Buffer.alloc(toRead)
      await handle.read(buffer, 0, buffer.length, state.position)
      await handle.close()

      state.position = stat.size
      const chunk = buffer.toString('utf8')
      const combined = state.remainder + chunk
      const lines = combined.split('\n')
      state.remainder = combined.endsWith('\n') ? '' : lines.pop() || ''

      let nextStatus = state.status
      let updated = false

      for (const line of lines) {
        const event = parseLogLine(line)
        if (event) {
          // Track pending tool uses for stall detection
          if (event.type === 'assistant_tool_use') {
            state.pendingToolUse = Date.now()
          } else if (event.type === 'tool_result' || event.type === 'turn_end') {
            // Tool result or turn end clears pending state
            state.pendingToolUse = null
          }

          nextStatus = transitionStatus(nextStatus, event)
          state.lastActivity = Date.now()
          updated = true
        }
      }

      if (updated) {
        state.status = nextStatus
        this.registry.updateSession(state.sessionId, {
          status: nextStatus,
          lastActivity: new Date(state.lastActivity).toISOString(),
        })
      }
    } catch {
      // ignore read errors
    }
  }

  private checkStalls(): void {
    const now = Date.now()
    for (const state of this.states.values()) {
      // Skip if already in needs_approval or no pending tool use
      if (state.status === 'needs_approval' || state.pendingToolUse === null) {
        continue
      }

      // Check if tool_use has been pending longer than threshold
      if (now - state.pendingToolUse >= TOOL_STALL_THRESHOLD_MS) {
        state.status = transitionStatus(state.status, { type: 'tool_stall' })
        this.registry.updateSession(state.sessionId, {
          status: state.status,
          lastActivity: new Date(state.lastActivity).toISOString(),
        })
      }
    }
  }

}
