import type { AgentType, Session } from '../shared/types'
import type { ExactMatchProfiler } from './logMatcher'
import type { KnownSession, LogEntrySnapshot } from './logPollData'
import type { SessionSnapshot } from './logMatchGate'

export interface MatchWorkerSearchOptions {
  tailBytes?: number
  rgThreads?: number
  profile?: boolean
}

export interface OrphanCandidate {
  sessionId: string
  logFilePath: string
  projectPath: string | null
  agentType: AgentType | null
  currentWindow: string | null
}

export interface LastMessageCandidate {
  sessionId: string
  logFilePath: string
  projectPath: string | null
  agentType: AgentType | null
}

export interface MatchWorkerRequest {
  id: string
  windows: Session[]
  maxLogsPerPoll: number
  logDirs?: string[]
  sessions: SessionSnapshot[]
  /** Known sessions to skip expensive file reads during log collection */
  knownSessions?: KnownSession[]
  scrollbackLines: number
  minTokensForMatch?: number
  forceOrphanRematch?: boolean
  orphanCandidates?: OrphanCandidate[]
  lastMessageCandidates?: LastMessageCandidate[]
  search?: MatchWorkerSearchOptions
}

export interface MatchWorkerResponse {
  id: string
  type: 'result' | 'error'
  entries?: LogEntrySnapshot[]
  orphanEntries?: LogEntrySnapshot[]
  scanMs?: number
  sortMs?: number
  matchMs?: number
  matchWindowCount?: number
  matchLogCount?: number
  matchSkipped?: boolean
  matches?: Array<{ logPath: string; tmuxWindow: string }>
  orphanMatches?: Array<{ logPath: string; tmuxWindow: string }>
  profile?: ExactMatchProfiler
  error?: string
}
