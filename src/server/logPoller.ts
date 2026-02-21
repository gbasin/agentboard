import { logger } from './logger'
import { config } from './config'
import type { SessionDatabase } from './db'
import { getLogSearchDirs } from './logDiscovery'
import { DEFAULT_SCROLLBACK_LINES, extractLastEntryTimestamp, isToolNotificationText } from './logMatcher'
import { deriveDisplayName } from './agentSessions'
import { generateUniqueSessionName } from './nameGenerator'
import type { SessionRegistry } from './SessionRegistry'
import { LogMatchWorkerClient } from './logMatchWorkerClient'
import { LogWatcher } from './logWatcher'
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
const MIN_LOG_TOKENS_FOR_INSERT = 1
const REMATCH_COOLDOWN_MS = 60 * 1000 // 1 minute between re-match attempts

// Type for session records from the database
interface SessionRecord {
  sessionId: string
  logFilePath: string | null
  projectPath: string | null
  slug: string | null
  agentType: string | null
  displayName: string
  createdAt: string
  lastActivityAt: string
  lastUserMessage: string | null
  currentWindow: string | null
  isPinned: boolean
  lastResumeError: string | null
  lastKnownLogSize: number | null
  isCodexExec: boolean
}

// Fields that applyLogEntryToExistingRecord may update
type SessionUpdate = Pick<
  SessionRecord,
  | 'lastActivityAt'
  | 'lastUserMessage'
  | 'lastKnownLogSize'
  | 'isCodexExec'
  | 'slug'
>

/**
 * Computes the update object for an existing session record based on a log entry.
 * Shared logic between the "existing by logPath" and "existing by sessionId" branches.
 * Uses file size comparison to detect actual log growth (not just mtime changes from backups/syncs).
 */
function applyLogEntryToExistingRecord(
  record: SessionRecord,
  entry: LogEntrySnapshot,
  opts: { isLastUserMessageLocked: boolean; logPath: string }
): Partial<SessionUpdate> | null {
  const update: Partial<SessionUpdate> = {}

  // Backfill isCodexExec if the entry detected it but record doesn't have it
  if (entry.isCodexExec && !record.isCodexExec) {
    update.isCodexExec = true
  }
  // Backfill slug/project for older records that were inserted before metadata was available.
  if (!record.slug && entry.slug) {
    update.slug = entry.slug
  }

  // Use file size to detect actual log changes (mtime can change from backups/syncs)
  const lastKnownSize = record.lastKnownLogSize ?? 0
  const isFirstObservation = record.lastKnownLogSize === null
  const sizeChanged = entry.size !== lastKnownSize
  const hasGrown = entry.size > lastKnownSize

  // Enter block on size change OR first observation (to initialize null -> actual size)
  if (sizeChanged || isFirstObservation) {
    // Log size changed - could be growth or truncation/rotation
    if (hasGrown) {
      // Log grew - extract timestamp from the last entry
      const logTimestamp = extractLastEntryTimestamp(opts.logPath)
      if (logTimestamp) {
        update.lastActivityAt = logTimestamp
      } else {
        // Fallback to mtime if we can't parse a timestamp
        update.lastActivityAt = new Date(entry.mtime).toISOString()
      }
    }
    // Always update lastKnownLogSize on any size change (including truncation)
    update.lastKnownLogSize = entry.size
  }

  if (entry.lastUserMessage && !isToolNotificationText(entry.lastUserMessage)) {
    // Skip if Enter-key capture recently set a value (prevents stale log overwrites)
    if (!opts.isLastUserMessageLocked) {
      const shouldReplace =
        !record.lastUserMessage ||
        isToolNotificationText(record.lastUserMessage) ||
        (sizeChanged && entry.lastUserMessage !== record.lastUserMessage)
      if (shouldReplace) {
        update.lastUserMessage = entry.lastUserMessage
      }
    }
  }

  return Object.keys(update).length > 0 ? update : null
}

interface PollStats {
  logsScanned: number
  newSessions: number
  matches: number
  orphans: number
  errors: number
  durationMs: number
}

interface MatchWorkerClient {
  poll(
    request: Omit<MatchWorkerRequest, 'id'>,
    options?: { timeoutMs?: number }
  ): Promise<MatchWorkerResponse>
  dispose(): void
}

