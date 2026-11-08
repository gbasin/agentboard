/** Bounded commands between the discovery coordinator and independent SQLite workers. */
import type { AgentSessionRecord } from './db'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import type { MediaSummary, MediaPage, MediaNeighbors, MediaQuery } from '../shared/media'
export type DiscoveryRequest =
  | { kind: 'open'; id: number; path: string }
  | { kind: 'summary'; id: number; record: AgentSessionRecord }
  | { kind: 'page'; id: number; record: AgentSessionRecord; cursor?: string; query?: MediaQuery }
  | { kind: 'neighbors'; id: number; record: AgentSessionRecord; anchor: string }
  | { kind: 'step'; id: number; record: AgentSessionRecord; force?: boolean; links?: CodexSubagentLink[] }
  | { kind: 'cancel'; id: number; record: AgentSessionRecord }
  | { kind: 'index'; links: CodexSubagentLink[] }
  | { kind: 'shutdown' }
export type DiscoveryResponse = { id: number } & (
  | { value: MediaSummary | MediaPage | MediaNeighbors | null; done?: boolean }
  | { error: string; code?: string }
)
