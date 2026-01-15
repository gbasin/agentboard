import { performance } from 'node:perf_hooks'
import { logger } from './logger'
import type { SessionDatabase } from './db'
import { getLogSearchDirs } from './logDiscovery'
import {
  DEFAULT_SCROLLBACK_LINES,
  createExactMatchProfiler,
  matchWindowsToLogsByExactRg,
} from './logMatcher'
import { deriveDisplayName } from './agentSessions'
import type { SessionRegistry } from './SessionRegistry'
import { LogMatchWorkerClient } from './logMatchWorkerClient'
import type { Session } from '../shared/types'
import { collectLogEntryBatch, type LogEntrySnapshot } from './logPollData'
import {
  getEntriesNeedingMatch,
  type SessionSnapshot,
} from './logMatchGate'

const MIN_INTERVAL_MS = 2000
const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_MAX_LOGS = 25
const MIN_LOG_TOKENS_FOR_INSERT = 10
const REMATCH_COOLDOWN_MS = 60 * 1000 // 1 minute between re-match attempts

interface PollStats {
  logsScanned: number
  newSessions: number
  matches: number
  orphans: number
  errors: number
  durationMs: number
}

export class LogPoller {
  private interval: ReturnType<typeof setInterval> | null = null
  private db: SessionDatabase
  private registry: SessionRegistry
  private onSessionOrphaned?: (sessionId: string) => void
  private onSessionActivated?: (sessionId: string, window: string) => void
  private maxLogsPerPoll: number
  private matchProfile: boolean
  private rgThreads?: number
  private matchWorker: LogMatchWorkerClient | null
  private pollInFlight = false
  // Cache of empty logs: logPath -> mtime when checked (re-check if mtime changes)
  private emptyLogCache: Map<string, number> = new Map()
  // Cache of re-match attempts: sessionId -> timestamp of last attempt
  private rematchAttemptCache: Map<string, number> = new Map()

