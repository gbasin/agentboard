import type { AgentSession, Session } from '@shared/types'
import type {
  SessionSortDirection,
  SessionSortMode,
} from '../stores/settingsStore'

const SESSION_STATUS_ORDER: Record<Session['status'], number> = {
  permission: 0,
  waiting: 1,
  working: 2,
  unknown: 3,
}

export interface SortOptions {
  mode: SessionSortMode
  direction: SessionSortDirection
  manualOrder?: string[]
}

export function getSessionOrderKey(session: Session): string {
  const agentId = session.agentSessionId?.trim()
  return agentId && agentId.length > 0 ? agentId : session.id
}

const DEFAULT_SORT_OPTIONS: SortOptions = {
  mode: 'created',
  direction: 'desc',
}

export function sortSessions(
  sessions: Session[],
  options: SortOptions = DEFAULT_SORT_OPTIONS
): Session[] {
  const { mode, direction, manualOrder } = options

  // Manual mode: sort by the order array, new sessions go to the end
  if (mode === 'manual' && manualOrder && manualOrder.length > 0) {
    const orderMap = new Map(manualOrder.map((id, idx) => [id, idx]))
    return sessions.toSorted((a, b) => {
      const aKey = getSessionOrderKey(a)
      const bKey = getSessionOrderKey(b)
      const aIdx = orderMap.get(aKey) ?? orderMap.get(a.id) ?? Infinity
      const bIdx = orderMap.get(bKey) ?? orderMap.get(b.id) ?? Infinity
      if (aIdx === Infinity && bIdx === Infinity) {
        // Both are new sessions, sort by createdAt desc
        return Date.parse(b.createdAt) - Date.parse(a.createdAt)
      }
      return aIdx - bIdx
    })
  }

  return sessions.toSorted((a, b) => {
    if (mode === 'status') {
      // Sort by status priority, then by lastActivity descending
      const aOrder =
        SESSION_STATUS_ORDER[a.status] ?? SESSION_STATUS_ORDER.unknown
      const bOrder =
        SESSION_STATUS_ORDER[b.status] ?? SESSION_STATUS_ORDER.unknown
      if (aOrder !== bOrder) return aOrder - bOrder
      return Date.parse(b.lastActivity) - Date.parse(a.lastActivity)
    }

    // Sort by createdAt timestamp
    const aTime = Date.parse(a.createdAt)
    const bTime = Date.parse(b.createdAt)
    return direction === 'desc' ? bTime - aTime : aTime - bTime
  })
}

/**
 * Freeze the visible row order while a drag is in progress. Live session
 * updates (status flips, new sessions, removals) would otherwise reorder or
 * reflow the list under the pointer — dnd-kit measures droppable rects against
 * the rendered order, so mid-drag churn produces teleporting rows and drops
 * landing on the wrong target.
 *
 * Rows present in `snapshotIds` keep their snapshot order; sessions that
 * appeared after the snapshot append in live order at the end (they can't be
 * drop targets, but they do render). Removed sessions drop out naturally.
 */
export function freezeListOrderDuringDrag<T extends { id: string }>(
  sessions: T[],
  snapshotIds: string[] | null
): T[] {
  if (!snapshotIds) return sessions
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const frozen: T[] = []
  for (const id of snapshotIds) {
    const session = byId.get(id)
    if (session) {
      frozen.push(session)
      byId.delete(id)
    }
  }
  for (const session of sessions) {
    if (byId.has(session.id)) frozen.push(session)
  }
  return frozen
}

export function getUniqueProjects(
  sessions: Session[],
  historySessions: AgentSession[]
): string[] {
  // Track the most recent activity timestamp for each project
  const projectActivity = new Map<string, number>()

  for (const session of sessions) {
    const path = session.projectPath?.trim()
    if (path) {
      const timestamp = Date.parse(session.lastActivity) || 0
      const existing = projectActivity.get(path) || 0
      if (timestamp > existing) {
        projectActivity.set(path, timestamp)
      }
    }
  }

  for (const session of historySessions) {
    const path = session.projectPath?.trim()
    if (path) {
      const timestamp = Date.parse(session.lastActivityAt) || 0
      const existing = projectActivity.get(path) || 0
      if (timestamp > existing) {
        projectActivity.set(path, timestamp)
      }
    }
  }

  // Sort by most recent activity (descending)
  return Array.from(projectActivity.keys()).toSorted((a, b) => {
    const aTime = projectActivity.get(a) || 0
    const bTime = projectActivity.get(b) || 0
    return bTime - aTime
  })
}

export function getUniqueHosts(
  sessions: Session[],
  historySessions: AgentSession[]
): string[] {
  const hostActivity = new Map<string, number>()

  for (const session of sessions) {
    const host = session.host?.trim()
    if (host) {
      const timestamp = Date.parse(session.lastActivity) || 0
      const existing = hostActivity.get(host) || 0
      if (timestamp > existing) {
        hostActivity.set(host, timestamp)
      }
    }
  }

  for (const session of historySessions) {
    const host = session.host?.trim()
    if (host) {
      const timestamp = Date.parse(session.lastActivityAt) || 0
      const existing = hostActivity.get(host) || 0
      if (timestamp > existing) {
        hostActivity.set(host, timestamp)
      }
    }
  }

  return Array.from(hostActivity.keys()).toSorted((a, b) => {
    const aTime = hostActivity.get(a) || 0
    const bTime = hostActivity.get(b) || 0
    return bTime - aTime
  })
}