export class LogPoller {
  private interval: ReturnType<typeof setInterval> | null = null
  private logWatcher: LogWatcher | null = null
  private db: SessionDatabase
  private registry: SessionRegistry
  private onSessionOrphaned?: (sessionId: string, supersededBy?: string) => void
  private onSessionActivated?: (sessionId: string, window: string) => void
  private isLastUserMessageLocked?: (tmuxWindow: string) => boolean
  private maxLogsPerPoll: number
  private matchProfile: boolean
  private rgThreads?: number
  private matchWorker: MatchWorkerClient | null
  private pollInFlight = false
  private orphanRematchPending = true
  private orphanRematchInProgress = false
  private orphanRematchPromise: Promise<void> | null = null
  private warnedWorkerDisabled = false
  private startupLastMessageBackfillPending = true
  // Cache of empty logs: logPath -> size when checked (re-check if size changes)
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
      onSessionOrphaned?: (sessionId: string, supersededBy?: string) => void
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

  start(intervalMs = DEFAULT_INTERVAL_MS, mode: 'poll' | 'watch' = 'poll'): void {
    if (this.interval || this.logWatcher) return
    if (intervalMs <= 0) {
      return
    }
    if (mode === 'watch') {
      this.startWatchMode(intervalMs)
      return
    }
    this.startPollMode(intervalMs)
  }

  private startPollMode(intervalMs: number): void {
    const safeInterval = Math.max(MIN_INTERVAL_MS, intervalMs)
    this.interval = setInterval(() => {
      void this.pollOnce()
    }, safeInterval)
    // Start orphan rematch after first poll completes to avoid worker contention
    void this.pollOnce().then(() => {
      if (this.orphanRematchPending && !this.orphanRematchInProgress) {
        this.orphanRematchPromise = this.runOrphanRematchInBackground()
      }
    })
  }

  private startWatchMode(fallbackIntervalMs: number): void {
    const watchDirs = getLogSearchDirs()
    this.logWatcher = new LogWatcher({
      dirs: watchDirs,
      debounceMs: 2000,
      maxWaitMs: 5000,
      onBatch: (paths) => void this.pollChanged(paths),
    })
    this.logWatcher.start()

    // On Linux, fs.watch({ recursive: true }) has known bugs (Bun #15939:
    // doesn't detect files in newly-created subdirectories), so use a shorter
    // fallback interval to avoid regressing from the default 5s poll mode.
    const minFallback = process.platform === 'linux' ? 15_000 : 60_000
    this.interval = setInterval(() => {
      void this.pollOnce()
    }, Math.max(fallbackIntervalMs, minFallback))

    void this.pollOnce().then(() => {
      if (this.orphanRematchPending && !this.orphanRematchInProgress) {
        this.orphanRematchPromise = this.runOrphanRematchInBackground()
      }
    })
  }

  /** Wait for the background orphan rematch to complete (for testing) */
  async waitForOrphanRematch(): Promise<void> {
    if (this.orphanRematchPromise) {
      await this.orphanRematchPromise
    }
  }

