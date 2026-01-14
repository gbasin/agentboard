import { logger } from './logger'
import type { SessionDatabase } from './db'
import {
  extractProjectPath,
  extractSessionId,
  getLogBirthtime,
  getLogMtime,
  inferAgentTypeFromPath,
  scanAllLogDirs,
} from './logDiscovery'
import { findMatchingWindow, getLogTokenCount } from './logMatcher'
import { deriveDisplayName } from './agentSessions'
import type { SessionRegistry } from './SessionRegistry'

const MIN_INTERVAL_MS = 2000
const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_MAX_LOGS = 25
const MIN_LOG_TOKENS_FOR_INSERT = 10

const debugMatch = process.env.DEBUG?.includes('agentboard:match') ?? false

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
  // Cache of empty logs: logPath -> mtime when checked (re-check if mtime changes)
  private emptyLogCache: Map<string, number> = new Map()

  constructor(
    db: SessionDatabase,
    registry: SessionRegistry,
    {
      onSessionOrphaned,
      onSessionActivated,
      maxLogsPerPoll,
    }: {
      onSessionOrphaned?: (sessionId: string) => void
      onSessionActivated?: (sessionId: string, window: string) => void
      maxLogsPerPoll?: number
    } = {}
  ) {
    this.db = db
    this.registry = registry
    this.onSessionOrphaned = onSessionOrphaned
    this.onSessionActivated = onSessionActivated
    const limit = maxLogsPerPoll ?? DEFAULT_MAX_LOGS
    this.maxLogsPerPoll = Math.max(1, limit)
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.interval) return
    if (intervalMs <= 0) {
      return
    }
    const safeInterval = Math.max(MIN_INTERVAL_MS, intervalMs)
    this.interval = setInterval(() => {
      this.pollOnce()
    }, safeInterval)
    this.pollOnce()
  }

  stop(): void {
    if (!this.interval) return
    clearInterval(this.interval)
    this.interval = null
  }

  pollOnce(): PollStats {
    const start = Date.now()
    let logsScanned = 0
    let newSessions = 0
    let matches = 0
    let orphans = 0
    let errors = 0

    const windows = this.registry.getAll()
    const logPaths = scanAllLogDirs()
    const logEntries = logPaths
      .map((logPath) => {
        const mtime = getLogMtime(logPath)
        return mtime ? { logPath, mtime: mtime.getTime() } : null
      })
      .filter(Boolean) as Array<{ logPath: string; mtime: number }>

    logEntries.sort((a, b) => b.mtime - a.mtime)
    const limitedLogs = logEntries.slice(0, this.maxLogsPerPoll)

    for (const entry of limitedLogs) {
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

        const agentType = inferAgentTypeFromPath(entry.logPath)
        if (!agentType) {
          continue
        }

        const sessionId = extractSessionId(entry.logPath)
        if (!sessionId) {
          // No session ID yet - cache and retry on next poll when log has more content
          this.emptyLogCache.set(entry.logPath, entry.mtime)
          continue
        }
        const projectPath = extractProjectPath(entry.logPath) ?? ''
        const createdAt =
          getLogBirthtime(entry.logPath)?.toISOString() ??
          new Date(entry.mtime).toISOString()
        const lastActivityAt = new Date(entry.mtime).toISOString()

        const existingById = this.db.getSessionById(sessionId)
        if (existingById) {
          if (entry.mtime > Date.parse(existingById.lastActivityAt)) {
            this.db.updateSession(sessionId, { lastActivityAt })
          }
          continue
        }

        const result = findMatchingWindow(entry.logPath, windows)
        logger.info('log_match_attempt', {
          logPath: entry.logPath,
          windowCount: windows.length,
          matched: Boolean(result.match),
          reason: result.reason,
          matchedWindow: result.match?.tmuxWindow ?? null,
          matchedName: result.match?.name ?? null,
          bestScore: Number(result.bestScore.toFixed(4)),
          secondScore: Number(result.secondScore.toFixed(4)),
          minScore: result.minScore,
          minGap: result.minGap,
          minTokens: result.minTokens,
          bestLeftTokens: result.bestLeftTokens ?? null,
          bestRightTokens: result.bestRightTokens ?? null,
        })
        if (debugMatch && result.scores.length > 0) {
          logger.debug('log_match_scores', {
            logPath: entry.logPath,
            scores: result.scores.map((score) => ({
              tmuxWindow: score.window.tmuxWindow,
              score: Number(score.score.toFixed(4)),
            })),
            bestScore: result.bestScore,
            secondScore: result.secondScore,
          })
        }

        const logTokenCount =
          result.bestLeftTokens ?? getLogTokenCount(entry.logPath)
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

        const matchedWindow = result.match
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
  }
}
