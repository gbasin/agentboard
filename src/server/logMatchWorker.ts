/// <reference lib="webworker" />
import { performance } from 'node:perf_hooks'
import type { Session } from '../shared/types'
import { getLogSearchDirs } from './logDiscovery'
import {
  DEFAULT_SCROLLBACK_LINES,
  createExactMatchProfiler,
  matchWindowsToLogsByExactRg,
} from './logMatcher'
import { getEntriesNeedingMatch, type SessionSnapshot } from './logMatchGate'
import { collectLogEntryBatch, type LogEntrySnapshot } from './logPollData'

interface MatchWorkerSearchOptions {
  tailBytes?: number
  rgThreads?: number
  profile?: boolean
}

interface MatchWorkerRequest {
  id: string
  windows: Session[]
  maxLogsPerPoll: number
  logDirs?: string[]
  sessions: SessionSnapshot[]
  scrollbackLines?: number
  minTokensForMatch?: number
  search?: MatchWorkerSearchOptions
}

interface MatchWorkerResponse {
  id: string
  type: 'result' | 'error'
  entries?: LogEntrySnapshot[]
  scanMs?: number
  sortMs?: number
  matchMs?: number
  matchWindowCount?: number
  matchLogCount?: number
  matchSkipped?: boolean
  matches?: Array<{ logPath: string; tmuxWindow: string }>
  profile?: ReturnType<typeof createExactMatchProfiler>
  error?: string
}

const ctx = self as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<MatchWorkerRequest>) => {
  const payload = event.data
  if (!payload || !payload.id) {
    return
  }

  try {
    const search = payload.search ?? {}
    const { entries, scanMs, sortMs } = collectLogEntryBatch(
      payload.maxLogsPerPoll
    )
    const logDirs = payload.logDirs ?? getLogSearchDirs()
    const profile = search.profile ? createExactMatchProfiler() : undefined
    let matchMs = 0
    let matchWindowCount = 0
    let matchLogCount = 0
    let matchSkipped = false
    let resolved: Array<{ logPath: string; tmuxWindow: string }> = []

    const entriesToMatch = getEntriesNeedingMatch(entries, payload.sessions, {
      minTokens: payload.minTokensForMatch ?? 0,
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

    const response: MatchWorkerResponse = {
      id: payload.id,
      type: 'result',
      entries,
      scanMs,
      sortMs,
      matchMs,
      matchWindowCount,
      matchLogCount,
      matchSkipped,
      matches: resolved,
      profile,
    }
    ctx.postMessage(response)
  } catch (error) {
    const response: MatchWorkerResponse = {
      id: payload.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
    ctx.postMessage(response)
  }
}
