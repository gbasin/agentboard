// Startup verification and housekeeping for the boot path.
//
// verifyAllSessions decides whether each active agent-session row still owns
// its tmux window — worker batch preferred (pane captures, shared rg passes,
// and tail validation all run on the worker thread), inline limit-2
// concurrency fallback when the worker can't serve the request. The
// housekeeping half scrubs env vars leaked by older agentboard launches and
// prunes -ws- client sessions left unattached by the previous server.
//
// Everything here is invoked once from startupReady. index.ts injects its
// singletons via StartupLifecycleDeps so this module stays import-light and
// free of circular dependencies.
import type { AgentSessionRecord } from './db'
import type { Session, AgentType } from '../shared/types'
import type { WindowLogVerificationResult } from './logMatcher'
import { verifyWindowLogAssociationDetailedAsync } from './logMatcher'
import { DEFAULT_SCROLLBACK_LINES } from './logMatcher'
import {
  LogMatchWorkerClient,
  WorkerTimeoutError,
} from './logMatchWorkerClient'
import { mapWithConcurrency } from './mapWithConcurrency'
import { getLogSearchDirs } from './logDiscovery'
import { logger } from './logger'
import {
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from './tmuxFormat'
import { timedSpawnAsync } from './syncSpawnTiming'

export interface VerificationDecision {
  verification: WindowLogVerificationResult
  nameMatches: boolean
}

interface PendingVerifyJob {
  sessionId: string
  tmuxWindow: string
  logFilePath: string
  displayName: string
  context: { agentType: AgentType; projectPath: string }
  excludeLogPaths: string[]
}

// Inline fallback path only: when the log-match worker is unavailable, each
// verification still captures a pane and runs rg over every log directory
// (often 10+ GB) once per recent user message. Verifying every window at once
// saturated disk and CPU for minutes after a restart: rg calls hit their
// timeout and dropped matches, and the event loop stalled for seconds at a
// time. The limit only changes scheduling; each window's work is unchanged.
const STARTUP_VERIFY_CONCURRENCY = 2

// Verification runs for minutes on a large corpus — far past the worker
// client's 45s default timeout.
const STARTUP_VERIFY_WORKER_TIMEOUT_MS = 10 * 60 * 1000

let startupVerifyWorker: LogMatchWorkerClient | null = null

export interface StartupLifecycleDeps {
  config: {
    tmuxSession: string
    tmuxTimeoutMs: number
    pruneWsSessions: boolean
    logMatchWorker: boolean
    rgThreads: number
    logMatchProfile?: boolean
  }
  db: {
    getActiveSessions(): AgentSessionRecord[]
  }
  sessionManager: {
    scrubLeakedGlobalEnvironmentAsync(): Promise<string[]>
  }
  registry: {
    getAll(): Session[]
    replaceSessions(sessions: Session[]): void
  }
  hasOwnership?: (window: Session) => boolean
  /** Live websocket connections — ws sessions owned by one are not orphans. */
  sockets: ReadonlySet<{ data: { connectionId: string } }>
  liveTerminalIds?: () => Iterable<string>
  /** The module-load ensureSession verdict — the authoritative pruning
   *  decision. Re-probing after the session exists could flip an unreliable
   *  group lookup to reliable and risk killing unrecovered sessions. */
  canPruneWsSessions: boolean
  hydrateSessionsWithAgentSessions: (
    sessions: Session[],
    options?: {
      verifyAssociations?: boolean
      precomputedVerifications?: Map<string, VerificationDecision>
      serverPid?: number
    }
  ) => Session[]
  applyForceWorkingOverrides: (sessions: Session[]) => Session[]
  mergeRemoteSessions: (sessions: Session[]) => Session[]
  updateDormantAgentSessions: () => void
}

export function createStartupLifecycle(deps: StartupLifecycleDeps) {
  const { config, db, sessionManager, registry, sockets } = deps

  async function pruneOrphanedWsSessions(): Promise<void> {
    if (!config.pruneWsSessions) {
      return
    }

    const prefix = `${config.tmuxSession}-ws-`
    if (!prefix) {
      return
    }

    let result
    try {
      result = await timedSpawnAsync(
        ['tmux', ...withTmuxUtf8Flag([
          'list-sessions',
          '-F',
          buildTmuxFormat(['#{session_name}', '#{session_attached}']),
        ])],
        { timeout: config.tmuxTimeoutMs }
      )
      if (result.signalCode === 'SIGTERM' || result.exitCode === null) {
        logger.warn('ws_session_prune_skipped', {
          reason: 'tmux_timeout',
          timeoutMs: config.tmuxTimeoutMs,
        })
        return
      }
    } catch {
      return
    }

    if (result.exitCode !== 0) {
      return
    }

    const output = result.stdout
    if (!output) {
      return
    }
    const lines = splitTmuxLines(output)
    let pruned = 0

    // Pruning runs after serve, so the unattached snapshot can include a
    // live client's session whose grouped attach is still in flight. Only a
    // session owned by no current connection is an orphan — skip anything
    // named for a live connection id (covers -x- descendants too).
    const liveIds = new Set([...sockets].map((ws) => ws.data.connectionId))
    for (const id of deps.liveTerminalIds?.() ?? []) liveIds.add(id)
    const isLiveSession = (name: string) =>
      [...liveIds].some((id) => id && name.includes(id))

    for (const line of lines) {
      const parts = splitTmuxFields(line, 2)
      if (!parts) continue
      const [name, attachedRaw] = parts
      if (!name || !name.startsWith(prefix)) continue
      if (isLiveSession(name)) continue
      const attached = Number.parseInt(attachedRaw ?? '', 10)
      if (Number.isNaN(attached) || attached > 0) continue
      try {
        const killResult = await timedSpawnAsync(
          ['tmux', 'kill-session', '-t', name],
          { timeout: config.tmuxTimeoutMs }
        )
        if (killResult.signalCode === 'SIGTERM' || killResult.exitCode === null) {
          continue
        }
        if (killResult.exitCode === 0) {
          pruned += 1
        }
      } catch {
        // Ignore kill errors
      }
    }

    if (pruned > 0) {
      logger.info('ws_sessions_pruned', { count: pruned })
    }
  }

  // Scrub env vars leaked by older agentboard launches and prune ws sessions
  // left unattached by the previous server. Runs inside startupReady
  // (post-serve, post-refresh) with async spawns so none of it stacks
  // synchronous work on the boot event loop.
  async function startupHousekeeping(): Promise<void> {
    try {
      // One-time: if an older agentboard booted the tmux daemon with leaked
      // launch env (NODE_ENV=production etc.), scrub it so new windows are
      // clean. Startup only — never per refresh tick.
      const scrubbedEnvVars =
        await sessionManager.scrubLeakedGlobalEnvironmentAsync()
      if (scrubbedEnvVars.length > 0) {
        logger.info('tmux_global_env_scrubbed', { vars: scrubbedEnvVars })
      }
      if (deps.canPruneWsSessions) {
        await pruneOrphanedWsSessions()
      } else {
        logger.warn('ws_session_prune_skipped', {
          reason: 'session_group_lookup_unavailable',
        })
      }
    } catch (error) {
      logger.warn('startup_ensure_session_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function verifyAllSessions(
    activeSessions: AgentSessionRecord[],
    sessions: Session[],
    logDirs: string[]
  ): Promise<Map<string, VerificationDecision>> {
    const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
    const windowByTarget = new Map(sessions.map((session) => [session.tmuxWindow, session]))
    const allLogPaths = activeSessions
      .filter((session) => session.currentWindow)
      .map((session) => ({ sessionId: session.sessionId, logPath: session.logFilePath }))

    const decisions = new Map<string, VerificationDecision>()
    let pending: PendingVerifyJob[] = []
    for (const agentSession of activeSessions) {
      const currentWindow = agentSession.currentWindow
      if (!currentWindow || !windowSet.has(currentWindow)) {
        decisions.set(agentSession.sessionId, {
          verification: {
            status: 'inconclusive',
            bestMatch: null,
            reason: 'no_match',
          },
          nameMatches: false,
        })
        continue
      }
      const liveWindow = windowByTarget.get(currentWindow)!
      if (deps.hasOwnership?.(liveWindow)) {
        decisions.set(agentSession.sessionId, { verification: { status: 'verified', bestMatch: null }, nameMatches: false })
        continue
      }
      pending.push({
        sessionId: agentSession.sessionId,
        tmuxWindow: currentWindow,
        logFilePath: agentSession.logFilePath,
        displayName: agentSession.displayName,
        context: {
          agentType: agentSession.agentType,
          projectPath: agentSession.projectPath,
        },
        excludeLogPaths: allLogPaths
          .filter((entry) => entry.sessionId !== agentSession.sessionId)
          .map((entry) => entry.logPath),
      })
    }

    const recordDecision = (
      job: PendingVerifyJob,
      verification: WindowLogVerificationResult
    ) => {
      const window = windowByTarget.get(job.tmuxWindow)
      decisions.set(job.sessionId, {
        verification,
        nameMatches: Boolean(window && window.name === job.displayName),
      })
    }

    // Preferred path: the log-match worker does the pane captures, rg scans,
    // and tail validation off the main thread, sharing one rg pass per log
    // directory across all windows.
    if (config.logMatchWorker && pending.length > 0) {
      const verifyStart = performance.now()
      try {
        startupVerifyWorker ??= new LogMatchWorkerClient()
        logger.info('startup_verify_worker_begin', { jobs: pending.length })
        const response = await startupVerifyWorker.poll(
          {
            windows: sessions,
            sessions: [],
            maxLogsPerPoll: 0,
            scrollbackLines: DEFAULT_SCROLLBACK_LINES,
            search: {
              rgThreads: config.rgThreads,
              profile: config.logMatchProfile,
            },
            verifyJobs: pending.map((job) => ({
              sessionId: job.sessionId,
              tmuxWindow: job.tmuxWindow,
              logFilePath: job.logFilePath,
              context: job.context,
              excludeLogPaths: job.excludeLogPaths,
            })),
          },
          { timeoutMs: STARTUP_VERIFY_WORKER_TIMEOUT_MS }
        )
        // A result without verifyResults means the worker didn't understand
        // the request — treat as failure so the inline path still verifies.
        if (!response.verifyResults) {
          throw new Error('log match worker returned no verify results')
        }
        const results = new Map(
          response.verifyResults.map((result) => [
            result.sessionId,
            result.verification,
          ])
        )
        logger.info('startup_verify_worker_done', {
          verifyMs: Math.round(response.verifyMs ?? 0),
          jobs: pending.length,
        })
        for (const job of pending) {
          recordDecision(
            job,
            results.get(job.sessionId) ?? {
              status: 'inconclusive',
              bestMatch: null,
              reason: 'no_match',
            }
          )
        }
        pending = []
      } catch (error) {
        if (error instanceof WorkerTimeoutError) {
          // The worker timed out grinding the corpus — re-running the same
          // scan inline would just stall the main thread, so degrade to
          // inconclusive and let the name fallback keep real links.
          logger.warn('startup_verify_worker_timeout', {
            jobs: pending.length,
            elapsedMs: Math.round(performance.now() - verifyStart),
          })
          for (const job of pending) {
            recordDecision(job, {
              status: 'inconclusive',
              bestMatch: null,
              reason: 'no_match',
            })
          }
          pending = []
        } else {
          logger.warn('startup_verify_worker_error', {
            error: String(error),
            fallback: 'inline',
          })
        }
      }
    }

    if (pending.length > 0) {
      const entries: Array<[string, VerificationDecision]> =
        await mapWithConcurrency(
          pending,
          STARTUP_VERIFY_CONCURRENCY,
          async (job): Promise<[string, VerificationDecision]> => {
            try {
              const verification = await verifyWindowLogAssociationDetailedAsync(
                job.tmuxWindow,
                job.logFilePath,
                logDirs,
                {
                  context: job.context,
                  excludeLogPaths: job.excludeLogPaths,
                }
              )
              const window = windowByTarget.get(job.tmuxWindow)
              return [
                job.sessionId,
                {
                  verification,
                  nameMatches: Boolean(
                    window && window.name === job.displayName
                  ),
                },
              ]
            } catch (error) {
              logger.warn('session_verification_error', {
                sessionId: job.sessionId,
                error: String(error),
              })
              return [
                job.sessionId,
                {
                  verification: { status: 'verified', bestMatch: null },
                  nameMatches: true,
                },
              ]
            }
          }
        )
      for (const [sessionId, decision] of entries) {
        decisions.set(sessionId, decision)
      }
    }

    return decisions
  }

  async function completeStartupVerification(): Promise<void> {
    const activeSessions = db.getActiveSessions()
    // Use local-only sessions for verification to prevent remote sessions
    // (whose tmuxWindow values aren't host-namespaced) from causing false
    // "window exists" decisions or incorrect hydration with local DB overlays.
    const localSessions = registry.getAll().filter((s) => !s.remote)
    try {
      if (activeSessions.length > 0 && localSessions.length > 0) {
        const verifications = await verifyAllSessions(
          activeSessions,
          localSessions,
          getLogSearchDirs()
        )
        const hydrated = deps.hydrateSessionsWithAgentSessions(localSessions, {
          verifyAssociations: true,
          precomputedVerifications: verifications,
        })
        const withOverrides = deps.applyForceWorkingOverrides(hydrated)
        registry.replaceSessions(deps.mergeRemoteSessions(withOverrides))
      }
    } catch (error) {
      logger.warn('startup_verification_error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // Load dormant sessions after startup verification so the list reflects
    // the final active/hibernating/history split without auto-waking anything.
    deps.updateDormantAgentSessions()
  }

  return {
    startupHousekeeping,
    completeStartupVerification,
  }
}
