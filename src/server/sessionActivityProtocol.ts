// Only association descriptors cross the worker boundary, never terminal text.
import type { Session } from '../shared/types'
import type { SessionActivity } from '../shared/activity'
import type { CodexSubagentLink } from './logMatchWorkerTypes'

export type ActivitySession = Pick<Session, 'id' | 'source' | 'agentType' | 'logFilePath' | 'agentSessionId' | 'boardSessionId' | 'agentboardTags' | 'remote'>
export interface ActivityPatch { key: string; activity?: SessionActivity }
export type ActivityRequest =
  | { kind: 'scan'; id: number; sessions: ActivitySession[] }
  | { kind: 'index'; links: CodexSubagentLink[] }
export type ActivityResponse = { id: number; patches: ActivityPatch[] } | { id: number; error: string } | { id: number; progress: true }

export function activityKey(session: ActivitySession): string {
  return JSON.stringify([session.id, session.boardSessionId, session.agentboardTags, session.agentSessionId, session.logFilePath, session.agentType])
}
export function supportsActivity(session: ActivitySession): boolean {
  return !session.remote && session.source === 'managed' && !!session.logFilePath && !!session.agentSessionId &&
    (session.agentType === 'claude' || session.agentType === 'codex')
}
