import { EventEmitter } from 'node:events'
import type { AgentSession, Session } from '../shared/types'

export interface RegistryEvents {
  sessions: (sessions: Session[]) => void
  'session-update': (session: Session) => void
  'session-removed': (sessionId: string) => void
  'agent-sessions': (payload: { active: AgentSession[]; inactive: AgentSession[] }) => void
}

export class SessionRegistry extends EventEmitter {
  private sessions: Map<string, Session>
  private agentSessions: { active: AgentSession[]; inactive: AgentSession[] }
  private agentSessionsSnapshot: string

  constructor() {
    super()
    this.sessions = new Map<string, Session>()
    this.agentSessions = { active: [], inactive: [] }
    this.agentSessionsSnapshot = ''
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

  getAgentSessions(): { active: AgentSession[]; inactive: AgentSession[] } {
    return this.agentSessions
  }

  setAgentSessions(active: AgentSession[], inactive: AgentSession[]): void {
    const snapshot = JSON.stringify({ active, inactive })
    if (snapshot === this.agentSessionsSnapshot) {
      return
    }

    this.agentSessions = { active, inactive }
    this.agentSessionsSnapshot = snapshot
    this.emit('agent-sessions', this.agentSessions)
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
    a.agentSessionName === b.agentSessionName
  )
}
