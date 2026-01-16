import { logger } from './logger'
import type { SessionDatabase } from './db'
import { getLogSearchDirs } from './logDiscovery'
import { DEFAULT_SCROLLBACK_LINES, isToolNotificationText } from './logMatcher'
import { deriveDisplayName } from './agentSessions'
import { generateUniqueSessionName } from './nameGenerator'
import type { SessionRegistry } from './SessionRegistry'
import { LogMatchWorkerClient } from './logMatchWorkerClient'
import type { Session } from '../shared/types'
import type { KnownSession, LogEntrySnapshot } from './logPollData'
import {
  getEntriesNeedingMatch,
  type SessionSnapshot,
} from './logMatchGate'
import type {
  MatchWorkerRequest,
  MatchWorkerResponse,
  OrphanCandidate,
  LastMessageCandidate,
} from './logMatchWorkerTypes'

const MIN_INTERVAL_MS = 2000
const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_MAX_LOGS = 25
const STARTUP_LAST_MESSAGE_BACKFILL_MAX = 100
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

interface MatchWorkerClient {
  poll(request: Omit<MatchWorkerRequest, 'id'>): Promise<MatchWorkerResponse>
  dispose(): void
}

export class LogPoller {
  private interval: ReturnType<typeof setInterval> | null = null
  private db: SessionDatabase
  private registry: SessionRegistry
  private onSessionOrphaned?: (sessionId: string) => void
  private onSessionActivated?: (sessionId: string, window: string) => void
  private isLastUserMessageLocked?: (tmuxWindow: string) => boolean
  private maxLogsPerPoll: number
  private matchProfile: boolean
  private rgThreads?: number
  private matchWorker: MatchWorkerClient | null
  private pollInFlight = false
  private forceOrphanRematch = true
  private warnedWorkerDisabled = false
  private startupLastMessageBackfillPending = true
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
      isLastUserMessageLocked,
      maxLogsPerPoll,
      matchProfile,
      rgThreads,
      matchWorker,
      matchWorkerClient,
    }: {
      onSessionOrphaned?: (sessionId: string) => void
      onSessionActivated?: (sessionId: string, window: string) => void
      isLastUserMessageLocked?: (tmuxWindow: string) => boolean
      maxLogsPerPoll?: number
      matchProfile?: boolean
      rgThreads?: number
      matchWorker?: boolean
      matchWorkerClient?: MatchWorkerClient
    } = {}
  ) {
    this.db = db
    this.registry = registry
    this.onSessionOrphaned = onSessionOrphaned
    this.onSessionActivated = onSessionActivated
    this.isLastUserMessageLocked = isLastUserMessageLocked
    const limit = maxLogsPerPoll ?? DEFAULT_MAX_LOGS
    this.maxLogsPerPoll = Math.max(1, limit)
    this.matchProfile = matchProfile ?? false
    this.rgThreads = rgThreads
    this.matchWorker =
      matchWorkerClient ??
      (matchWorker ? (new LogMatchWorkerClient() as MatchWorkerClient) : null)
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
    const forceOrphanRematch = this.forceOrphanRematch
    if (this.forceOrphanRematch) {
      this.forceOrphanRematch = false
    }
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
      const sessionRecords = [
        ...this.db.getActiveSessions(),
        ...this.db.getInactiveSessions(),
      ]
      let shouldBackfillLastMessage = false
      if (this.startupLastMessageBackfillPending) {
        shouldBackfillLastMessage = sessionRecords.some(
          (session) =>
            !session.lastUserMessage ||
            isToolNotificationText(session.lastUserMessage)
        )
        if (!shouldBackfillLastMessage) {
          this.startupLastMessageBackfillPending = false
        }
      }
      const sessions: SessionSnapshot[] = sessionRecords.map((session) => ({
        sessionId: session.sessionId,
        logFilePath: session.logFilePath,
        currentWindow: session.currentWindow,
        lastActivityAt: session.lastActivityAt,
        lastUserMessage: session.lastUserMessage,
      }))
      // Build known sessions list to skip expensive file reads for already-tracked logs
      const knownSessions: KnownSession[] = sessionRecords
        .filter((session) => session.logFilePath)
        .map((session) => ({
          logFilePath: session.logFilePath,
          sessionId: session.sessionId,
          projectPath: session.projectPath ?? null,
          agentType: session.agentType ?? null,
        }))
      const matchSessions = forceOrphanRematch
        ? sessions.map((session) =>
            session.currentWindow
              ? session
              : { ...session, lastActivityAt: '' }
          )
        : sessions
      let exactWindowMatches = new Map<string, Session>()
      let entriesToMatch: LogEntrySnapshot[] = []
      let orphanEntries: LogEntrySnapshot[] = []
      let scanMs = 0
      let sortMs = 0
      let matchMs = 0
      let matchProfile: MatchWorkerResponse['profile'] | null = null
      let matchWindowCount = 0
      let matchLogCount = 0
      let matchSkipped = false

      const orphanCandidates: OrphanCandidate[] = []
      const lastMessageCandidates: LastMessageCandidate[] = []
      if (forceOrphanRematch) {
        for (const record of sessionRecords) {
          if (record.currentWindow) continue
          const logFilePath = record.logFilePath
          if (!logFilePath) continue
          orphanCandidates.push({
            sessionId: record.sessionId,
            logFilePath,
            projectPath: record.projectPath ?? null,
            agentType: record.agentType ?? null,
            currentWindow: record.currentWindow ?? null,
          })
        }
      }
      if (this.startupLastMessageBackfillPending) {
        for (const record of sessionRecords) {
          if (!record.currentWindow) continue
          if (
            record.lastUserMessage &&
            !isToolNotificationText(record.lastUserMessage)
          ) {
            continue
          }
          const logFilePath = record.logFilePath
          if (!logFilePath) continue
          lastMessageCandidates.push({
            sessionId: record.sessionId,
            logFilePath,
            projectPath: record.projectPath ?? null,
            agentType: record.agentType ?? null,
          })
        }
      }

      if (!this.matchWorker) {
        if (!this.warnedWorkerDisabled) {
          this.warnedWorkerDisabled = true
          logger.warn('log_match_worker_disabled', {
            message: 'Log polling requires match worker; skipping cycle',
          })
        }
        if (forceOrphanRematch) {
          this.forceOrphanRematch = true
        }
        errors += 1
        matchSkipped = true
      } else {
        try {
          const response = await this.matchWorker.poll({
            windows,
            logDirs,
            maxLogsPerPoll: shouldBackfillLastMessage
              ? Math.max(this.maxLogsPerPoll, STARTUP_LAST_MESSAGE_BACKFILL_MAX)
              : this.maxLogsPerPoll,
            sessions: matchSessions,
            knownSessions,
            scrollbackLines: DEFAULT_SCROLLBACK_LINES,
            minTokensForMatch: MIN_LOG_TOKENS_FOR_INSERT,
            forceOrphanRematch,
            orphanCandidates,
            lastMessageCandidates,
            search: {
              rgThreads: this.rgThreads,
              profile: this.matchProfile,
            },
          })
          if (this.startupLastMessageBackfillPending && shouldBackfillLastMessage) {
            this.startupLastMessageBackfillPending = false
          }
          entries = response.entries ?? []
          orphanEntries = response.orphanEntries ?? []
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
          for (const match of response.orphanMatches ?? []) {
            if (exactWindowMatches.has(match.logPath)) continue
            const window = windowsByTmux.get(match.tmuxWindow)
            if (!window) continue
            exactWindowMatches.set(match.logPath, window)
          }
          entriesToMatch = getEntriesNeedingMatch(entries, matchSessions, {
            minTokens: MIN_LOG_TOKENS_FOR_INSERT,
          })
        } catch (error) {
          errors += 1
          logger.warn('log_match_worker_error', {
            message: error instanceof Error ? error.message : String(error),
          })
          if (forceOrphanRematch) {
            this.forceOrphanRematch = true
          }
          matchSkipped = true
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

      if (orphanEntries.length > 0) {
        entries = [...entries, ...orphanEntries]
      }

      const matchEligibleLogPaths = new Set(
        entriesToMatch.map((entry) => entry.logPath)
      )
      for (const entry of orphanEntries) {
        matchEligibleLogPaths.add(entry.logPath)
      }

      for (const entry of entries) {
        logsScanned += 1
        try {
          const existing = this.db.getSessionByLogPath(entry.logPath)
          if (existing) {
            const hasActivity = entry.mtime > Date.parse(existing.lastActivityAt)
            const update: Partial<typeof existing> = {}
            if (hasActivity) {
              update.lastActivityAt = new Date(entry.mtime).toISOString()
            }
            if (entry.lastUserMessage && !isToolNotificationText(entry.lastUserMessage)) {
              // Skip if Enter-key capture recently set a value (prevents stale log overwrites)
              const isLocked = existing.currentWindow && this.isLastUserMessageLocked?.(existing.currentWindow)
              if (!isLocked) {
                const shouldReplace =
                  !existing.lastUserMessage ||
                  isToolNotificationText(existing.lastUserMessage) ||
                  (hasActivity && entry.lastUserMessage !== existing.lastUserMessage)
                if (shouldReplace) {
                  update.lastUserMessage = entry.lastUserMessage
                }
              }
            }
            if (Object.keys(update).length > 0) {
              this.db.updateSession(existing.sessionId, update)
            }
            const shouldAttemptRematch =
              !existing.currentWindow &&
              (hasActivity || matchEligibleLogPaths.has(entry.logPath))
            if (shouldAttemptRematch) {
              const lastAttempt =
                this.rematchAttemptCache.get(existing.sessionId) ?? 0
              if (Date.now() - lastAttempt > REMATCH_COOLDOWN_MS) {
                this.rematchAttemptCache.set(existing.sessionId, Date.now())
                const exactMatch = exactWindowMatches.get(entry.logPath) ?? null
                if (exactMatch) {
                  const claimed = this.db.getSessionByWindow(exactMatch.tmuxWindow)
                  if (!claimed) {
                    this.db.updateSession(existing.sessionId, {
                      currentWindow: exactMatch.tmuxWindow,
                      displayName: exactMatch.name,
                    })
                    logger.info('session_rematched', {
                      sessionId: existing.sessionId,
                      window: exactMatch.tmuxWindow,
                      displayName: exactMatch.name,
                    })
                    this.onSessionActivated?.(
                      existing.sessionId,
                      exactMatch.tmuxWindow
                    )
                  }
                }
              }
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
            const update: Partial<typeof existingById> = {}
            if (hasActivity) {
              update.lastActivityAt = lastActivityAt
            }
            if (entry.lastUserMessage && !isToolNotificationText(entry.lastUserMessage)) {
              // Skip if Enter-key capture recently set a value (prevents stale log overwrites)
              const isLocked = existingById.currentWindow && this.isLastUserMessageLocked?.(existingById.currentWindow)
              if (!isLocked) {
                const shouldReplace =
                  !existingById.lastUserMessage ||
                  isToolNotificationText(existingById.lastUserMessage) ||
                  (hasActivity &&
                    entry.lastUserMessage !== existingById.lastUserMessage)
                if (shouldReplace) {
                  update.lastUserMessage = entry.lastUserMessage
                }
              }
            }
            if (Object.keys(update).length > 0) {
              this.db.updateSession(sessionId, update)
            }

            // Re-attempt matching for orphaned sessions (no currentWindow)
            const shouldAttemptRematch =
              !existingById.currentWindow &&
              (hasActivity || matchEligibleLogPaths.has(entry.logPath))
            if (shouldAttemptRematch) {
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

          let displayName = deriveDisplayName(
            projectPath,
            sessionId,
            matchedWindow?.name
          )

          // Ensure display name is unique across all sessions
          if (this.db.displayNameExists(displayName)) {
            displayName = generateUniqueSessionName((name) =>
              this.db.displayNameExists(name)
            )
          }

          this.db.insertSession({
            sessionId,
            logFilePath: entry.logPath,
            projectPath,
            agentType,
            displayName,
            createdAt,
            lastActivityAt,
            lastUserMessage: currentWindow ? null : (entry.lastUserMessage ?? null),
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
