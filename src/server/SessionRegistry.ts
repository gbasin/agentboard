import { EventEmitter } from 'node:events'
import type { Session } from '../shared/types'

export interface RegistryEvents {
  sessions: (sessions: Session[]) => void
  'session-update': (session: Session) => void
  'session-removed': (sessionId: string) => void
}

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, Session>()

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
      nextMap.set(session.id, {
        ...session,
        status: existing?.status ?? session.status,
        lastActivity: nextLastActivity,
        logFile: existing?.logFile ?? session.logFile,
      })
    }

    const removedIds = new Set(this.sessions.keys())
    for (const id of nextMap.keys()) {
      removedIds.delete(id)
    }

    this.sessions = nextMap
    this.emit('sessions', this.getAll())

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
