import { performance } from 'node:perf_hooks'
import type { AgentType } from '../shared/types'
import {
  extractProjectPath,
  extractSessionId,
  getLogTimes,
  inferAgentTypeFromPath,
  isCodexExec,
  isCodexSubagent,
  scanAllLogDirs,
} from './logDiscovery'
import { getLogTokenCount } from './logMatcher'

export interface LogEntrySnapshot {
  logPath: string
  mtime: number
  birthtime: number
  size: number
  sessionId: string | null
  projectPath: string | null
  agentType: AgentType | null
  isCodexSubagent: boolean
  isCodexExec: boolean
  logTokenCount: number
  lastUserMessage?: string
}

export interface LogEntryBatch {
  entries: LogEntrySnapshot[]
  scanMs: number
  sortMs: number
}

/** Known session info to skip expensive file reads for already-tracked logs */
export interface KnownSession {
  logFilePath: string
  sessionId: string
  projectPath: string | null
  agentType: AgentType | null
  isCodexExec: boolean
}

export interface CollectLogEntryBatchOptions {
  /** Known sessions to skip enrichment for (avoids re-reading file contents) */
  knownSessions?: KnownSession[]
}

// Shared per-file enrichment used by full scans and pre-filtered path batches.
export function enrichLogEntry(
  logPath: string,
  mtime: number,
  birthtime: number,
  size: number,
  knownByPath: Map<string, KnownSession>
): LogEntrySnapshot {
  const known = knownByPath.get(logPath)
  if (known) {
    // Use cached metadata from DB, skip file content reads
    // logTokenCount = -1 indicates enrichment was skipped (already validated)
    // For codex sessions, backfill isCodexExec if not yet set (cheap header check)
    const codexExec = known.agentType === 'codex' && !known.isCodexExec
      ? isCodexExec(logPath)
      : known.isCodexExec
    return {
      logPath,
      mtime,
      birthtime,
      size,
      sessionId: known.sessionId,
      projectPath: known.projectPath,
      agentType: known.agentType,
      isCodexSubagent: false,
      isCodexExec: codexExec,
      logTokenCount: -1,
    } satisfies LogEntrySnapshot
  }

  // Unknown log - do full enrichment (read file contents)
  const agentType = inferAgentTypeFromPath(logPath)
  const sessionId = extractSessionId(logPath)
  const projectPath = extractProjectPath(logPath)
  const codexSubagent = agentType === 'codex' ? isCodexSubagent(logPath) : false
  const codexExec = agentType === 'codex' ? isCodexExec(logPath) : false
  const shouldCountTokens = Boolean(sessionId) && !codexSubagent && Boolean(agentType)
  const logTokenCount = shouldCountTokens ? getLogTokenCount(logPath) : 0

  return {
    logPath,
    mtime,
    birthtime,
    size,
    sessionId,
    projectPath,
    agentType: agentType ?? null,
    isCodexSubagent: codexSubagent,
    isCodexExec: codexExec,
    logTokenCount,
  } satisfies LogEntrySnapshot
}

export function collectLogEntryBatch(
  maxLogs: number,
  options: CollectLogEntryBatchOptions = {}
): LogEntryBatch {
  const { knownSessions = [] } = options
  const knownByPath = new Map(
    knownSessions.map((s) => [s.logFilePath, s])
  )

  const scanStart = performance.now()
  const logPaths = scanAllLogDirs()
  const scanMs = performance.now() - scanStart

  const timeEntries = logPaths
    .map((logPath) => {
      const times = getLogTimes(logPath)
      if (!times) return null
      return {
        logPath,
        mtime: times.mtime.getTime(),
        birthtime: times.birthtime.getTime(),
        size: times.size,
      }
    })
    .filter(Boolean) as Array<{
    logPath: string
    mtime: number
    birthtime: number
    size: number
  }>

  const sortStart = performance.now()
  timeEntries.sort((a, b) => b.mtime - a.mtime)
  const limited = timeEntries.slice(0, Math.max(1, maxLogs))
  const sortMs = performance.now() - sortStart

  const entries = limited.map((entry) =>
    enrichLogEntry(
      entry.logPath,
      entry.mtime,
      entry.birthtime,
      entry.size,
      knownByPath
    )
  )

  return { entries, scanMs, sortMs }
}

export function collectLogEntriesForPaths(
  logPaths: string[],
  knownSessions: KnownSession[] = []
): LogEntrySnapshot[] {
  const knownByPath = new Map(
    knownSessions.map((session) => [session.logFilePath, session])
  )
  const entries: LogEntrySnapshot[] = []

  for (const logPath of new Set(logPaths)) {
    const times = getLogTimes(logPath)
    if (!times) continue
    entries.push(
      enrichLogEntry(
        logPath,
        times.mtime.getTime(),
        times.birthtime.getTime(),
        times.size,
        knownByPath
      )
    )
  }

  return entries
}
