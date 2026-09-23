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
  /**
   * When set, the worker rg-scans ~/.codex/sessions for subagent rollouts and
   * returns their session_meta linkage on the response. Offloads the ~seconds-
   * scale full-tree scan + head-parse from the main thread.
   */
  buildCodexSubagentIndex?: boolean
}

/** Codex subagent linkage extracted from a rollout's session_meta. */
export interface CodexSubagentLink {
  ownId: string
  parentId: string | null
  logPath: string
}

/** A window where tryExactMatchWindowToLog returned null due to no extractable messages */
export interface NoMessageWindow {
  tmuxWindow: string
  projectPath: string | null
  agentType: AgentType | null
  source: 'managed' | 'external' | null
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
  /** Time to enrich orphan candidates (stats, token counts) */
  orphanScanMs?: number
  /** Time to content-match orphan entries against unclaimed windows */
  orphanMatchMs?: number
  /** Windows that had no extractable user messages (terminal empty or still booting) */
  noMessageWindows?: NoMessageWindow[]
  /** Present when buildCodexSubagentIndex was requested. */
  codexSubagents?: CodexSubagentLink[]
  codexIndexMs?: number
  profile?: ExactMatchProfiler
  error?: string
}
