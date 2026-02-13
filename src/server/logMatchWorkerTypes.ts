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
  /**
   * Paths provided by LogWatcher.
   * When set and non-empty, worker skips full directory scanning and enriches
   * only these paths.
   */
  preFilteredPaths?: string[]
  sessions: SessionSnapshot[]
  /** Known sessions to skip expensive file reads during log collection */
  knownSessions?: KnownSession[]
  scrollbackLines: number
  minTokensForMatch?: number
  forceOrphanRematch?: boolean
  orphanCandidates?: OrphanCandidate[]
  lastMessageCandidates?: LastMessageCandidate[]
  search?: MatchWorkerSearchOptions
  /** Patterns for sessions that should skip window matching when orphaned */
  skipMatchingPatterns?: string[]
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
