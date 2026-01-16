import { performance } from 'node:perf_hooks'
import type { AgentType } from '../shared/types'
import {
  extractProjectPath,
  extractSessionId,
  getLogTimes,
  inferAgentTypeFromPath,
  isCodexSubagent,
  scanAllLogDirs,
} from './logDiscovery'
import { getLogTokenCount } from './logMatcher'

export interface LogEntrySnapshot {
  logPath: string
  mtime: number
  birthtime: number
  sessionId: string | null
  projectPath: string | null
  agentType: AgentType | null
  isCodexSubagent: boolean
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
}

export interface CollectLogEntryBatchOptions {
  /** Known sessions to skip enrichment for (avoids re-reading file contents) */
  knownSessions?: KnownSession[]
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
      }
    })
    .filter(Boolean) as Array<{
    logPath: string
    mtime: number
    birthtime: number
  }>

  const sortStart = performance.now()
  timeEntries.sort((a, b) => b.mtime - a.mtime)
  const limited = timeEntries.slice(0, Math.max(1, maxLogs))
  const sortMs = performance.now() - sortStart

  const entries = limited.map((entry) => {
    // Check if this log is already known - skip expensive file reads
    const known = knownByPath.get(entry.logPath)
    if (known) {
      // Use cached metadata from DB, skip file content reads
      // logTokenCount = -1 indicates enrichment was skipped (already validated)
      return {
        logPath: entry.logPath,
        mtime: entry.mtime,
        birthtime: entry.birthtime,
        sessionId: known.sessionId,
        projectPath: known.projectPath,
        agentType: known.agentType,
        isCodexSubagent: false,
        logTokenCount: -1,
      } satisfies LogEntrySnapshot
    }

    // Unknown log - do full enrichment (read file contents)
    const agentType = inferAgentTypeFromPath(entry.logPath)
    const sessionId = extractSessionId(entry.logPath)
    const projectPath = extractProjectPath(entry.logPath)
    const codexSubagent = agentType === 'codex' ? isCodexSubagent(entry.logPath) : false
    const shouldCountTokens = Boolean(sessionId) && !codexSubagent && Boolean(agentType)
    const logTokenCount = shouldCountTokens ? getLogTokenCount(entry.logPath) : 0

    return {
      logPath: entry.logPath,
      mtime: entry.mtime,
      birthtime: entry.birthtime,
      sessionId,
      projectPath,
      agentType: agentType ?? null,
      isCodexSubagent: codexSubagent,
      logTokenCount,
    } satisfies LogEntrySnapshot
  })

  return { entries, scanMs, sortMs }
}
