import { EventEmitter } from 'node:events'
import type { AgentSession, Session } from '../shared/types'

export interface RegistryEvents {
  sessions: (sessions: Session[]) => void
  'session-update': (session: Session) => void
  'session-removed': (sessionId: string) => void
  'agent-sessions': (payload: { active: AgentSession[]; sleeping: AgentSession[]; inactive: AgentSession[] }) => void
  'agent-sessions-active': (active: AgentSession[]) => void
}

export class SessionRegistry extends EventEmitter {
  private sessions: Map<string, Session>
  private agentSessions: { active: AgentSession[]; sleeping: AgentSession[]; inactive: AgentSession[] }

  constructor() {
    super()
    this.sessions = new Map<string, Session>()
    this.agentSessions = { active: [], sleeping: [], inactive: [] }
  }

  getAll(): Session[] {
    return Array.from(this.sessions.values())
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  replaceSessions(nextSessions: Session[]): void {
    const nextMap = new Map<string, Session>()

    for (const session of nextSessions) {
      const existing = this.sessions.get(session.id)
      const nextLastActivity = pickLatestActivity(
        existing?.lastActivity,
        session.lastActivity
      )
      // Preserve createdAt from existing session, or use incoming/current time
      const createdAt =
        existing?.createdAt || session.createdAt || new Date().toISOString()
      nextMap.set(session.id, {
        ...session,
        lastActivity: nextLastActivity,
        createdAt,
      })
    }

    const removedIds = new Set(this.sessions.keys())
    for (const id of nextMap.keys()) {
      removedIds.delete(id)
    }

    // Check if anything actually changed
    const hasChanges =
      removedIds.size > 0 ||
      nextMap.size !== this.sessions.size ||
      Array.from(nextMap.values()).some((next) => {
        const existing = this.sessions.get(next.id)
        return !existing || !sessionsEqual(existing, next)
      })

    this.sessions = nextMap

    if (hasChanges) {
      this.emit('sessions', this.getAll())
    }

    for (const id of removedIds) {
      this.emit('session-removed', id)
    }
  }

  updateSession(sessionId: string, updates: Partial<Session>): Session | undefined {
    const current = this.sessions.get(sessionId)
    if (!current) {
      return undefined
    }

    const updated = {
      ...current,
      ...updates,
    }

    this.sessions.set(sessionId, updated)
    this.emit('session-update', updated)
    return updated
  }

  getAgentSessions(): { active: AgentSession[]; sleeping: AgentSession[]; inactive: AgentSession[] } {
    return this.agentSessions
  }

  setAgentSessions(active: AgentSession[], sleeping: AgentSession[], inactive: AgentSession[]): void {
    const prev = this.agentSessions
    const activeChanged =
      active.length !== prev.active.length ||
      !active.every((a, i) => agentSessionsEqual(a, prev.active[i]))
    const sleepingChanged =
      sleeping.length !== prev.sleeping.length ||
      !sleeping.every((a, i) => agentSessionsEqual(a, prev.sleeping[i]))
    const inactiveChanged =
      inactive.length !== prev.inactive.length ||
      !inactive.every((a, i) => agentSessionsEqual(a, prev.inactive[i]))

    if (!activeChanged && !sleepingChanged && !inactiveChanged) return

    this.agentSessions = { active, sleeping, inactive }

    // Always send the lightweight active-only update
    if (activeChanged) {
      this.emit('agent-sessions-active', active)
    }
    // Only send the full payload when sleeping or inactive actually changed.
    if (sleepingChanged || inactiveChanged) {
      this.emit('agent-sessions', this.agentSessions)
    }
  }
}

function pickLatestActivity(
  existing: string | undefined,
  incoming: string
): string {
  if (!existing) {
    return incoming
  }

  const existingTime = Date.parse(existing)
  const incomingTime = Date.parse(incoming)

  if (Number.isNaN(existingTime) && Number.isNaN(incomingTime)) {
    return incoming
  }
  if (Number.isNaN(existingTime)) {
    return incoming
  }
  if (Number.isNaN(incomingTime)) {
    return existing
  }

  return incomingTime > existingTime ? incoming : existing
}

function agentSessionsEqual(a: AgentSession, b: AgentSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.logFilePath === b.logFilePath &&
    a.projectPath === b.projectPath &&
    a.agentType === b.agentType &&
    a.displayName === b.displayName &&
    a.createdAt === b.createdAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.isActive === b.isActive &&
    a.isSleeping === b.isSleeping &&
    a.host === b.host &&
    a.lastUserMessage === b.lastUserMessage &&
    a.isPinned === b.isPinned &&
    a.lastResumeError === b.lastResumeError
  )
}

function sessionsEqual(a: Session, b: Session): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.status === b.status &&
    a.lastActivity === b.lastActivity &&
    a.projectPath === b.projectPath &&
    a.agentType === b.agentType &&
    a.command === b.command &&
    a.agentSessionId === b.agentSessionId &&
    a.agentSessionName === b.agentSessionName &&
    a.logFilePath === b.logFilePath &&
    a.lastUserMessage === b.lastUserMessage &&
    a.isPinned === b.isPinned &&
    a.host === b.host &&
    a.remote === b.remote
  )
}
