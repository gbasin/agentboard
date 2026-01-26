/// <reference lib="webworker" />
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import {
  getLogSearchDirs,
  getLogTimes,
  inferAgentTypeFromPath,
  isCodexExec,
  isCodexSubagent,
} from './logDiscovery'
import {
  DEFAULT_SCROLLBACK_LINES,
  createExactMatchProfiler,
  extractLastUserMessageFromLog,
  getLogTokenCount,
  isToolNotificationText,
  matchWindowsToLogsByExactRg,
} from './logMatcher'
import { getEntriesNeedingMatch, shouldSkipMatching } from './logMatchGate'
import { collectLogEntryBatch, type LogEntrySnapshot } from './logPollData'
import type {
  LastMessageCandidate,
  MatchWorkerRequest,
  MatchWorkerResponse,
  OrphanCandidate,
} from './logMatchWorkerTypes'

const LAST_USER_MESSAGE_READ_OPTIONS = {
  lineLimit: 200,
  byteLimit: 32 * 1024,
  maxByteLimit: 2 * 1024 * 1024,
}

const ctx =
  typeof self === 'undefined'
    ? null
    : (self as DedicatedWorkerGlobalScope | null)

export function handleMatchWorkerRequest(
  payload: MatchWorkerRequest
): MatchWorkerResponse {
  try {
    const search = payload.search ?? {}
    let { entries, scanMs, sortMs } = collectLogEntryBatch(
      payload.maxLogsPerPoll,
      { knownSessions: payload.knownSessions }
    )
    const logDirs = payload.logDirs ?? getLogSearchDirs()
    const profile = search.profile ? createExactMatchProfiler() : undefined
    let matchMs = 0
    let matchWindowCount = 0
    let matchLogCount = 0
    let matchSkipped = false
    let resolved: Array<{ logPath: string; tmuxWindow: string }> = []
    let orphanEntries: LogEntrySnapshot[] = []
    let orphanMatches: Array<{ logPath: string; tmuxWindow: string }> = []
    const sessionByLogPath = new Map(
      payload.sessions
        .filter((session) => session.logFilePath)
        .map((session) => [session.logFilePath, session] as const)
    )

    const entriesToMatch = getEntriesNeedingMatch(entries, payload.sessions, {
      minTokens: payload.minTokensForMatch ?? 0,
      skipMatchingPatterns: payload.skipMatchingPatterns ?? [],
    })
    if (entriesToMatch.length === 0) {
      matchSkipped = true
    } else {
      const matchStart = performance.now()
      const matchLogPaths = entriesToMatch.map((entry) => entry.logPath)
      const matches = matchWindowsToLogsByExactRg(
        payload.windows,
        logDirs,
        payload.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES,
        {
          logPaths: matchLogPaths,
          tailBytes: search.tailBytes,
          rgThreads: search.rgThreads,
          profile,
        }
      )
      matchMs = performance.now() - matchStart
      matchWindowCount = payload.windows.length
      matchLogCount = matchLogPaths.length
      resolved = Array.from(matches.entries()).map(([logPath, window]) => ({
        logPath,
        tmuxWindow: window.tmuxWindow,
      }))
    }

    const orphanCandidates = payload.orphanCandidates ?? []
    if (payload.forceOrphanRematch && orphanCandidates.length > 0) {
      const skipPatterns = payload.skipMatchingPatterns ?? []
      orphanEntries = buildOrphanEntries(orphanCandidates, entries, {
        minTokens: payload.minTokensForMatch ?? 0,
        skipPatterns,
      })
      if (orphanEntries.length > 0) {
        const startupRgThreads = Math.max(
          search.rgThreads ?? 1,
          Math.min(os.cpus().length, 4)
        )
        const matches = matchWindowsToLogsByExactRg(
          payload.windows,
          logDirs,
          payload.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES,
          {
            logPaths: orphanEntries.map((entry) => entry.logPath),
            rgThreads: startupRgThreads,
            profile,
          }
        )
        orphanMatches = Array.from(matches.entries()).map(
          ([logPath, window]) => ({
            logPath,
            tmuxWindow: window.tmuxWindow,
          })
        )
      }
    }

    const lastMessageCandidates = payload.lastMessageCandidates ?? []
    if (lastMessageCandidates.length > 0) {
      const lastMessageEntries = buildLastMessageEntries(
        lastMessageCandidates,
        entries,
        orphanEntries
      )
      if (lastMessageEntries.length > 0) {
        entries = [...entries, ...lastMessageEntries]
      }
    }

    for (const entry of entries) {
      attachLastUserMessage(entry, sessionByLogPath)
    }
    for (const entry of orphanEntries) {
      attachLastUserMessage(entry, sessionByLogPath)
    }

    return {
      id: payload.id,
      type: 'result',
      entries,
      orphanEntries,
      scanMs,
      sortMs,
      matchMs,
      matchWindowCount,
      matchLogCount,
      matchSkipped,
      matches: resolved,
      orphanMatches,
      profile,
    }
  } catch (error) {
    return {
      id: payload.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

interface BuildOrphanEntriesOptions {
  minTokens: number
  skipPatterns: string[]
}

function buildOrphanEntries(
  candidates: OrphanCandidate[],
  _entries: LogEntrySnapshot[],
  { minTokens, skipPatterns }: BuildOrphanEntriesOptions
): LogEntrySnapshot[] {
  // Note: We intentionally don't skip logs that are in `entries`.
  // For orphan rematch, we want to match ALL orphan candidates to windows,
  // even if their logs were scanned in the regular batch but not matched
  // (e.g., because they didn't have new activity).
  const orphanEntries: LogEntrySnapshot[] = []

  for (const record of candidates) {
    const logPath = record.logFilePath
    if (!logPath) continue

    const agentType = record.agentType
    if (agentType === 'codex' && isCodexSubagent(logPath)) {
      continue
    }

    const times = getLogTimes(logPath)
    if (!times) continue

    // Check skip patterns BEFORE expensive token counting
    const codexExec = agentType === 'codex' ? isCodexExec(logPath) : false
    if (skipPatterns.length > 0) {
      const preEntry: LogEntrySnapshot = {
        logPath,
        mtime: times.mtime.getTime(),
        birthtime: times.birthtime.getTime(),
        sessionId: record.sessionId,
        projectPath: record.projectPath ?? null,
        agentType: agentType ?? null,
        isCodexSubagent: false,
        isCodexExec: codexExec,
        logTokenCount: 0,
      }
      if (shouldSkipMatching(preEntry, skipPatterns)) {
        continue
      }
    }

    const logTokenCount = getLogTokenCount(logPath)
    if (minTokens > 0 && logTokenCount < minTokens) {
      continue
    }

    orphanEntries.push({
      logPath,
      mtime: times.mtime.getTime(),
      birthtime: times.birthtime.getTime(),
      sessionId: record.sessionId,
      projectPath: record.projectPath ?? null,
      agentType: agentType ?? null,
      isCodexSubagent: false,
      isCodexExec: codexExec,
      logTokenCount,
    })
  }

  return orphanEntries
}

function buildLastMessageEntries(
  candidates: LastMessageCandidate[],
  entries: LogEntrySnapshot[],
  orphanEntries: LogEntrySnapshot[]
): LogEntrySnapshot[] {
  const existingLogPaths = new Set(
    [...entries, ...orphanEntries].map((entry) => entry.logPath)
  )
  const nextEntries: LogEntrySnapshot[] = []

  for (const record of candidates) {
    const logPath = record.logFilePath
    if (!logPath || existingLogPaths.has(logPath)) continue

    const resolvedAgentType =
      record.agentType ?? inferAgentTypeFromPath(logPath) ?? null
    const codexSubagent =
      resolvedAgentType === 'codex' ? isCodexSubagent(logPath) : false
    if (resolvedAgentType === 'codex' && codexSubagent) {
      continue
    }

    const times = getLogTimes(logPath)
    if (!times) continue

    const codexExec = resolvedAgentType === 'codex' ? isCodexExec(logPath) : false
    nextEntries.push({
      logPath,
      mtime: times.mtime.getTime(),
      birthtime: times.birthtime.getTime(),
      sessionId: record.sessionId,
      projectPath: record.projectPath ?? null,
      agentType: resolvedAgentType,
      isCodexSubagent: codexSubagent,
      isCodexExec: codexExec,
      logTokenCount: 0,
    })
  }

  return nextEntries
}

function attachLastUserMessage(
  entry: LogEntrySnapshot,
  sessionByLogPath: Map<
    string,
    {
      lastActivityAt: string
      logFilePath: string
      currentWindow: string | null
      lastUserMessage?: string | null
    }
  >
) {
  const snapshot = sessionByLogPath.get(entry.logPath)
  if (snapshot) {
    if (!snapshot.lastUserMessage || isToolNotificationText(snapshot.lastUserMessage)) {
      const lastUserMessage = extractLastUserMessageFromLog(
        entry.logPath,
        LAST_USER_MESSAGE_READ_OPTIONS
      )
      if (lastUserMessage) {
        entry.lastUserMessage = lastUserMessage
      }
      return
    }
    const lastActivity = Date.parse(snapshot.lastActivityAt)
    if (!Number.isNaN(lastActivity) && entry.mtime <= lastActivity) {
      return
    }
  }
  const lastUserMessage = extractLastUserMessageFromLog(
    entry.logPath,
    LAST_USER_MESSAGE_READ_OPTIONS
  )
  if (lastUserMessage) {
    entry.lastUserMessage = lastUserMessage
  }
}

if (ctx) {
  ctx.onmessage = (event: MessageEvent<MatchWorkerRequest>) => {
    const payload = event.data
    if (!payload || !payload.id) {
      return
    }
    const response = handleMatchWorkerRequest(payload)
    ctx.postMessage(response)
  }
  // Signal that the worker is ready to receive messages
  ctx.postMessage({ type: 'ready' })
}
