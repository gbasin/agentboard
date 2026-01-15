import type { Session } from '@shared/types'
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
    return [...sessions].sort((a, b) => {
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

  return [...sessions].sort((a, b) => {
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