  constructor(
    db: SessionDatabase,
    registry: SessionRegistry,
    {
      onSessionOrphaned,
      onSessionActivated,
      maxLogsPerPoll,
      matchProfile,
      rgThreads,
      matchWorker,
    }: {
      onSessionOrphaned?: (sessionId: string) => void
      onSessionActivated?: (sessionId: string, window: string) => void
      maxLogsPerPoll?: number
      matchProfile?: boolean
      rgThreads?: number
      matchWorker?: boolean
    } = {}
  ) {
    this.db = db
    this.registry = registry
    this.onSessionOrphaned = onSessionOrphaned
    this.onSessionActivated = onSessionActivated
    const limit = maxLogsPerPoll ?? DEFAULT_MAX_LOGS
    this.maxLogsPerPoll = Math.max(1, limit)
    this.matchProfile = matchProfile ?? false
    this.rgThreads = rgThreads
    this.matchWorker = matchWorker ? new LogMatchWorkerClient() : null
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.interval) return
    if (intervalMs <= 0) {
      return
    }
    const safeInterval = Math.max(MIN_INTERVAL_MS, intervalMs)
    this.interval = setInterval(() => {
      void this.pollOnce()
    }, safeInterval)
    void this.pollOnce()
  }

  stop(): void {
    if (!this.interval) return
    clearInterval(this.interval)
    this.interval = null
    this.matchWorker?.dispose()
    this.matchWorker = null
  }

  async pollOnce(): Promise<PollStats> {
    if (this.pollInFlight) {
      return {
        logsScanned: 0,
        newSessions: 0,
        matches: 0,
        orphans: 0,
        errors: 0,
        durationMs: 0,
      }
    }
    this.pollInFlight = true
    const start = Date.now()
    let logsScanned = 0
    let newSessions = 0
    let matches = 0
    let orphans = 0
    let errors = 0

    try {
      const windows = this.registry.getAll()
      const logDirs = getLogSearchDirs()
      let entries: LogEntrySnapshot[] = []
      const sessions: SessionSnapshot[] = [
        ...this.db.getActiveSessions(),
        ...this.db.getInactiveSessions(),
      ].map((session) => ({
        sessionId: session.sessionId,
        logFilePath: session.logFilePath,
        currentWindow: session.currentWindow,
        lastActivityAt: session.lastActivityAt,
      }))
      let exactWindowMatches = new Map<string, Session>()
      let scanMs = 0
      let sortMs = 0
      let matchMs = 0
      let matchProfile: ReturnType<typeof createExactMatchProfiler> | null = null
      let matchWindowCount = 0
      let matchLogCount = 0
      let matchSkipped = false

      if (this.matchWorker) {
        try {
          const response = await this.matchWorker.poll({
            windows,
            logDirs,
            maxLogsPerPoll: this.maxLogsPerPoll,
            sessions,
            scrollbackLines: DEFAULT_SCROLLBACK_LINES,
            minTokensForMatch: MIN_LOG_TOKENS_FOR_INSERT,
            search: {
              rgThreads: this.rgThreads,
              profile: this.matchProfile,
            },
          })
          entries = response.entries ?? []
          scanMs = response.scanMs ?? 0
          sortMs = response.sortMs ?? 0
          matchMs = response.matchMs ?? 0
          matchProfile = response.profile ?? null
          matchWindowCount = response.matchWindowCount ?? 0
          matchLogCount = response.matchLogCount ?? 0
          matchSkipped = response.matchSkipped ?? false

          const windowsByTmux = new Map(
            windows.map((window) => [window.tmuxWindow, window])
          )
          for (const match of response.matches ?? []) {
            const window = windowsByTmux.get(match.tmuxWindow)
            if (!window) continue
            exactWindowMatches.set(match.logPath, window)
          }
        } catch (error) {
          logger.warn('log_match_worker_error', {
            message: error instanceof Error ? error.message : String(error),
          })
          const fallback = collectLogEntryBatch(this.maxLogsPerPoll)
          entries = fallback.entries
          scanMs = fallback.scanMs
          sortMs = fallback.sortMs
          const matchStart = performance.now()
          if (this.matchProfile) {
            matchProfile = createExactMatchProfiler()
          }
          const entriesToMatch = getEntriesNeedingMatch(entries, sessions, {
            minTokens: MIN_LOG_TOKENS_FOR_INSERT,
          })
          if (entriesToMatch.length === 0) {
            matchMs = 0
            matchSkipped = true
          } else {
            exactWindowMatches = matchWindowsToLogsByExactRg(
              windows,
              logDirs,
              DEFAULT_SCROLLBACK_LINES,
              {
                logPaths: entriesToMatch.map((entry) => entry.logPath),
                rgThreads: this.rgThreads,
                profile: matchProfile ?? undefined,
              }
            )
            matchMs = performance.now() - matchStart
            matchWindowCount = windows.length
            matchLogCount = entriesToMatch.length
          }
        }
      } else {
        const fallback = collectLogEntryBatch(this.maxLogsPerPoll)
        entries = fallback.entries
        scanMs = fallback.scanMs
        sortMs = fallback.sortMs
        const matchStart = performance.now()
        if (this.matchProfile) {
          matchProfile = createExactMatchProfiler()
        }
        const entriesToMatch = getEntriesNeedingMatch(entries, sessions, {
          minTokens: MIN_LOG_TOKENS_FOR_INSERT,
        })
        if (entriesToMatch.length === 0) {
          matchMs = 0
          matchSkipped = true
        } else {
          exactWindowMatches = matchWindowsToLogsByExactRg(
            windows,
            logDirs,
            DEFAULT_SCROLLBACK_LINES,
            {
              logPaths: entriesToMatch.map((entry) => entry.logPath),
              rgThreads: this.rgThreads,
              profile: matchProfile ?? undefined,
            }
          )
          matchMs = performance.now() - matchStart
          matchWindowCount = windows.length
          matchLogCount = entriesToMatch.length
        }
      }

      if (matchProfile) {
        logger.info('log_match_profile', {
          windowCount: windows.length,
          logCount: entries.length,
          scanMs,
          sortMs,
          matchMs,
          matchWindowCount,
          matchLogCount,
          matchSkipped,
          ...matchProfile,
        })
      }

      for (const entry of entries) {
        logsScanned += 1
        try {
          const existing = this.db.getSessionByLogPath(entry.logPath)
          if (existing) {
            if (entry.mtime > Date.parse(existing.lastActivityAt)) {
              this.db.updateSession(existing.sessionId, {
                lastActivityAt: new Date(entry.mtime).toISOString(),
              })
            }
            continue
          }

          // Skip logs we've already checked and found empty (unless mtime changed)
          const cachedMtime = this.emptyLogCache.get(entry.logPath)
          if (cachedMtime !== undefined && cachedMtime >= entry.mtime) {
            continue
          }

          const agentType = entry.agentType
          if (!agentType) {
            continue
          }

          // Skip Codex subagent logs (e.g., review agents spawned by CLI)
          if (agentType === 'codex' && entry.isCodexSubagent) {
            continue
          }

          const sessionId = entry.sessionId
          if (!sessionId) {
            // No session ID yet - cache and retry on next poll when log has more content
            this.emptyLogCache.set(entry.logPath, entry.mtime)
            continue
          }
          const projectPath = entry.projectPath ?? ''
          const createdAt = new Date(entry.birthtime || entry.mtime).toISOString()
          const lastActivityAt = new Date(entry.mtime).toISOString()

          const existingById = this.db.getSessionById(sessionId)
          if (existingById) {
            const hasActivity = entry.mtime > Date.parse(existingById.lastActivityAt)
            if (hasActivity) {
              this.db.updateSession(sessionId, { lastActivityAt })
            }

            // Re-attempt matching for orphaned sessions (no currentWindow)
            if (!existingById.currentWindow && hasActivity) {
              const lastAttempt = this.rematchAttemptCache.get(sessionId) ?? 0
              if (Date.now() - lastAttempt > REMATCH_COOLDOWN_MS) {
                this.rematchAttemptCache.set(sessionId, Date.now())
                const exactMatch = exactWindowMatches.get(entry.logPath) ?? null
                if (exactMatch) {
                  const claimed = this.db.getSessionByWindow(exactMatch.tmuxWindow)
                  if (!claimed) {
                    this.db.updateSession(sessionId, {
                      currentWindow: exactMatch.tmuxWindow,
                      displayName: exactMatch.name,
                    })
                    logger.info('session_rematched', {
                      sessionId,
                      window: exactMatch.tmuxWindow,
                      displayName: exactMatch.name,
                    })
                    this.onSessionActivated?.(sessionId, exactMatch.tmuxWindow)
                  }
                }
              }
            }
            continue
          }

          const exactMatch = exactWindowMatches.get(entry.logPath) ?? null
          logger.info('log_match_attempt', {
            logPath: entry.logPath,
            windowCount: windows.length,
            matched: Boolean(exactMatch),
            method: 'exact-rg',
            matchedWindow: exactMatch?.tmuxWindow ?? null,
            matchedName: exactMatch?.name ?? null,
          })

          const logTokenCount = entry.logTokenCount
          if (logTokenCount < MIN_LOG_TOKENS_FOR_INSERT) {
            // Cache this empty log so we don't re-check it every poll
            this.emptyLogCache.set(entry.logPath, entry.mtime)
            logger.info('log_match_skipped', {
              logPath: entry.logPath,
              reason: 'too_few_tokens',
              minTokens: MIN_LOG_TOKENS_FOR_INSERT,
              logTokens: logTokenCount,
            })
            continue
          }

          const matchedWindow = exactMatch
          let currentWindow: string | null = matchedWindow?.tmuxWindow ?? null
          if (currentWindow) {
            matches += 1
            const existingForWindow = this.db.getSessionByWindow(currentWindow)
            if (existingForWindow && existingForWindow.sessionId !== sessionId) {
              this.db.orphanSession(existingForWindow.sessionId)
              orphans += 1
              this.onSessionOrphaned?.(existingForWindow.sessionId)
            }
          }

          const displayName = deriveDisplayName(
            projectPath,
            sessionId,
            matchedWindow?.name
          )

          this.db.insertSession({
            sessionId,
            logFilePath: entry.logPath,
            projectPath,
            agentType,
            displayName,
            createdAt,
            lastActivityAt,
            currentWindow,
          })
          newSessions += 1
          if (currentWindow) {
            this.onSessionActivated?.(sessionId, currentWindow)
          }
        } catch (error) {
          errors += 1
          logger.warn('log_poll_error', {
            logPath: entry.logPath,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const durationMs = Date.now() - start
      logger.info('log_poll', {
        logsScanned,
        newSessions,
        matches,
        orphans,
        errors,
        durationMs,
      })

      return { logsScanned, newSessions, matches, orphans, errors, durationMs }
    } finally {
      this.pollInFlight = false
    }
  }
}
