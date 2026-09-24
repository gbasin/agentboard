/** Durable session library contracts, independent of live terminal identifiers. */
import type { AgentType, AgentSession } from './types'

export type Lifecycle =
  | 'starting'
  | 'running'
  | 'interrupted'
  | 'hibernating'
  | 'archived'
  | 'failed'
export interface SavedSession {
  id: string
  name: string
  projectPath: string
  hostId: string
  agentType: AgentType | null
  providerId: string | null
  command: string
  state: Lifecycle
  pinned: boolean
  createdAt: string
  lastActivityAt: string
  window: string | null
  epoch: string | null
  error: string | null
  preview: string | null
  origin: 'managed' | 'discovered' | 'imported'
  lastRunId: string | null
  requestedState?: 'hibernating' | 'archived' | null
}
export interface HistoryQuery {
  q?: string
  state?: Lifecycle | 'all' | 'previously-open'
  project?: string
  agent?: string
  pinned?: boolean
  hours?: number
  cursor?: string
  limit?: number
}
export interface HistoryPage {
  sessions: SavedSession[]
  nextCursor: string | null
}
export interface SessionEvent {
  id: number
  sessionId: string
  kind: string
  detail: string | null
  createdAt: string
}
export interface PersistenceSettings {
  autoResume: boolean
  capturePreviews: boolean
}
export interface PersistenceHealth {
  lastSavedAt: string | null
  error: string | null
  matchingAvailable: boolean
  matchingError?: string | null
  interrupted: number
  settings: PersistenceSettings
}

export interface HistoryDetail {
  session: SavedSession
  events: SessionEvent[]
  terminalPreview: string | null
  terminalPreviewAt: string | null
  conversations: AgentSession[]
}
