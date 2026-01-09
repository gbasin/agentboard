import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { Session } from '../shared/types'
import { config } from './config'
import { discoverLogFile } from './logDiscovery'
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
}

export class StatusWatcher {
  private states = new Map<string, WatchState>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private registry: SessionRegistry) {
    this.registry.on('session-removed', (sessionId) => {
      this.stopWatching(sessionId)
    })
  }

  start(): void {
    if (this.idleTimer) {
      return
    }

    this.idleTimer = setInterval(() => {
      this.checkIdle()
    }, Math.min(config.idleTimeoutMs / 2, 60000))
  }

  stop(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
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

    for (const session of sessions) {
      await this.ensureWatching(session)
    }
  }

  private async ensureWatching(session: Session): Promise<void> {
    const current = this.states.get(session.id)
    const logFile = await discoverLogFile(session.projectPath)

    if (!logFile) {
      if (current?.logFile) {
        this.stopWatching(session.id)
      }
      if (session.status !== 'unknown') {
        this.registry.updateSession(session.id, { status: 'unknown' })
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

  private async startWatching(session: Session, logFile: string): Promise<void> {
    const state: WatchState = {
      sessionId: session.id,
      logFile,
      watcher: null,
      position: 0,
      remainder: '',
      status: session.status,
      lastActivity: Date.parse(session.lastActivity) || Date.now(),
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

  private checkIdle(): void {
    const now = Date.now()
    for (const state of this.states.values()) {
      if (state.status === 'needs_approval') {
        continue
      }

      if (now - state.lastActivity >= config.idleTimeoutMs) {
        if (state.status !== 'idle') {
          state.status = transitionStatus(state.status, { type: 'idle_timeout' })
          this.registry.updateSession(state.sessionId, {
            status: state.status,
            lastActivity: new Date(state.lastActivity).toISOString(),
          })
        }
      }
    }
  }
}