  private async runOrphanRematchInBackground(): Promise<void> {
    if (this.orphanRematchInProgress || !this.orphanRematchPending) {
      return
    }
    if (!this.matchWorker) {
      this.orphanRematchPending = false
      logger.info('orphan_rematch_skip', { reason: 'match_worker_disabled' })
      return
    }
    this.orphanRematchPending = false
    this.orphanRematchInProgress = true

    // Use the existing match worker for orphan rematch; skip if disabled.
    const orphanWorker = this.matchWorker

    try {
      const windows = this.registry.getAll()
      const logDirs = getLogSearchDirs()
      const sessionRecords = [
        ...this.db.getActiveSessions(),
        ...this.db.getInactiveSessions(),
      ]

      // Build orphan candidates - sessions without active windows
      const orphanCandidates: OrphanCandidate[] = []
      for (const record of sessionRecords) {
        if (record.currentWindow) continue
        const logFilePath = record.logFilePath
        if (!logFilePath) continue
        // Skip sessions from excluded project directories
        // Use "<empty>" as a special marker to exclude sessions with no project path
        if (config.excludeProjects?.length > 0) {
          const projectPath = record.projectPath ?? ''
          const shouldExclude = config.excludeProjects.some((excluded) => {
            if (excluded === '<empty>') return projectPath === ''
            return projectPath.startsWith(excluded)
          })
          if (shouldExclude) continue
        }
        orphanCandidates.push({
          sessionId: record.sessionId,
          logFilePath,
          projectPath: record.projectPath ?? null,
          agentType: record.agentType ?? null,
          currentWindow: record.currentWindow ?? null,
        })
      }

      if (orphanCandidates.length === 0) {
        logger.info('orphan_rematch_skip', { reason: 'no_orphans' })
        return
      }

      logger.info('orphan_rematch_start', { orphanCount: orphanCandidates.length })

      // Run orphan rematch on dedicated worker - doesn't block regular polling
      const sessions: SessionSnapshot[] = sessionRecords.map((session) => ({
        sessionId: session.sessionId,
        logFilePath: session.logFilePath,
        currentWindow: session.currentWindow,
        lastActivityAt: session.lastActivityAt,
        lastUserMessage: session.lastUserMessage,
        lastKnownLogSize: null, // Force re-check for orphan matching
      }))

      // Use longer timeout for orphan rematch since it processes many files
      const response = await orphanWorker.poll(
        {
          windows,
          logDirs,
          maxLogsPerPoll: 1, // We only care about orphan matching, not batch scanning
          sessions,
          knownSessions: [],
          scrollbackLines: DEFAULT_SCROLLBACK_LINES,
          minTokensForMatch: MIN_LOG_TOKENS_FOR_INSERT,
          forceOrphanRematch: true,
          orphanCandidates,
          lastMessageCandidates: [],
          skipMatchingPatterns: config.skipMatchingPatterns,
          search: {
            rgThreads: this.rgThreads,
          },
        },
        { timeoutMs: 120000 } // 2 minutes for orphan rematch
      )

      // Process orphan matches
      const windowsByTmux = new Map(
        windows.map((window) => [window.tmuxWindow, window])
      )
      // Track claimed windows and matched orphan sessionIds for name fallback
      const claimedWindows = new Set(
        this.db
          .getActiveSessions()
          .map((s) => s.currentWindow)
          .filter(Boolean) as string[]
      )
      const matchedOrphanSessionIds = new Set<string>()
      let orphanMatches = 0

      for (const match of response.orphanMatches ?? []) {
        const window = windowsByTmux.get(match.tmuxWindow)
        if (!window) continue

        const existing = this.db.getSessionByLogPath(match.logPath)
        if (existing && !existing.currentWindow) {
          // Check if window is already claimed by another session
          if (claimedWindows.has(match.tmuxWindow)) {
            logger.info('orphan_rematch_skipped_window_claimed', {
              sessionId: existing.sessionId,
              window: match.tmuxWindow,
              claimedBySessionId: this.db.getSessionByWindow(match.tmuxWindow)?.sessionId,
            })
            continue
          }
          this.db.updateSession(existing.sessionId, {
            currentWindow: match.tmuxWindow,
            displayName: window.name,
          })
          claimedWindows.add(match.tmuxWindow)
          matchedOrphanSessionIds.add(existing.sessionId)
          this.onSessionActivated?.(existing.sessionId, match.tmuxWindow)
          logger.info('orphan_rematch_success', {
            sessionId: existing.sessionId,
            window: match.tmuxWindow,
            displayName: window.name,
          })
          orphanMatches++
        }
      }

      // Name-based fallback for orphans that didn't get content-matched
      const unmatchedOrphans = orphanCandidates.filter(
        (o) => !matchedOrphanSessionIds.has(o.sessionId)
      )

      if (unmatchedOrphans.length > 0) {
        // Build map of unclaimed window name -> window (only if name is unique)
        // Only consider managed windows to avoid cross-session misassociation.
        const unclaimedByName = new Map<string, Session>()
        const ambiguousNames = new Set<string>()
        for (const window of windows) {
          if (window.source !== 'managed') continue
          if (claimedWindows.has(window.tmuxWindow)) continue
          if (ambiguousNames.has(window.name)) continue
          if (unclaimedByName.has(window.name)) {
            // Multiple windows with same name - mark as ambiguous, don't use for fallback
            unclaimedByName.delete(window.name)
            ambiguousNames.add(window.name)
            continue
          }
          unclaimedByName.set(window.name, window)
        }

        // Match unmatched orphans by display name
        for (const orphan of unmatchedOrphans) {
          const existing = this.db.getSessionByLogPath(orphan.logFilePath)
          if (!existing || existing.currentWindow) continue

          const window = unclaimedByName.get(existing.displayName)
          if (window) {
            this.db.updateSession(existing.sessionId, {
              currentWindow: window.tmuxWindow,
              displayName: window.name,
            })
            claimedWindows.add(window.tmuxWindow)
            unclaimedByName.delete(existing.displayName)
            this.onSessionActivated?.(existing.sessionId, window.tmuxWindow)
            logger.info('orphan_rematch_name_fallback', {
              sessionId: existing.sessionId,
              displayName: existing.displayName,
              window: window.tmuxWindow,
            })
            orphanMatches++
          }
        }
      }

      logger.info('orphan_rematch_complete', {
        orphanCount: orphanCandidates.length,
        matches: orphanMatches,
      })
    } catch (error) {
      logger.warn('orphan_rematch_error', {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.orphanRematchInProgress = false
    }
  }

  /**
   * Stop the log poller and dispose all resources.
   * LogPoller is single-use: after stop(), the match worker is permanently
   * disposed and the instance cannot be restarted. Create a new instance
   * if polling needs to resume.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
    }
    this.interval = null
    this.logWatcher?.stop()
    this.logWatcher = null
    this.matchWorker?.dispose()
    this.matchWorker = null
  }

  async pollChanged(changedPaths: string[]): Promise<void> {
    if (this.pollInFlight) return
    this.pollInFlight = true

    try {
      if (!this.matchWorker) return

      const windows = this.registry.getAll()
      const logDirs = getLogSearchDirs()
      const sessionRecords = [
        ...this.db.getActiveSessions(),
        ...this.db.getInactiveSessions(),
      ]
      const sessions: SessionSnapshot[] = sessionRecords.map((session) => ({
        sessionId: session.sessionId,
        logFilePath: session.logFilePath,
        currentWindow: session.currentWindow,
        lastActivityAt: session.lastActivityAt,
        lastUserMessage: session.lastUserMessage,
        lastKnownLogSize: session.lastKnownLogSize,
      }))
      const knownSessions: KnownSession[] = sessionRecords
        .filter((session) => session.logFilePath)
        .map((session) => ({
          logFilePath: session.logFilePath,
          sessionId: session.sessionId,
          projectPath: session.projectPath ?? null,
          slug: session.slug ?? null,
          agentType: session.agentType ?? null,
          isCodexExec: session.isCodexExec,
        }))

      const response = await this.matchWorker.poll({
        windows,
        logDirs,
        maxLogsPerPoll: this.maxLogsPerPoll,
        sessions,
        knownSessions,
        scrollbackLines: DEFAULT_SCROLLBACK_LINES,
        minTokensForMatch: MIN_LOG_TOKENS_FOR_INSERT,
        forceOrphanRematch: false,
        orphanCandidates: [],
        lastMessageCandidates: [],
        skipMatchingPatterns: config.skipMatchingPatterns,
        preFilteredPaths: changedPaths,
        search: {
          rgThreads: this.rgThreads,
        },
      })

      this.processMatchResponse(response, windows, sessionRecords)
    } catch (error) {
      logger.warn('log_poll_changed_error', {
        message: error instanceof Error ? error.message : String(error),
        pathCount: changedPaths.length,
      })
    } finally {
      this.pollInFlight = false
    }
  }

  private processMatchResponse(
    response: MatchWorkerResponse,
    windows: Session[],
    sessionRecords: SessionRecord[]
  ): PollStats {
    let logsScanned = 0
    let newSessions = 0
    let matches = 0
    let orphans = 0
    let errors = 0
    let entries = response.entries ?? []
    const orphanEntries = response.orphanEntries ?? []
    const sessions: SessionSnapshot[] = sessionRecords
      .filter(
        (session): session is SessionRecord & { logFilePath: string } =>
          Boolean(session.logFilePath)
      )
      .map((session) => ({
        sessionId: session.sessionId,
        logFilePath: session.logFilePath,
        currentWindow: session.currentWindow,
        lastActivityAt: session.lastActivityAt,
        lastUserMessage: session.lastUserMessage,
        lastKnownLogSize: session.lastKnownLogSize,
      }))

    const exactWindowMatches = new Map<string, Session>()
    const windowsByTmux = new Map(
      windows.map((window) => [window.tmuxWindow, window])
    )
    for (const match of response.matches ?? []) {
      const window = windowsByTmux.get(match.tmuxWindow)
      if (!window) continue
      exactWindowMatches.set(match.logPath, window)
    }

    const entriesToMatch = getEntriesNeedingMatch(response.entries ?? [], sessions, {
      minTokens: MIN_LOG_TOKENS_FOR_INSERT,
      skipMatchingPatterns: config.skipMatchingPatterns,
    })
    const matchEligibleLogPaths = new Set(
      entriesToMatch.map((entry) => entry.logPath)
    )
    for (const entry of orphanEntries) {
      matchEligibleLogPaths.add(entry.logPath)
    }

    if (orphanEntries.length > 0) {
      entries = [...entries, ...orphanEntries]
    }

    for (const entry of entries) {
      logsScanned += 1
      try {
        const existing = this.db.getSessionByLogPath(entry.logPath)
        if (existing) {
          // Use file size to detect actual log growth (mtime is unreliable due to backups/syncs)
          const hasGrown = entry.size > (existing.lastKnownLogSize ?? 0)
          const isLocked = Boolean(
            existing.currentWindow &&
            this.isLastUserMessageLocked?.(existing.currentWindow)
          )
          const update = applyLogEntryToExistingRecord(existing, entry, {
            isLastUserMessageLocked: isLocked,
            logPath: entry.logPath,
          })
          if (update) {
            this.db.updateSession(existing.sessionId, update)
          }
          const shouldAttemptRematch =
            !existing.currentWindow &&
            (hasGrown || matchEligibleLogPaths.has(entry.logPath))
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

        // Skip logs we've already checked and found empty (unless size changed)
        const cachedSize = this.emptyLogCache.get(entry.logPath)
        if (cachedSize !== undefined && cachedSize >= entry.size) {
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
          this.emptyLogCache.set(entry.logPath, entry.size)
          continue
        }
        const projectPath = entry.projectPath ?? ''
        const createdAt = new Date(entry.birthtime || entry.mtime).toISOString()
        // Extract timestamp from log entry for accurate activity time (mtime is unreliable due to backups/syncs)
        const logTimestamp = extractLastEntryTimestamp(entry.logPath)
        const lastActivityAt = logTimestamp || new Date(entry.mtime).toISOString()

        const existingById = this.db.getSessionById(sessionId)
        if (existingById) {
          // Use file size to detect actual log growth
          const hasGrown = entry.size > (existingById.lastKnownLogSize ?? 0)
          const isLocked = Boolean(
            existingById.currentWindow &&
            this.isLastUserMessageLocked?.(existingById.currentWindow)
          )
          const updateById = applyLogEntryToExistingRecord(existingById, entry, {
            isLastUserMessageLocked: isLocked,
            logPath: entry.logPath,
          })
          if (updateById) {
            this.db.updateSession(sessionId, updateById)
          }

          // Re-attempt matching for orphaned sessions (no currentWindow)
          const shouldAttemptRematch =
            !existingById.currentWindow &&
            (hasGrown || matchEligibleLogPaths.has(entry.logPath))
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
          this.emptyLogCache.set(entry.logPath, entry.size)
          logger.info('log_match_skipped', {
            logPath: entry.logPath,
            reason: 'too_few_tokens',
            minTokens: MIN_LOG_TOKENS_FOR_INSERT,
            logTokens: logTokenCount,
          })
          continue
        }

        // Slug-based supersede: if this session shares a slug with an active session
        // in the same project, it's a plan→execute transition. Supersede the old session.
        const slug = entry.slug ?? null
        let supersededWindow: string | null = null
        let inheritPinned = false
        let inheritDisplayName: string | null = null
        if (slug) {
          const slugMatch = this.db.getActiveSessionBySlugAndProject(
            slug,
            projectPath
          )
          if (slugMatch && slugMatch.sessionId !== sessionId) {
            supersededWindow = slugMatch.currentWindow
            inheritPinned = slugMatch.isPinned
            inheritDisplayName = slugMatch.displayName
            this.db.updateSession(slugMatch.sessionId, {
              currentWindow: null,
              isPinned: false,
            })
            this.onSessionOrphaned?.(slugMatch.sessionId, sessionId)
            logger.info('session_superseded_by_slug', {
              oldSessionId: slugMatch.sessionId,
              newSessionId: sessionId,
              slug,
              window: supersededWindow,
              pinTransferred: inheritPinned,
            })
          }
        }

        const matchedWindow = exactMatch
        let currentWindow: string | null = supersededWindow ?? matchedWindow?.tmuxWindow ?? null
        if (currentWindow) {
          const existingForWindow = this.db.getSessionByWindow(currentWindow)
          if (existingForWindow && existingForWindow.sessionId !== sessionId) {
            // Window already claimed by another session - don't steal it
            // The new session will be created as orphaned and can match later
            // if/when the existing session releases the window
            logger.info('log_match_skipped_window_claimed', {
              logPath: entry.logPath,
              sessionId,
              matchedWindow: currentWindow,
              claimedBySessionId: existingForWindow.sessionId,
            })
            currentWindow = null
          } else {
            matches += 1
          }
        }

        let displayName = inheritDisplayName ?? deriveDisplayName(
          projectPath,
          sessionId,
          matchedWindow?.name
        )

        // Ensure display name is unique across all sessions (skip check for inherited names)
        if (!inheritDisplayName && this.db.displayNameExists(displayName)) {
          displayName = generateUniqueSessionName((name) =>
            this.db.displayNameExists(name)
          )
        }

        this.db.insertSession({
          sessionId,
          logFilePath: entry.logPath,
          projectPath,
          slug,
          agentType,
          displayName,
          createdAt,
          lastActivityAt,
          lastUserMessage: currentWindow ? null : (entry.lastUserMessage ?? null),
          currentWindow,
          isPinned: inheritPinned,
          lastResumeError: null,
          lastKnownLogSize: entry.size,
          isCodexExec: entry.isCodexExec,
        })
        newSessions += 1
        if (currentWindow) {
          this.onSessionActivated?.(sessionId, currentWindow)
        } else {
          orphans += 1
        }
      } catch (error) {
        errors += 1
        logger.warn('log_poll_error', {
          logPath: entry.logPath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      logsScanned,
      newSessions,
      matches,
      orphans,
      errors,
      durationMs: 0,
    }
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
    let workerErrors = 0

    try {
      const windows = this.registry.getAll()
      const logDirs = getLogSearchDirs()
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
        lastKnownLogSize: session.lastKnownLogSize,
      }))
      const knownSessions: KnownSession[] = sessionRecords
        .filter((session) => session.logFilePath)
        .map((session) => ({
          logFilePath: session.logFilePath,
          sessionId: session.sessionId,
          projectPath: session.projectPath ?? null,
          slug: session.slug ?? null,
          agentType: session.agentType ?? null,
          isCodexExec: session.isCodexExec,
        }))

      const lastMessageCandidates: LastMessageCandidate[] = []
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

      let response: MatchWorkerResponse | null = null
      if (!this.matchWorker) {
        if (!this.warnedWorkerDisabled) {
          this.warnedWorkerDisabled = true
          logger.warn('log_match_worker_disabled', {
            message: 'Log polling requires match worker; skipping cycle',
          })
        }
        workerErrors += 1
      } else {
        try {
          response = await this.matchWorker.poll({
            windows,
            logDirs,
            maxLogsPerPoll: shouldBackfillLastMessage
              ? Math.max(this.maxLogsPerPoll, STARTUP_LAST_MESSAGE_BACKFILL_MAX)
              : this.maxLogsPerPoll,
            sessions,
            knownSessions,
            scrollbackLines: DEFAULT_SCROLLBACK_LINES,
            minTokensForMatch: MIN_LOG_TOKENS_FOR_INSERT,
            forceOrphanRematch: false,
            orphanCandidates: [],
            lastMessageCandidates,
            skipMatchingPatterns: config.skipMatchingPatterns,
            search: {
              rgThreads: this.rgThreads,
              profile: this.matchProfile,
            },
          })

          if (this.startupLastMessageBackfillPending && shouldBackfillLastMessage) {
            this.startupLastMessageBackfillPending = false
          }
        } catch (error) {
          workerErrors += 1
          logger.warn('log_match_worker_error', {
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (response?.profile) {
        logger.info('log_match_profile', {
          windowCount: windows.length,
          logCount: (response.entries ?? []).length,
          scanMs: response.scanMs ?? 0,
          sortMs: response.sortMs ?? 0,
          matchMs: response.matchMs ?? 0,
          matchWindowCount: response.matchWindowCount ?? 0,
          matchLogCount: response.matchLogCount ?? 0,
          matchSkipped: response.matchSkipped ?? false,
          ...response.profile,
        })
      }

      const processed = response
        ? this.processMatchResponse(response, windows, sessionRecords)
        : {
            logsScanned: 0,
            newSessions: 0,
            matches: 0,
            orphans: 0,
            errors: 0,
            durationMs: 0,
          }

      const durationMs = Date.now() - start
      const stats: PollStats = {
        logsScanned: processed.logsScanned,
        newSessions: processed.newSessions,
        matches: processed.matches,
        orphans: processed.orphans,
        errors: processed.errors + workerErrors,
        durationMs,
      }

      logger.info('log_poll', { ...stats })
      return stats
    } finally {
      this.pollInFlight = false
    }
  }
}
