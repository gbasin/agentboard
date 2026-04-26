import type { Server, ServerWebSocket } from 'bun'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config, isValidHostname } from './config'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { initDatabase, type AgentSessionRecord } from './db'
import { LogPoller } from './logPoller'
import { toAgentSession } from './agentSessions'
import { getLogSearchDirs } from './logDiscovery'
import {
  DEFAULT_SCROLLBACK_LINES,
  matchWindowsToLogsByExactRg,
  verifyWindowLogAssociationDetailed,
  verifyWindowLogAssociationDetailedAsync,
  type WindowLogVerificationResult,
} from './logMatcher'
import {
  createTerminalProxy,
  resolveTerminalMode,
  TerminalProxyError,
} from './terminal'
import type { ITerminalProxy } from './terminal'
import { resolveProjectPath } from './paths'
import {
  INACTIVE_MAX_AGE_MIN_HOURS,
  INACTIVE_MAX_AGE_MAX_HOURS,
  type ClientMessage,
  type ServerMessage,
  type TerminalErrorCode,
  type DirectoryListing,
  type DirectoryErrorResponse,
  type AgentSession,
  type AgentType,
  type HostStatus,
  type WakeError,
  type Session,
} from '../shared/types'
import { logger, logLevel } from './logger'
import {
  SessionRefreshWorkerClient,
  SessionRefreshWorkerTimeoutError,
} from './sessionRefreshWorkerClient'
import {
  setForceWorkingUntil,
  applyForceWorkingOverrides,
} from './forceWorkingStatus'
import { TmuxTimeoutError } from './tmuxTimeout'
import {
  MAX_FIELD_LENGTH,
  isValidSessionId,
  isValidTmuxTarget,
} from './validators'
import { RemoteSessionPoller, splitSshOptions, buildRemoteSessionId } from './remoteSessions'
import { normalizePaneStartCommand } from './agentDetection'
import { generateSessionName } from './nameGenerator'
import { shellQuote } from './shellQuote'
import { SshTerminalProxy } from './terminal/SshTerminalProxy'
import {
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from './tmuxFormat'

function checkPortAvailable(port: number): void {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    // Use -sTCP:LISTEN to only match processes actually listening on the port,
    // not stale/closed connections from other processes (e.g. Playwright/Chrome)
    result = Bun.spawnSync(['lsof', '-i', `:${port}`, '-sTCP:LISTEN', '-t'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return
  }
  const pids = result.stdout?.toString().trim() ?? ''
  if (pids) {
    const pidList = pids.split('\n').filter(Boolean)
    const pid = pidList[0]
    // Get process name
    let processName = 'unknown'
    try {
      const nameResult = Bun.spawnSync(['ps', '-p', pid, '-o', 'comm='], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      processName = nameResult.stdout?.toString().trim() || 'unknown'
    } catch {
    }
    logger.error('port_in_use', { port, pid, processName })
    process.exit(1)
  }
}

function getTailscaleIp(): string | null {
  // Try common Tailscale CLI paths (standalone CLI, then Mac App Store bundle)
  const tailscalePaths = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ]

  for (const tsPath of tailscalePaths) {
    try {
      const result = Bun.spawnSync([tsPath, 'ip', '-4'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (result.exitCode === 0) {
        const ip = result.stdout.toString().trim()
        if (ip) return ip
      }
    } catch {
      // Try next path
    }
  }
  return null
}

function pruneOrphanedWsSessions(): void {
  if (!config.pruneWsSessions) {
    return
  }

  const prefix = `${config.tmuxSession}-ws-`
  if (!prefix) {
    return
  }

  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(
      ['tmux', ...withTmuxUtf8Flag([
        'list-sessions',
        '-F',
        buildTmuxFormat(['#{session_name}', '#{session_attached}']),
      ])],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      }
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

  const output = result.stdout?.toString() ?? ''
  if (!output) {
    return
  }
  const lines = splitTmuxLines(output)
  let pruned = 0

  for (const line of lines) {
    const parts = splitTmuxFields(line, 2)
    if (!parts) continue
    const [name, attachedRaw] = parts
    if (!name || !name.startsWith(prefix)) continue
    const attached = Number.parseInt(attachedRaw ?? '', 10)
    if (Number.isNaN(attached) || attached > 0) continue
    try {
      const killResult = Bun.spawnSync(['tmux', 'kill-session', '-t', name], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      })
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

const MAX_DIRECTORY_ENTRIES = 200

function createConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

checkPortAvailable(config.port)
ensureTmux()
pruneOrphanedWsSessions()
const resolvedTerminalMode = resolveTerminalMode()
logger.info('terminal_mode_resolved', {
  configured: config.terminalMode,
  resolved: resolvedTerminalMode,
})

const app = new Hono()
const db = initDatabase()

// Read mouse mode setting from DB (default: true)
const TMUX_MOUSE_MODE_KEY = 'tmux_mouse_mode'
const storedMouseMode = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
const initialMouseMode = storedMouseMode === null ? true : storedMouseMode === 'true'

// Read inactive max age hours setting from DB (default: 24)
const INACTIVE_MAX_AGE_HOURS_KEY = 'inactive_max_age_hours'
const storedInactiveMaxAgeHours = db.getAppSetting(INACTIVE_MAX_AGE_HOURS_KEY)
let runtimeInactiveMaxAgeHours = storedInactiveMaxAgeHours !== null
  ? Number(storedInactiveMaxAgeHours)
  : config.inactiveSessionMaxAgeHours
if (!Number.isFinite(runtimeInactiveMaxAgeHours) || runtimeInactiveMaxAgeHours < 1) {
  runtimeInactiveMaxAgeHours = 24
}

const sessionManager = new SessionManager(undefined, {
  displayNameExists: (name, excludeSessionId) => db.displayNameExists(name, excludeSessionId),
  mouseMode: initialMouseMode,
})
const registry = new SessionRegistry()

interface WSData {
  terminal: ITerminalProxy | null
  currentSessionId: string | null
  currentTmuxTarget: string | null
  connectionId: string
  terminalHost: string | null
  terminalAttachSeq: number
  lastAttachKey: string | null
  lastAttachTs: number
}

const sockets = new Set<ServerWebSocket<WSData>>()
const localHostLabel = config.hostLabel

function stampLocalSession(session: Session): Session {
  return {
    ...session,
    host: localHostLabel,
    remote: false,
  }
}

function stampLocalSessions(sessions: Session[]): Session[] {
  return sessions.map(stampLocalSession)
}

// Remote session create is optimistic (we broadcast `session-created` immediately),
// but the remote poller snapshot can lag behind. Protect newly-created remote ids
// so refresh cycles don't drop them until the poller catches up.
const PROTECTED_REMOTE_SESSION_TTL_MS = 30_000
const protectedRemoteSessionIds = new Map<string, number>()

// Remote control operations (kill/rename) are also optimistic, but refresh cycles rebuild
// remote sessions from the poller snapshot. Track short-lived overrides so stale snapshots
// don't resurrect killed sessions or revert renames.
const REMOTE_SESSION_MUTATION_TTL_MS = 30_000
const remoteSessionTombstones = new Map<string, number>()
const remoteSessionNameOverrides = new Map<string, { name: string; setAt: number }>()

// Grace period for resurrected pinned sessions. After resurrection, the session
// is protected from orphaning for this duration — even if the resume command
// crashes and the window dies, the session won't be immediately orphaned.
const RESURRECTION_GRACE_MS = Number(process.env.RESURRECTION_GRACE_MS) || 15_000
const resurrectedSessionGrace = new Map<string, number>() // sessionId -> resurrection timestamp
const WAKE_RETRY_COOLDOWN_MS =
  Number(process.env.AGENTBOARD_WAKE_RETRY_COOLDOWN_MS) || 24 * 60 * 60 * 1000
const wakeInFlight = new Set<string>()

function mergeRemoteSessions(sessions: Session[]): Session[] {
  const remoteSessions = remotePoller?.getSessions() ?? []
  const needsMerge =
    protectedRemoteSessionIds.size > 0 ||
    remoteSessionTombstones.size > 0 ||
    remoteSessionNameOverrides.size > 0
  if (!needsMerge) {
    return [...stampLocalSessions(sessions), ...remoteSessions]
  }

  const now = Date.now()
  const remoteIds = new Set(remoteSessions.map((session) => session.id))
  const remoteById = new Map(remoteSessions.map((session) => [session.id, session]))
  const byId = new Map(registry.getAll().map((session) => [session.id, session]))
  const protectedSessions: Session[] = []

  for (const [id, killedAt] of remoteSessionTombstones) {
    if (now - killedAt > REMOTE_SESSION_MUTATION_TTL_MS) {
      remoteSessionTombstones.delete(id)
      continue
    }
    if (!remoteIds.has(id)) {
      // Poller has confirmed it's gone; no longer needs a tombstone.
      remoteSessionTombstones.delete(id)
    }
  }

  for (const [id, override] of remoteSessionNameOverrides) {
    if (now - override.setAt > REMOTE_SESSION_MUTATION_TTL_MS) {
      remoteSessionNameOverrides.delete(id)
      continue
    }
    const polled = remoteById.get(id)
    if (!polled) {
      // Session disappeared (killed/host stale); stop overriding.
      remoteSessionNameOverrides.delete(id)
      continue
    }
    if (polled.name === override.name) {
      // Poller has picked up the rename.
      remoteSessionNameOverrides.delete(id)
    }
  }

  for (const [id, addedAt] of protectedRemoteSessionIds) {
    if (now - addedAt > PROTECTED_REMOTE_SESSION_TTL_MS) {
      protectedRemoteSessionIds.delete(id)
      continue
    }
    if (remoteIds.has(id)) {
      // Poller has discovered it; no longer needs protection.
      protectedRemoteSessionIds.delete(id)
      continue
    }
    const existing = byId.get(id)
    if (existing?.remote) {
      protectedSessions.push(existing)
    } else {
      // Session disappeared from registry (killed/failed); stop protecting it.
      protectedRemoteSessionIds.delete(id)
    }
  }

  const mergedRemote: Session[] = []
  for (const session of remoteSessions) {
    const killedAt = remoteSessionTombstones.get(session.id)
    if (killedAt && now - killedAt <= REMOTE_SESSION_MUTATION_TTL_MS) {
      continue
    }
    const override = remoteSessionNameOverrides.get(session.id)
    if (override && now - override.setAt <= REMOTE_SESSION_MUTATION_TTL_MS) {
      mergedRemote.push({ ...session, name: override.name })
    } else {
      mergedRemote.push(session)
    }
  }

  return [...stampLocalSessions(sessions), ...protectedSessions, ...mergedRemote]
}

let hostStatuses: HostStatus[] = []
let hostStatusSnapshot = ''

function updateHostStatuses(remoteStatuses: HostStatus[]) {
  const next = [
    {
      host: localHostLabel,
      ok: true,
      lastUpdated: new Date().toISOString(),
    },
    ...remoteStatuses,
  ]
  const snapshot = JSON.stringify(next)
  if (snapshot === hostStatusSnapshot) return
  hostStatusSnapshot = snapshot
  hostStatuses = next
  broadcast({ type: 'host-status', hosts: hostStatuses })
}

const remotePoller = (config.remoteHosts?.length ?? 0) > 0
  ? new RemoteSessionPoller({
      hosts: config.remoteHosts,
      pollIntervalMs: config.remotePollMs,
      timeoutMs: config.remoteTimeoutMs,
      staleAfterMs: config.remoteStaleMs,
      sshOptions: config.remoteSshOpts,
      tmuxSessionPrefix: config.tmuxSession,
      discoverPrefixes: config.discoverPrefixes,
      onUpdate: (statuses) => updateHostStatuses(statuses),
    })
  : null

if (remotePoller) {
  remotePoller.start()
  updateHostStatuses(remotePoller.getHostStatuses())
} else {
  updateHostStatuses([])
}

// Lock map for Enter-key lastUserMessage capture: tmuxWindow -> expiry timestamp
// Prevents stale log data from overwriting fresh terminal captures
const lastUserMessageLocks = new Map<string, number>()
const LAST_USER_MESSAGE_LOCK_MS = 60_000 // 60 seconds

const logPoller = new LogPoller(db, registry, {
  onSessionOrphaned: (sessionId, supersededBy) => {
    updateDormantAgentSessions()
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({ type: 'session-orphaned', session: toAgentSession(session), supersededBy })
    }
  },
  onSessionActivated: (sessionId, window) => {
    updateDormantAgentSessions()
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({
        type: 'session-activated',
        session: toAgentSession(session),
        window,
      })
    }
  },
  isLastUserMessageLocked: (tmuxWindow) =>
    (lastUserMessageLocks.get(tmuxWindow) ?? 0) > Date.now(),
  maxLogsPerPoll: config.logPollMax,
  rgThreads: config.rgThreads,
  matchProfile: config.logMatchProfile,
  matchWorker: config.logMatchWorker,
})
const sessionRefreshWorker = new SessionRefreshWorkerClient()
const lastUserMessageWorker = new SessionRefreshWorkerClient()

// Active sessions update on every refresh — cheap (few rows).
// Inactive sessions query is expensive — only run on actual mutations.
function filterExcludedAgentSessions(sessions: AgentSession[]): AgentSession[] {
  const excludedProjects = config.excludeProjects ?? []
  if (excludedProjects.length === 0) {
    return sessions
  }

  return sessions.filter((session) => {
    const projectPath = session.projectPath || ''
    return !excludedProjects.some((excluded) => {
      if (excluded === '<empty>') return projectPath === ''
      return projectPath.startsWith(excluded)
    })
  })
}

function updateActiveAgentSessions() {
  const active = hasConfirmedLocalSessionSnapshot
    ? db.getActiveSessions().map(toAgentSession)
    : []
  const current = registry.getAgentSessions()
  registry.setAgentSessions(
    active,
    current.sleeping,
    current.inactive
  )
}

function updateDormantAgentSessions() {
  const sleeping = filterExcludedAgentSessions(
    db.getSleepingSessions().map(toAgentSession)
  )
  const inactive = filterExcludedAgentSessions(
    db.getInactiveSessions({ maxAgeHours: runtimeInactiveMaxAgeHours }).map(
      toAgentSession
    )
  )
  const active = hasConfirmedLocalSessionSnapshot
    ? db.getActiveSessions().map(toAgentSession)
    : []
  registry.setAgentSessions(active, sleeping, inactive)
}

interface VerificationDecision {
  verification: WindowLogVerificationResult
  nameMatches: boolean
  windowExists: boolean
}

interface HydrateSessionsOptions {
  verifyAssociations?: boolean
  precomputedVerifications?: Map<string, VerificationDecision>
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

  const entries: Array<[string, VerificationDecision]> = await Promise.all(
    activeSessions.map(async (agentSession): Promise<[string, VerificationDecision]> => {
      const currentWindow = agentSession.currentWindow
      if (!currentWindow || !windowSet.has(currentWindow)) {
        const decision: VerificationDecision = {
          verification: {
            status: 'inconclusive',
            bestMatch: null,
            reason: 'no_match',
          },
          nameMatches: false,
          windowExists: false,
        }
        return [agentSession.sessionId, decision]
      }

      const excludeLogPaths = allLogPaths
        .filter((entry) => entry.sessionId !== agentSession.sessionId)
        .map((entry) => entry.logPath)

      try {
        const verification = await verifyWindowLogAssociationDetailedAsync(
          currentWindow,
          agentSession.logFilePath,
          logDirs,
          {
            context: {
              agentType: agentSession.agentType,
              projectPath: agentSession.projectPath,
            },
            excludeLogPaths,
          }
        )
        const window = windowByTarget.get(currentWindow)
        const nameMatches = Boolean(window && window.name === agentSession.displayName)
        const decision: VerificationDecision = {
          verification,
          nameMatches,
          windowExists: true,
        }
        return [agentSession.sessionId, decision]
      } catch (error) {
        logger.warn('session_verification_error', {
          sessionId: agentSession.sessionId,
          error: String(error),
        })
        const decision: VerificationDecision = {
          verification: { status: 'verified', bestMatch: null },
          nameMatches: true,
          windowExists: true,
        }
        return [agentSession.sessionId, decision]
      }
    })
  )

  return new Map(entries)
}

function hydrateSessionsWithAgentSessions(
  sessions: Session[],
  { verifyAssociations = false, precomputedVerifications }: HydrateSessionsOptions = {}
): Session[] {
  const activeSessions = db.getActiveSessions()
  const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
  const activeMap = new Map<string, typeof activeSessions[number]>()
  const orphaned: AgentSession[] = []
  const logDirs = verifyAssociations && !precomputedVerifications
    ? getLogSearchDirs()
    : []

  for (const agentSession of activeSessions) {
    const precomputed = precomputedVerifications?.get(agentSession.sessionId)
    const currentWindow = agentSession.currentWindow
    const windowExists = precomputed
      ? precomputed.windowExists
      : Boolean(currentWindow && windowSet.has(currentWindow))

    if (!windowExists || !currentWindow) {
      // Don't orphan recently-resurrected sessions — give resume command time to start
      const graceStart = resurrectedSessionGrace.get(agentSession.sessionId)
      if (graceStart && Date.now() - graceStart < RESURRECTION_GRACE_MS) {
        continue
      }
      resurrectedSessionGrace.delete(agentSession.sessionId)
      logger.info('session_orphaned', {
        sessionId: agentSession.sessionId,
        displayName: agentSession.displayName,
        currentWindow: agentSession.currentWindow,
        windowSetSize: windowSet.size,
        windowSetSample: Array.from(windowSet).slice(0, 5),
      })
      // Kill any leftover dead window from remain-on-exit
      if (currentWindow) {
        try { sessionManager.killWindow(currentWindow) } catch { /* may already be gone */ }
      }
      const orphanedSession = db.orphanSession(agentSession.sessionId)
      if (orphanedSession) {
        orphaned.push(toAgentSession(orphanedSession))
      }
      continue
    }

    // Session survived — only clean up the grace entry after TTL expires.
    // While TTL is active, keep it so a crash within the grace window is still protected.
    const graceStart = resurrectedSessionGrace.get(agentSession.sessionId)
    if (graceStart && Date.now() - graceStart >= RESURRECTION_GRACE_MS) {
      resurrectedSessionGrace.delete(agentSession.sessionId)
    }

    let verification: WindowLogVerificationResult | null = null
    let nameMatches = false

    if (precomputed) {
      verification = precomputed.verification
      nameMatches = precomputed.nameMatches
    } else if (verifyAssociations) {
      const otherSessionLogPaths = activeSessions
        .filter((s) => s.sessionId !== agentSession.sessionId && s.currentWindow)
        .map((s) => s.logFilePath)

      verification = verifyWindowLogAssociationDetailed(
        currentWindow,
        agentSession.logFilePath,
        logDirs,
        {
          context: {
            agentType: agentSession.agentType,
            projectPath: agentSession.projectPath,
          },
          excludeLogPaths: otherSessionLogPaths,
        }
      )

      const window = sessions.find((s) => s.tmuxWindow === currentWindow)
      nameMatches = Boolean(window && window.name === agentSession.displayName)
    }

    if (verification) {
      let shouldOrphan = false
      let fallbackUsed = false

      if (verification.status === 'verified') {
        shouldOrphan = false
      } else if (nameMatches) {
        shouldOrphan = false
        fallbackUsed = true
      } else {
        shouldOrphan = true
      }

      if (shouldOrphan) {
        logger.info('session_verification_failed', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow,
          logFilePath: agentSession.logFilePath,
          verificationStatus: verification.status,
          verificationReason: verification.reason ?? null,
          nameMatches,
          bestMatchLog: verification.bestMatch?.logPath ?? null,
        })
        const orphanedSession = db.orphanSession(agentSession.sessionId)
        if (orphanedSession) {
          orphaned.push(toAgentSession(orphanedSession))
        }
        continue
      }

      if (fallbackUsed) {
        logger.info('session_verification_name_fallback', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow,
          verificationStatus: verification.status,
        })
      }
    }

    activeMap.set(currentWindow, agentSession)
  }

  const hydrated = sessions.map((session) => {
    const agentSession = activeMap.get(session.tmuxWindow)
    if (!agentSession) {
      return session
    }
    if (agentSession.displayName !== session.name) {
      db.updateSession(agentSession.sessionId, { displayName: session.name })
      agentSession.displayName = session.name
    }
    return {
      ...session,
      // Use log-based agentType if command-based detection failed
      agentType: session.agentType ?? agentSession.agentType,
      agentSessionId: agentSession.sessionId,
      agentSessionName: agentSession.displayName,
      logFilePath: agentSession.logFilePath,
      lastUserMessage: agentSession.lastUserMessage ?? session.lastUserMessage,
      // Use persisted log times (survives server restarts, works when tmux lacks creation time)
      lastActivity: agentSession.lastActivityAt,
      createdAt: agentSession.createdAt,
      isPinned: agentSession.isPinned,
    }
  })

  if (orphaned.length > 0) {
    for (const session of orphaned) {
      broadcast({ type: 'session-orphaned', session })
    }
    updateDormantAgentSessions()
  } else {
    updateActiveAgentSessions()
  }
  return hydrated
}

let refreshInFlight = false
// Bumped on optimistic registry mutations (kill, create, resume) so
// in-flight refreshes that started before the mutation discard their stale
// window list instead of reverting the optimistic update.
let refreshGeneration = 0
let hasConfirmedLocalSessionSnapshot = false
let lastSuccessfulRefreshWindowCount = 1
let refreshWindowCountFloor = 0
let startupExpectedWindowCount = 1

function normalizeWindowCount(windowCount: number): number {
  return Math.max(
    1,
    Number.isFinite(windowCount) ? Math.floor(windowCount) : 0
  )
}

function countLocalSessions(sessions: Session[]): number {
  return sessions.filter((session) => !session.remote).length
}

function seedRefreshWindowCountEstimate(localSessionCount: number): void {
  startupExpectedWindowCount = normalizeWindowCount(localSessionCount)
}

function recordSuccessfulRefreshWindowCount(localSessionCount: number): void {
  hasConfirmedLocalSessionSnapshot = true
  lastSuccessfulRefreshWindowCount = normalizeWindowCount(localSessionCount)
  refreshWindowCountFloor = 0
  startupExpectedWindowCount = 1
}

function shouldSkipSyncRefreshFallback(error: unknown): boolean {
  return error instanceof SessionRefreshWorkerTimeoutError
}

function estimateRefreshWindowCount(): number {
  const localSessionCount = registry.getAll().filter((session) => !session.remote).length
  return Math.max(
    1,
    localSessionCount,
    lastSuccessfulRefreshWindowCount,
    refreshWindowCountFloor,
    startupExpectedWindowCount
  )
}

function noteRefreshTimeout(): number {
  const currentEstimate = estimateRefreshWindowCount()
  const nextEstimate = Math.max(currentEstimate + 4, currentEstimate * 2)
  refreshWindowCountFloor = nextEstimate
  return nextEstimate
}

async function refreshSessionsAsync(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    // Loop: retry once if an optimistic mutation invalidated our snapshot.
    // At most one retry — if another mutation lands during the retry,
    // the next scheduled refresh will pick it up.
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = refreshGeneration
      try {
        const sessions = await sessionRefreshWorker.refresh(
          config.tmuxSession,
          config.discoverPrefixes,
          { expectedWindowCount: estimateRefreshWindowCount() }
        )
        // Mutation happened while we were listing windows — discard and retry
        if (gen !== refreshGeneration) continue
        // Yield before blocking SQLite work so pending WebSocket buffers flush
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        if (gen !== refreshGeneration) continue
        const tHydrate = performance.now()
        recordSuccessfulRefreshWindowCount(countLocalSessions(sessions))
        const hydrated = hydrateSessionsWithAgentSessions(sessions)
        const withOverrides = applyForceWorkingOverrides(hydrated)
        registry.replaceSessions(mergeRemoteSessions(withOverrides))
        const hydrateMs = Math.round(performance.now() - tHydrate)
        if (hydrateMs > 50) {
          logger.debug('session_refresh_hydrate_slow', { hydrateMs, sessionCount: sessions.length })
        }
        return
      } catch (error) {
        // Fallback to sync on worker failure — sync listWindows sees
        // post-mutation state so no generation check needed here.
        logger.warn('session_refresh_worker_error', {
          message: error instanceof Error ? error.message : String(error),
        })
        if (shouldSkipSyncRefreshFallback(error)) {
          const nextExpectedWindowCount = noteRefreshTimeout()
          logger.warn('session_refresh_sync_fallback_skipped', {
            reason: 'worker_timeout',
            nextExpectedWindowCount,
          })
          return
        }
        const sessions = listWindowsSyncOrNull('worker_fallback')
        if (!sessions) {
          return
        }
        recordSuccessfulRefreshWindowCount(countLocalSessions(sessions))
        const hydrated = hydrateSessionsWithAgentSessions(sessions)
        const withOverrides = applyForceWorkingOverrides(hydrated)
        registry.replaceSessions(mergeRemoteSessions(withOverrides))
        return
      }
    }
  } finally {
    refreshInFlight = false
  }
}

function refreshSessions() {
  void refreshSessionsAsync()
}

function listWindowsSyncOrNull(context: string): Session[] | null {
  try {
    return sessionManager.listWindows()
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      logger.warn('session_refresh_sync_skipped', {
        context,
        reason: 'tmux_timeout',
        timeoutMs: config.tmuxTimeoutMs,
        message: error.message,
      })
      return null
    }
    throw error
  }
}

// Sync version for startup - ensures sessions are ready before server starts
function refreshSessionsSync({ verifyAssociations = false } = {}) {
  const sessions = listWindowsSyncOrNull('sync_refresh')
  if (!sessions) {
    return
  }
  recordSuccessfulRefreshWindowCount(countLocalSessions(sessions))
  const hydrated = hydrateSessionsWithAgentSessions(sessions, { verifyAssociations })
  registry.replaceSessions(mergeRemoteSessions(hydrated))
}

// Debounced refresh triggered by Enter key in terminal input
let enterRefreshTimer: Timer | null = null
const lastUserMessageTimers = new Map<string, Timer>()

function setForceWorking(sessionId: string) {
  setForceWorkingUntil(sessionId, Date.now() + config.workingGracePeriodMs)
  // Immediately update registry so UI shows "working" right away
  registry.updateSession(sessionId, { status: 'working' })
}

function scheduleEnterRefresh() {
  if (enterRefreshTimer) {
    clearTimeout(enterRefreshTimer)
  }
  enterRefreshTimer = setTimeout(() => {
    enterRefreshTimer = null
    refreshSessions()
  }, config.enterRefreshDelayMs)
}

function scheduleLastUserMessageCapture(sessionId: string) {
  const session = registry.get(sessionId)
  if (!session) return
  const tmuxWindow = session.tmuxWindow

  // Set lock immediately to prevent log poller from overwriting with stale data
  // during the debounce delay (before capture completes)
  lastUserMessageLocks.set(tmuxWindow, Date.now() + LAST_USER_MESSAGE_LOCK_MS)

  const existing = lastUserMessageTimers.get(tmuxWindow)
  if (existing) {
    clearTimeout(existing)
  }
  const timer = setTimeout(() => {
    lastUserMessageTimers.delete(tmuxWindow)
    void captureLastUserMessage(tmuxWindow)
  }, config.enterRefreshDelayMs)
  lastUserMessageTimers.set(tmuxWindow, timer)
}

async function captureLastUserMessage(tmuxWindow: string) {
  try {
    const message = await lastUserMessageWorker.getLastUserMessage(tmuxWindow)
    if (!message || !message.trim()) return
    const record = db.getSessionByWindow(tmuxWindow)
    if (!record) return
    if (record.lastUserMessage === message) return
    const updated = db.updateSession(record.sessionId, { lastUserMessage: message })
    if (!updated) return
    registry.updateSession(tmuxWindow, { lastUserMessage: message })
    updateActiveAgentSessions()
  } catch (error) {
    logger.warn('last_user_message_capture_error', {
      tmuxWindow,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}


// Log startup state for debugging orphan issues
const startupActiveSessions = db.getActiveSessions()
seedRefreshWindowCountEstimate(startupActiveSessions.length)
const startupWindows = listWindowsSyncOrNull('startup_state') ?? []
logger.info('startup_state', {
  activeSessionCount: startupActiveSessions.length,
  windowCount: startupWindows.length,
  activeWindows: startupActiveSessions.map((s) => ({
    sessionId: s.sessionId.slice(0, 8),
    name: s.displayName,
    window: s.currentWindow,
  })),
  tmuxWindows: startupWindows.map((w) => ({
    tmuxWindow: w.tmuxWindow,
    name: w.name,
  })),
})

refreshSessionsSync() // hydrate from persisted associations without verification
setInterval(refreshSessions, config.refreshIntervalMs) // Async for periodic

// Event loop lag monitor — detects when spawnSync or other blocking work
// starves the event loop, causing typing lag and slow WebSocket delivery.
if (logLevel === 'debug') {
  const EL_CHECK_MS = 500
  let elLastTick = performance.now()
  setInterval(() => {
    const now = performance.now()
    const lagMs = Math.round(now - elLastTick - EL_CHECK_MS)
    elLastTick = now
    if (lagMs > 100) {
      const [load1, load5, load15] = os.loadavg()
      logger.debug('event_loop_lag', {
        lagMs,
        load1: Math.round(load1 * 100) / 100,
        load5: Math.round(load5 * 100) / 100,
        load15: Math.round(load15 * 100) / 100,
        cpus: os.cpus().length,
      })
    }
  }, EL_CHECK_MS)
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
      const hydrated = hydrateSessionsWithAgentSessions(localSessions, {
        verifyAssociations: true,
        precomputedVerifications: verifications,
      })
      const withOverrides = applyForceWorkingOverrides(hydrated)
      registry.replaceSessions(mergeRemoteSessions(withOverrides))
    }
  } catch (error) {
    logger.warn('startup_verification_error', {
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (db.getPinnedOrphaned().length > 0) {
    resurrectStarredSessions()
    refreshSessionsSync()
  }

  // Load dormant sessions after startup verification and resurrection so the
  // list reflects the final active/sleeping/inactive split.
  updateDormantAgentSessions()
}

registry.on('session-update', (session) => {
  broadcast({ type: 'session-update', session })
})

registry.on('sessions', (sessions) => {
  broadcast({ type: 'sessions', sessions })
})

registry.on('session-removed', (sessionId) => {
  broadcast({ type: 'session-removed', sessionId })
})

registry.on('agent-sessions', ({ active, sleeping, inactive }) => {
  broadcast({ type: 'agent-sessions', active, sleeping, inactive })
})

registry.on('agent-sessions-active', (active) => {
  broadcast({ type: 'agent-sessions-active', active })
})

app.post('/api/client-log', async (c) => {
  try {
    const body = await c.req.json() as { level?: string; event: string; data?: Record<string, unknown> }
    const level = body.level === 'warn' || body.level === 'error' || body.level === 'info' ? body.level : 'debug'
    logger[level]('client_' + body.event, body.data)
  } catch {
    // ignore malformed
  }
  return c.json({ ok: true })
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/sessions', (c) => c.json(registry.getAll()))

app.get('/api/session-preview/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid session id' }, 400)
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const logPath = record.logFilePath
  if (!logPath) {
    return c.json({ error: 'No log file for session' }, 404)
  }

  try {
    const stats = await fs.stat(logPath)
    if (!stats.isFile()) {
      return c.json({ error: 'Log file not found' }, 404)
    }

    // Read last 64KB of the file. try/finally guarantees the fd is released
    // if fd.read() throws (e.g., EIO, file unlinked mid-read, permission drop).
    const TAIL_BYTES = 64 * 1024
    const fileSize = stats.size
    const offset = Math.max(0, fileSize - TAIL_BYTES)
    const fd = await fs.open(logPath, 'r')
    let buffer: Buffer
    try {
      buffer = Buffer.alloc(Math.min(TAIL_BYTES, fileSize))
      await fd.read(buffer, 0, buffer.length, offset)
    } finally {
      await fd.close()
    }

    const content = buffer.toString('utf8')
    // Take last 100 lines
    const lines = content.split('\n').slice(-100)

    return c.json({
      sessionId,
      displayName: record.displayName,
      projectPath: record.projectPath,
      agentType: record.agentType,
      lastActivityAt: record.lastActivityAt,
      lines,
    })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return c.json({ error: 'Log file not found' }, 404)
    }
    return c.json({ error: 'Unable to read log file' }, 500)
  }
})
app.get('/api/directories', async (c) => {
  const requestedPath = c.req.query('path') ?? '~'

  if (requestedPath.length > MAX_FIELD_LENGTH) {
    const payload: DirectoryErrorResponse = {
      error: 'invalid_path',
      message: 'Path too long',
    }
    return c.json(payload, 400)
  }

  const trimmedPath = requestedPath.trim()
  if (!trimmedPath) {
    const payload: DirectoryErrorResponse = {
      error: 'invalid_path',
      message: 'Path is required',
    }
    return c.json(payload, 400)
  }

  const start = Date.now()
  const resolved = resolveProjectPath(trimmedPath)

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(resolved)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path does not exist',
      }
      return c.json(payload, 404)
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Permission denied',
      }
      return c.json(payload, 403)
    }
    const payload: DirectoryErrorResponse = {
      error: 'internal_error',
      message: 'Unable to read directory',
    }
    return c.json(payload, 500)
  }

  if (!stats.isDirectory()) {
    const payload: DirectoryErrorResponse = {
      error: 'not_found',
      message: 'Path is not a directory',
    }
    return c.json(payload, 404)
  }

  let directories: DirectoryListing['directories'] = []
  try {
    const entries = await fs.readdir(resolved, {
      withFileTypes: true,
      encoding: 'utf8',
    })
    directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const name = entry.name.toString()
        return {
          name,
          path: path.join(resolved, name),
        }
      })
      .toSorted((a, b) => {
        const aDot = a.name.startsWith('.')
        const bDot = b.name.startsWith('.')
        if (aDot !== bDot) {
          return aDot ? -1 : 1
        }
        const aLower = a.name.toLowerCase()
        const bLower = b.name.toLowerCase()
        if (aLower < bLower) {
          return -1
        }
        if (aLower > bLower) {
          return 1
        }
        return a.name.localeCompare(b.name)
      })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Permission denied',
      }
      return c.json(payload, 403)
    }
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path does not exist',
      }
      return c.json(payload, 404)
    }
    const payload: DirectoryErrorResponse = {
      error: 'internal_error',
      message: 'Unable to list directory',
    }
    return c.json(payload, 500)
  }

  const truncated = directories.length > MAX_DIRECTORY_ENTRIES
  const limitedDirectories = truncated
    ? directories.slice(0, MAX_DIRECTORY_ENTRIES)
    : directories

  const root = path.parse(resolved).root
  const parent = resolved === root ? null : path.dirname(resolved)
  const response: DirectoryListing = {
    path: resolved,
    parent,
    directories: limitedDirectories,
    truncated,
  }

  const durationMs = Date.now() - start
  logger.debug('directories_request', {
    path: resolved,
    count: limitedDirectories.length,
    truncated,
    durationMs,
  })

  return c.json(response)
})

app.get('/api/server-info', (c) => {
  // For 0.0.0.0, detect Tailscale IP for display (already listening on all interfaces).
  // For localhost, only report if we successfully bound to the Tailscale IP.
  const tsIp = config.hostname === '0.0.0.0' ? getTailscaleIp() : boundTailscaleIp
  return c.json({
    port: config.port,
    tailscaleIp: tsIp,
    protocol: tlsEnabled ? 'https' : 'http',
  })
})

// Tmux mouse mode setting
app.get('/api/settings/tmux-mouse-mode', (c) => {
  const stored = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
  const enabled = stored === null ? true : stored === 'true'
  return c.json({ enabled })
})

app.put('/api/settings/tmux-mouse-mode', async (c) => {
  let body: { enabled?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400)
  }

  const previousStored = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
  const previousEnabled = previousStored === null ? true : previousStored === 'true'

  try {
    sessionManager.setMouseMode(body.enabled)
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      return c.json({ error: 'Timed out applying tmux mouse mode' }, 504)
    }
    logger.warn('tmux_mouse_mode_update_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to apply tmux mouse mode' }, 500)
  }

  try {
    db.setAppSetting(TMUX_MOUSE_MODE_KEY, String(body.enabled))
  } catch (error) {
    logger.warn('tmux_mouse_mode_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    try {
      sessionManager.setMouseMode(previousEnabled)
    } catch (rollbackError) {
      logger.warn('tmux_mouse_mode_rollback_failed', {
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      })
    }
    return c.json({ error: 'Unable to persist tmux mouse mode' }, 500)
  }

  return c.json({ enabled: body.enabled })
})

// Inactive sessions max age setting
app.get('/api/settings/inactive-max-age-hours', (c) => {
  return c.json({ hours: runtimeInactiveMaxAgeHours })
})

app.put('/api/settings/inactive-max-age-hours', async (c) => {
  try {
    const body = await c.req.json()
    const hours = Number(body.hours)
    if (!Number.isFinite(hours) || hours < INACTIVE_MAX_AGE_MIN_HOURS || hours > INACTIVE_MAX_AGE_MAX_HOURS) {
      return c.json({ error: `hours must be a number between ${INACTIVE_MAX_AGE_MIN_HOURS} and ${INACTIVE_MAX_AGE_MAX_HOURS}` }, 400)
    }
    runtimeInactiveMaxAgeHours = hours
    db.setAppSetting(INACTIVE_MAX_AGE_HOURS_KEY, String(hours))
    // Re-broadcast agent sessions with new max age
    updateDormantAgentSessions()
    return c.json({ hours })
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
})

// Image upload endpoint for iOS clipboard paste
app.post('/api/paste-image', async (c) => {
  try {
    const formData = await c.req.formData()
    const file = formData.get('image') as File | null
    if (!file) {
      return c.json({ error: 'No image provided' }, 400)
    }

    // Generate unique filename in temp directory
    const ext = file.type.split('/')[1] || 'png'
    const filename = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const filepath = `/tmp/${filename}`

    // Write file
    const buffer = await file.arrayBuffer()
    await Bun.write(filepath, buffer)

    return c.json({ path: filepath })
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      500
    )
  }
})

// Get file path from macOS clipboard (for Finder file copies).
// When a user copies a file in Finder, the browser clipboard only exposes the
// file icon, not the actual contents. This endpoint extracts the real file path
// via AppleScript so the client can send it to the terminal.
app.get('/api/clipboard-file-path', async (c) => {
  if (process.platform !== 'darwin') {
    return c.json({ path: null })
  }
  try {
    const proc = Bun.spawn(
      ['osascript', '-e', 'POSIX path of (the clipboard as «class furl»)'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    const filePath = text.trim()
    if (exitCode === 0 && filePath.startsWith('/')) {
      // Verify the file actually exists
      const file = Bun.file(filePath)
      if (await file.exists()) {
        c.header('Cache-Control', 'no-store')
        return c.json({ path: filePath })
      }
    }
    return c.json({ path: null })
  } catch {
    return c.json({ path: null })
  }
})

const staticDir = process.env.AGENTBOARD_STATIC_DIR || './dist/client'
app.use('/*', serveStatic({ root: staticDir }))

const tlsEnabled = config.tlsCert && config.tlsKey
const tlsOptions = tlsEnabled
  ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } }
  : {}

function serverFetch(req: Request, server: Server<WSData>) {
  const url = new URL(req.url)
  if (url.pathname === '/ws') {
    if (
      server.upgrade(req, {
        data: {
          terminal: null,
          currentSessionId: null,
          currentTmuxTarget: null,
          connectionId: createConnectionId(),
          terminalHost: null,
          terminalAttachSeq: 0,
          lastAttachKey: null,
          lastAttachTs: 0,
        },
      })
    ) {
      return
    }
    return new Response('WebSocket upgrade failed', { status: 400 })
  }

  return app.fetch(req)
}

const websocketHandlers = {
  idleTimeout: 40,
  sendPings: true,
  perMessageDeflate: true,
  open(ws: ServerWebSocket<WSData>) {
    sockets.add(ws)
    send(ws, { type: 'sessions', sessions: registry.getAll() })
    send(ws, { type: 'host-status', hosts: hostStatuses })
    send(ws, {
      type: 'server-config',
      remoteAllowControl: config.remoteAllowControl,
      remoteAllowAttach: config.remoteAllowAttach,
      hostLabel: config.hostLabel,
      clientLogLevel: logLevel,
    })
    const agentSessions = registry.getAgentSessions()
    send(ws, {
      type: 'agent-sessions',
      active: agentSessions.active,
      sleeping: agentSessions.sleeping,
      inactive: agentSessions.inactive,
    })
    initializePersistentTerminal(ws)
  },
  message(ws: ServerWebSocket<WSData>, message: string | BufferSource) {
    handleMessage(ws, message)
  },
  close(ws: ServerWebSocket<WSData>) {
    cleanupTerminals(ws)
    sockets.delete(ws)
  },
}

Bun.serve<WSData>({
  port: config.port,
  hostname: config.hostname,
  ...tlsOptions,
  fetch: serverFetch,
  websocket: websocketHandlers,
})

// When bound to localhost, also listen on the Tailscale interface if available.
// This allows remote access over Tailscale without exposing the LAN interface.
let boundTailscaleIp: string | null = null
if (config.hostname === '127.0.0.1') {
  const detectedIp = getTailscaleIp()
  if (detectedIp) {
    try {
      Bun.serve<WSData>({
        port: config.port,
        hostname: detectedIp,
        ...tlsOptions,
        fetch: serverFetch,
        websocket: websocketHandlers,
      })
      boundTailscaleIp = detectedIp
    } catch (error) {
      logger.warn('tailscale_bind_failed', {
        ip: detectedIp,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

const protocol = tlsEnabled ? 'https' : 'http'
const displayHost = config.hostname === '0.0.0.0' ? 'localhost' : config.hostname
logger.info('server_started', {
  url: `${protocol}://${displayHost}:${config.port}`,
  tailscaleUrl: (() => {
    // For 0.0.0.0, detect Tailscale for display only (already listening on all interfaces).
    // For localhost, only show if we successfully bound to the Tailscale IP.
    const tsIp = boundTailscaleIp ?? (config.hostname === '0.0.0.0' ? getTailscaleIp() : null)
    return tsIp ? `${protocol}://${tsIp}:${config.port}` : null
  })(),
})

if (config.logPollIntervalMs > 0) {
  logPoller.start(config.logPollIntervalMs, config.logWatchMode)
}
void completeStartupVerification()

// Cleanup all terminals on server shutdown
async function cleanupAllTerminals() {
  const disposePromises: Promise<void>[] = []
  for (const ws of sockets) {
    if (ws.data.terminal) {
      disposePromises.push(ws.data.terminal.dispose())
      ws.data.terminal = null
    }
    ws.data.currentSessionId = null
    ws.data.currentTmuxTarget = null
    ws.data.terminalHost = null
    clearAttachDedup(ws)
  }
  await Promise.allSettled(disposePromises)
  logPoller.stop()
  remotePoller?.stop()
  db.close()
}

process.on('SIGINT', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

/** Clear attach dedup state so a new/replacement proxy doesn't inherit stale history. */
function clearAttachDedup(ws: ServerWebSocket<WSData>) {
  ws.data.lastAttachKey = null
  ws.data.lastAttachTs = 0
}

function cleanupTerminals(ws: ServerWebSocket<WSData>) {
  if (ws.data.terminal) {
    void ws.data.terminal.dispose()
    ws.data.terminal = null
  }
  ws.data.currentSessionId = null
  ws.data.currentTmuxTarget = null
  ws.data.terminalHost = null
  clearAttachDedup(ws)
}

function broadcast(message: ServerMessage) {
  const payload = JSON.stringify(message)
  for (const socket of sockets) {
    socket.send(payload)
  }
}

function send(ws: ServerWebSocket<WSData>, message: ServerMessage) {
  ws.send(JSON.stringify(message))
}

function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((err) => {
    logger.error('unhandled_async_error', {
      context,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

function handleMessage(
  ws: ServerWebSocket<WSData>,
  rawMessage: string | BufferSource
) {
  const text =
    typeof rawMessage === 'string'
      ? rawMessage
      : new TextDecoder().decode(rawMessage)

  let message: ClientMessage
  try {
    message = JSON.parse(text) as ClientMessage
  } catch {
    send(ws, { type: 'error', message: 'Invalid message payload' })
    return
  }

  switch (message.type) {
    case 'ping':
      send(ws, message.seq != null ? { type: 'pong', seq: message.seq } : { type: 'pong' })
      return
    case 'session-refresh':
      refreshSessions()
      return
    case 'session-create':
      if (message.host) {
        fireAndForget(handleRemoteCreate(message.host, message.projectPath, message.name, message.command, ws), 'handleRemoteCreate')
      } else {
        try {
          const created = stampLocalSession(sessionManager.createWindow(
            message.projectPath,
            message.name,
            message.command
          ))
          // Add session to registry immediately so terminal can attach
          refreshGeneration++
          const currentSessions = registry.getAll()
          registry.replaceSessions([created, ...currentSessions])
          refreshSessions()
          send(ws, { type: 'session-created', session: created })
        } catch (error) {
          send(ws, {
            type: 'error',
            message:
              error instanceof Error ? error.message : 'Unable to create session',
          })
        }
      }
      return
    case 'session-kill':
      fireAndForget(handleKill(message.sessionId, ws), 'handleKill')
      return
    case 'session-rename':
      fireAndForget(handleRename(message.sessionId, message.newName, ws), 'handleRename')
      return
	    case 'terminal-attach':
	      ws.data.terminalAttachSeq += 1
	      fireAndForget(attachTerminalPersistent(ws, message, ws.data.terminalAttachSeq), 'attachTerminalPersistent')
	      return
	    case 'terminal-detach':
	      detachTerminalPersistent(ws, message.sessionId)
	      return
    case 'terminal-input':
      handleTerminalInputPersistent(ws, message.sessionId, message.data)
      return
    case 'terminal-resize':
      handleTerminalResizePersistent(
        ws,
        message.sessionId,
        message.cols,
        message.rows
      )
      return
    case 'tmux-cancel-copy-mode':
      // Exit tmux copy-mode when user starts typing after scrolling
      fireAndForget(handleCancelCopyMode(message.sessionId, ws), 'handleCancelCopyMode')
      return
    case 'tmux-check-copy-mode':
      fireAndForget(handleCheckCopyMode(message.sessionId, ws), 'handleCheckCopyMode')
      return
    case 'session-wake':
      handleSessionWake(message, ws)
      return
    case 'session-sleep':
      handleSessionSleep(message.sessionId, ws)
      return
    case 'session-pin':
      handleSessionPin(message.sessionId, message.isPinned, ws)
      return
    default:
      send(ws, { type: 'error', message: 'Unknown message type' })
  }
}

function resolveCopyModeTarget(
  sessionId: string,
  ws: ServerWebSocket<WSData>,
  session: Session
): string {
  if (ws.data.currentSessionId === sessionId && ws.data.currentTmuxTarget) {
    return ws.data.currentTmuxTarget
  }
  return session.tmuxWindow
}

async function handleRemoteCreate(
  host: string,
  projectPath: string,
  name: string | undefined,
  command: string | undefined,
  ws: ServerWebSocket<WSData>
) {
  if (!config.remoteAllowControl) {
    send(ws, { type: 'error', message: 'Remote session creation is disabled' })
    return
  }
  if (!isValidHostname(host)) {
    send(ws, { type: 'error', message: 'Invalid hostname' })
    return
  }
  if (!config.remoteHosts.includes(host)) {
    send(ws, { type: 'error', message: 'Host is not in the configured remote hosts list' })
    return
  }
  const trimmedPath = projectPath.trim()
  if (!trimmedPath) {
    send(ws, { type: 'error', message: 'Project path is required' })
    return
  }
  // Path must be absolute and not contain control characters
  if (!trimmedPath.startsWith('/')) {
    send(ws, { type: 'error', message: 'Project path must be an absolute path (starting with /)' })
    return
  }
  if (trimmedPath.includes('\n') || trimmedPath.includes('\r') || trimmedPath.includes('\0')) {
    send(ws, { type: 'error', message: 'Project path contains invalid characters' })
    return
  }

  // Validate name format if provided (same rules as rename)
  const windowName = name?.trim() || generateSessionName()
  if (name?.trim() && !/^[\w-]+$/.test(windowName)) {
    send(ws, { type: 'error', message: 'Name can only contain letters, numbers, hyphens, and underscores' })
    return
  }

  try {
    // Validate path exists on remote host
    const testResult = await runRemoteSsh(host, `test -d ${shellQuote(trimmedPath)}`)
    if (testResult.exitCode !== 0) {
      send(ws, { type: 'error', message: `Directory does not exist on ${host}: ${trimmedPath}` })
      return
    }

    // Check if tmux session already exists on remote
    const tmuxSession = config.tmuxSession
    const hasSessionResult = await runRemoteTmux(host, ['has-session', '-t', tmuxSession])
    const sessionExists = hasSessionResult.exitCode === 0

    const windowCommand = normalizePaneStartCommand(command?.trim() || '') || 'claude'
    // Wrap in interactive login shell so .bashrc PATH is available
    // (non-interactive shells skip .bashrc due to [ -z "$PS1" ] && return guard).
    // Fall back to raw command on systems without bash (e.g. Alpine).
    const bashCheck = await runRemoteSsh(host, 'command -v bash')
    const wrappedCommand = bashCheck.exitCode === 0
      ? `bash -lic ${shellQuote(windowCommand)}`
      : windowCommand
    let createResult: { exitCode: number; stdout: string; stderr: string }

    if (sessionExists) {
      // Session exists — add a new window to it
      createResult = await runRemoteTmux(host, [
        'new-window', '-P',
        '-F', buildTmuxFormat(['#{window_index}', '#{window_id}']),
        '-t', tmuxSession, '-n', windowName, '-c', trimmedPath, wrappedCommand,
      ])
    } else {
      // Session doesn't exist — create it with the desired window directly
      // (avoids an orphan window 0 from a separate new-session call)
      createResult = await runRemoteTmux(host, [
        'new-session', '-d', '-P',
        '-F', buildTmuxFormat(['#{window_index}', '#{window_id}']),
        '-s', tmuxSession, '-n', windowName, '-c', trimmedPath, wrappedCommand,
      ])
    }
    if (createResult.exitCode !== 0) {
      const stderr = createResult.stderr?.trim() ?? 'Unknown error'
      send(ws, { type: 'error', message: `Failed to create remote window: ${stderr}` })
      return
    }

    // Parse window info from -P output (e.g. "3\t@5")
    const printOutput = createResult.stdout?.trim() ?? ''
    const parts = splitTmuxFields(printOutput, 2)
    const now = Date.now()

    if (!parts || !parts[0]) {
      send(ws, { type: 'error', message: 'Failed to verify remote session creation' })
      return
    }

    const windowIndex = parts[0].trim()
    const windowId = (parts[1] ?? '').trim()
    const stableTarget = windowId || windowIndex

    // Verify the window actually persists. When adding a new window to an existing session,
    // `tmux has-session -t <session>` can still succeed even if the new window exited
    // immediately (and was cleaned up by tmux).
    const verifyResult = await runRemoteTmux(host, ['has-session', '-t', `${tmuxSession}:${stableTarget}`])
    if (verifyResult.exitCode !== 0) {
      logger.warn('remote_window_exited_immediately', {
        host,
        tmuxSession,
        windowName,
        windowIndex,
        windowId: windowId || undefined,
        stableTarget,
        command: windowCommand,
        wrappedCommand,
      })
      send(ws, {
        type: 'error',
        message: `Remote window exited immediately on ${host} — command "${windowCommand}" may have failed`,
      })
      return
    }
    const id = buildRemoteSessionId(host, tmuxSession, windowIndex, windowId)
    const createdSession: Session = {
      id,
      name: windowName,
      tmuxWindow: `${tmuxSession}:${stableTarget}`,
      projectPath: trimmedPath,
      status: 'unknown',
      lastActivity: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      source: 'managed',
      host,
      remote: true,
      command: windowCommand,
    }

    protectedRemoteSessionIds.set(createdSession.id, now)

    // Add to registry so it appears immediately
    const currentSessions = registry.getAll()
    registry.replaceSessions([createdSession, ...currentSessions])
    send(ws, { type: 'session-created', session: createdSession })
  } catch (error) {
    send(ws, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unable to create remote session',
    })
  }
}

async function handleCancelCopyMode(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session) return
  if (session.remote && !config.remoteAllowAttach) return

  try {
    // Exit tmux copy-mode quietly.
    const target = resolveCopyModeTarget(sessionId, ws, session)
    if (session.remote && session.host) {
      await runRemoteTmux(session.host, ['send-keys', '-X', '-t', target, 'cancel'])
    } else {
      Bun.spawnSync(['tmux', 'send-keys', '-X', '-t', target, 'cancel'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
      })
    }
  } catch {
    // Ignore errors - copy-mode may not be active
  }
}

async function handleCheckCopyMode(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session) return
  if (session.remote && !config.remoteAllowAttach) return

  try {
    const target = resolveCopyModeTarget(sessionId, ws, session)
    // Query tmux for pane copy-mode status
    let output: string
    if (session.remote && session.host) {
      const result = await runRemoteTmux(session.host, ['display-message', '-p', '-t', target, '#{pane_in_mode}'])
      output = result.stdout?.trim() ?? ''
    } else {
      const result = Bun.spawnSync(
        ['tmux', ...withTmuxUtf8Flag(['display-message', '-p', '-t', target, '#{pane_in_mode}'])],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5000 }
      )
      output = result.stdout?.toString().trim() ?? ''
    }
    const inCopyMode = output === '1'
    send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode })
  } catch {
    // On error, assume not in copy mode
    send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode: false })
  }
}

async function handleKill(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session) {
    send(ws, { type: 'kill-failed', sessionId, message: 'Session not found' })
    return
  }
  if (session.remote && !config.remoteAllowControl) {
    send(ws, { type: 'kill-failed', sessionId, message: 'Remote sessions are read-only' })
    return
  }
  if (session.remote && config.remoteAllowControl && session.host) {
    if (session.source !== 'managed') {
      send(ws, { type: 'kill-failed', sessionId, message: 'Cannot kill external remote sessions' })
      return
    }
    try {
      const result = await runRemoteTmux(session.host, ['kill-window', '-t', session.tmuxWindow])
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.trim() ?? 'Unknown error'
        send(ws, { type: 'kill-failed', sessionId, message: stderr })
        return
      }
      remoteSessionNameOverrides.delete(sessionId)
      remoteSessionTombstones.set(sessionId, Date.now())
      const remaining = registry.getAll().filter((item) => item.id !== sessionId)
      registry.replaceSessions(remaining)
    } catch (error) {
      send(ws, {
        type: 'kill-failed',
        sessionId,
        message: error instanceof Error ? error.message : 'Unable to kill remote session',
      })
    }
    return
  }
  if (session.source !== 'managed' && !config.allowKillExternal) {
    send(ws, { type: 'kill-failed', sessionId, message: 'Cannot kill external sessions' })
    return
  }

  try {
    sessionManager.killWindow(session.tmuxWindow)
    // Bump generation so any in-flight refresh discards its stale result
    refreshGeneration++
    const orphaned = new Map<string, AgentSession>()
    const orphanById = (agentSessionId?: string | null) => {
      if (!agentSessionId || orphaned.has(agentSessionId)) return
      const orphanedSession = db.orphanSession(agentSessionId)
      if (orphanedSession) {
        orphaned.set(agentSessionId, toAgentSession(orphanedSession))
      }
    }

    orphanById(session.agentSessionId)
    const recordByWindow = db.getSessionByWindow(session.tmuxWindow)
    if (recordByWindow) {
      orphanById(recordByWindow.sessionId)
    }
    if (orphaned.size > 0) {
      updateDormantAgentSessions()
      for (const orphanedSession of orphaned.values()) {
        broadcast({ type: 'session-orphaned', session: orphanedSession })
      }
    }
    const remaining = registry.getAll().filter((item) => item.id !== sessionId)
    registry.replaceSessions(remaining)
    // Don't call refreshSessions() here — the registry is already updated
    // synchronously.  An async refresh would race with the tmux process
    // dying and could re-add the killed window to the registry before the
    // process exits, causing stale broadcasts that resurrect the session
    // on the client.  The periodic refresh handles reconciliation.
  } catch (error) {
    send(ws, {
      type: 'kill-failed',
      sessionId,
      message:
        error instanceof Error ? error.message : 'Unable to kill session',
    })
  }
}

async function handleRename(
  sessionId: string,
  newName: string,
  ws: ServerWebSocket<WSData>
) {
  let session = registry.get(sessionId)
  if (!session) {
    refreshSessionsSync() // Use sync for inline operations needing immediate results
    session = registry.get(sessionId)
    if (!session) {
      const record = db.getSessionById(sessionId)
      if (record && !record.currentWindow) {
        const trimmed = newName.trim()
        if (!trimmed) {
          send(ws, { type: 'error', message: 'Name cannot be empty' })
          return
        }
        if (!/^[\w-]+$/.test(trimmed)) {
          send(ws, {
            type: 'error',
            message: 'Name can only contain letters, numbers, hyphens, and underscores',
          })
          return
        }
        if (db.displayNameExists(trimmed, sessionId)) {
          send(ws, { type: 'error', message: 'Name already exists' })
          return
        }
        const updated = db.updateSession(sessionId, { displayName: trimmed })
        if (!updated) {
          send(ws, { type: 'error', message: 'Unable to rename session' })
          return
        }
        updateDormantAgentSessions()
        return
      }
      send(ws, { type: 'error', message: 'Session not found' })
      return
    }
  }
  if (session.remote && !config.remoteAllowControl) {
    send(ws, { type: 'error', message: 'Remote sessions are read-only' })
    return
  }
  if (session.remote && config.remoteAllowControl && session.host) {
    if (session.source !== 'managed') {
      send(ws, { type: 'error', message: 'Cannot rename external remote sessions' })
      return
    }
    const trimmed = newName.trim()
    if (!trimmed) {
      send(ws, { type: 'error', message: 'Name cannot be empty' })
      return
    }
    if (!/^[\w-]+$/.test(trimmed)) {
      send(ws, { type: 'error', message: 'Name can only contain letters, numbers, hyphens, and underscores' })
      return
    }
    try {
      const result = await runRemoteTmux(session.host, ['rename-window', '-t', session.tmuxWindow, trimmed])
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.trim() ?? 'Unknown error'
        send(ws, { type: 'error', message: stderr })
        return
      }
      remoteSessionNameOverrides.set(sessionId, { name: trimmed, setAt: Date.now() })
      const currentSessions = registry.getAll()
      const nextSessions = currentSessions.map((item) =>
        item.id === sessionId ? { ...item, name: trimmed } : item
      )
      registry.replaceSessions(nextSessions)
    } catch (error) {
      send(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to rename remote session',
      })
    }
    return
  }

  try {
    sessionManager.renameWindow(session.tmuxWindow, newName)
    refreshSessions()
  } catch (error) {
    send(ws, {
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Unable to rename session',
    })
  }
}

function handleSessionPin(
  sessionId: string,
  isPinned: unknown,
  ws: ServerWebSocket<WSData>
) {
  // Validate isPinned is actually a boolean
  if (typeof isPinned !== 'boolean') {
    send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'isPinned must be a boolean' })
    return
  }

  if (!isValidSessionId(sessionId)) {
    send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'Invalid session id' })
    return
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'Session not found' })
    return
  }

  // When pinning, also clear any previous resume error
  const updated = isPinned
    ? db.updateSession(sessionId, { isPinned: true, lastResumeError: null })
    : db.setPinned(sessionId, false)
  if (!updated) {
    send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'Failed to update pin state' })
    return
  }

  send(ws, { type: 'session-pin-result', sessionId, ok: true })

  // Update all active sessions that match (in case of edge cases with multiple windows)
  for (const session of registry.getAll()) {
    if (session.agentSessionId === sessionId) {
      registry.updateSession(session.id, { isPinned })
    }
  }

  updateDormantAgentSessions()
}

function handleSessionSleep(
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
  if (!isValidSessionId(sessionId)) {
    logger.warn('session_sleep_failed', { sessionId, reason: 'invalid_id' })
    send(ws, { type: 'session-sleep-result', sessionId, ok: false, error: 'Invalid session id' })
    return
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    logger.warn('session_sleep_failed', { sessionId, reason: 'not_found' })
    send(ws, { type: 'session-sleep-result', sessionId, ok: false, error: 'Session not found' })
    return
  }

  // Idempotent ack: already snoozed. A reconnect-storm replay or a double
  // click shouldn't surface a spurious error to the user.
  if (record.isPinned && !record.currentWindow) {
    logger.info('session_sleep_noop', {
      sessionId,
      agentType: record.agentType,
      displayName: record.displayName,
    })
    send(ws, {
      type: 'session-sleep-result',
      sessionId,
      ok: true,
      session: toAgentSession(record),
    })
    return
  }

  if (!record.currentWindow) {
    logger.warn('session_sleep_failed', { sessionId, reason: 'not_active' })
    send(ws, { type: 'session-sleep-result', sessionId, ok: false, error: 'Session is not active' })
    return
  }

  const liveSession =
    registry.get(record.currentWindow) ??
    registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)

  if (!liveSession || liveSession.remote || liveSession.source !== 'managed') {
    logger.warn('session_sleep_failed', {
      sessionId,
      reason: 'not_local_managed',
      agentType: record.agentType,
    })
    send(ws, {
      type: 'session-sleep-result',
      sessionId,
      ok: false,
      error: 'Only local managed sessions can be slept',
    })
    return
  }

  // Scope the try/catch narrowly to the kill + DB write so that a later
  // registry/broadcast error can't produce a failure result after we've
  // already sent a success.
  const startedAt = Date.now()
  let updated: ReturnType<typeof db.updateSession>
  try {
    sessionManager.killWindow(record.currentWindow)
    refreshGeneration++
    updated = db.updateSession(sessionId, {
      currentWindow: null,
      isPinned: true,
      lastResumeError: null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to sleep session'
    logger.error('session_sleep_failed', {
      sessionId,
      reason: 'kill_failed',
      error: message,
      agentType: record.agentType,
    })
    send(ws, {
      type: 'session-sleep-result',
      sessionId,
      ok: false,
      error: message,
    })
    return
  }

  if (!updated) {
    logger.error('session_sleep_failed', {
      sessionId,
      reason: 'db_update_failed',
      agentType: record.agentType,
    })
    send(ws, { type: 'session-sleep-result', sessionId, ok: false, error: 'Failed to update session state' })
    return
  }

  logger.info('session_sleep_success', {
    sessionId,
    agentType: record.agentType,
    displayName: record.displayName,
    tmuxWindow: record.currentWindow,
    durationMs: Date.now() - startedAt,
  })

  send(ws, {
    type: 'session-sleep-result',
    sessionId,
    ok: true,
    session: toAgentSession(updated),
  })

  const remaining = registry.getAll().filter((session) => session.id !== liveSession.id)
  registry.replaceSessions(remaining)
  updateDormantAgentSessions()
}

/**
 * Build a resume command by injecting stored launch flags into the resume template.
 * e.g. stored "claude --dangerously-skip-permissions" + template "claude --resume {sessionId}"
 *   → "claude --dangerously-skip-permissions --resume <id>"
 * e.g. stored "codex --yolo --search" + template "codex resume {sessionId}"
 *   → "codex --yolo --search resume <id>"
 */
function buildResumeCommand(
  launchCommand: string | null,
  sessionId: string,
  agentType: AgentType
): string {
  const resumeTemplate =
    agentType === 'claude' || agentType === 'claude-rp'
      ? config.claudeResumeCmd
      : config.codexResumeCmd

  const baseResumeCmd = resumeTemplate.replace('{sessionId}', sessionId)

  if (!launchCommand) {
    return baseResumeCmd
  }

  // Extract flags from the stored command: strip the executable (first token)
  // and any existing resume subcommand/flag + its session ID argument.
  // Normalize first to handle tmux quoting and bash -lc wrappers.
  const flags = normalizePaneStartCommand(launchCommand)
    .replace(/^\S+\s*/, '')             // strip executable
    .replace(/--resume\s+\S+/g, '')     // strip --resume <id> (Claude)
    .replace(/\bresume\s+\S+/g, '')     // strip resume <id> (Codex subcommand)
    .replace(/\s+/g, ' ')
    .trim()

  if (!flags) {
    return baseResumeCmd
  }

  // Inject flags after the executable in the resume command
  const firstSpace = baseResumeCmd.indexOf(' ')
  const exe = baseResumeCmd.slice(0, firstSpace)
  const rest = baseResumeCmd.slice(firstSpace + 1)
  return `${exe} ${flags} ${rest}`
}

function validateWakeTemplate(record: AgentSessionRecord): WakeError | null {
  if (record.launchCommand) {
    return null
  }

  const resumeTemplate =
    record.agentType === 'claude' || record.agentType === 'claude-rp'
      ? config.claudeResumeCmd
      : config.codexResumeCmd
  if (resumeTemplate.includes('{sessionId}')) {
    return null
  }

  return {
    code: 'WAKE_FAILED',
    message: 'Wake command template missing {sessionId} placeholder',
  }
}

function shouldSkipAutoWake(record: AgentSessionRecord, now = Date.now()): boolean {
  if (!record.lastResumeError || !record.lastResumeAttemptAt) {
    return false
  }
  const lastAttempt = Date.parse(record.lastResumeAttemptAt)
  if (Number.isNaN(lastAttempt)) {
    return false
  }
  return now - lastAttempt < WAKE_RETRY_COOLDOWN_MS
}

function hydrateWakeSession(
  session: Session,
  record: AgentSessionRecord
): Session {
  return stampLocalSession({
    ...session,
    agentType: session.agentType ?? record.agentType,
    agentSessionId: record.sessionId,
    agentSessionName: record.displayName,
    logFilePath: record.logFilePath,
    lastUserMessage: record.lastUserMessage ?? session.lastUserMessage,
    lastActivity: record.lastActivityAt,
    createdAt: record.createdAt,
    isPinned: record.isPinned,
  })
}

function tryRematchDormantSession(
  record: AgentSessionRecord
): { session: Session; record: AgentSessionRecord } | null {
  refreshSessionsSync()

  const alreadyHydrated = registry.getAll().find(
    (session) =>
      !session.remote &&
      (session.agentSessionId?.trim() === record.sessionId ||
        session.logFilePath === record.logFilePath)
  )
  if (alreadyHydrated) {
    const updated = db.updateSession(record.sessionId, {
      currentWindow: alreadyHydrated.tmuxWindow,
      displayName: alreadyHydrated.name,
      lastResumeError: null,
    })
    const updatedRecord = updated ?? {
      ...record,
      currentWindow: alreadyHydrated.tmuxWindow,
      displayName: alreadyHydrated.name,
      lastResumeError: null,
    }
    const hydrated = hydrateWakeSession(alreadyHydrated, updatedRecord)
    registry.replaceSessions(
      registry.getAll().map((session) =>
        session.id === hydrated.id ? hydrated : session
      )
    )
    updateDormantAgentSessions()
    return { session: hydrated, record: updatedRecord }
  }

  if (!record.logFilePath) {
    return null
  }

  const claimedWindows = new Set(
    db.getActiveSessions()
      .map((session) => session.currentWindow)
      .filter(Boolean) as string[]
  )
  const candidates = registry
    .getAll()
    .filter(
      (session) =>
        !session.remote && !claimedWindows.has(session.tmuxWindow)
    )
  if (candidates.length === 0) {
    return null
  }

  try {
    const result = matchWindowsToLogsByExactRg(
      candidates,
      getLogSearchDirs(),
      DEFAULT_SCROLLBACK_LINES,
      {
        logPaths: [record.logFilePath],
        rgThreads: config.rgThreads,
      }
    )
    const match = result.matches.get(record.logFilePath)
    if (!match) {
      return null
    }
    if (db.getSessionByWindow(match.tmuxWindow)) {
      return null
    }

    const patch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>> = {
      currentWindow: match.tmuxWindow,
      displayName: match.name,
      lastResumeError: null,
    }
    if (match.command && !record.launchCommand) {
      patch.launchCommand = match.command
    }
    const updated = db.updateSession(record.sessionId, patch)
    const updatedRecord = updated ?? {
      ...record,
      ...patch,
    }
    const hydrated = hydrateWakeSession(match, updatedRecord)
    registry.replaceSessions(
      registry.getAll().map((session) =>
        session.id === hydrated.id ? hydrated : session
      )
    )
    updateDormantAgentSessions()
    logger.info('session_wake_rematch_success', {
      sessionId: record.sessionId,
      window: match.tmuxWindow,
      displayName: match.name,
    })
    return { session: hydrated, record: updatedRecord }
  } catch (error) {
    logger.warn('session_wake_rematch_failed', {
      sessionId: record.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function resurrectStarredSessions() {
  const snoozed = db.getPinnedOrphaned()
  const orphanedPinned = snoozed.filter((record) => !shouldSkipAutoWake(record))
  if (orphanedPinned.length === 0) {
    if (snoozed.length > 0) {
      logger.info('resurrect_starred_sessions_skip', {
        reason: 'cooldown',
        count: snoozed.length,
      })
    }
    return
  }

  logger.info('resurrect_starred_sessions_start', { count: orphanedPinned.length })

  for (const record of orphanedPinned) {
    if (wakeInFlight.has(record.sessionId)) {
      logger.info('resurrect_starred_session_skip', {
        sessionId: record.sessionId,
        reason: 'wake_in_flight',
      })
      continue
    }
    wakeInFlight.add(record.sessionId)
    const attemptAt = new Date().toISOString()

    // Validate sessionId before using in command
    if (!isValidSessionId(record.sessionId)) {
      const errorMsg = 'Invalid session id format'
      db.updateSession(record.sessionId, {
        lastResumeError: errorMsg,
        lastResumeAttemptAt: attemptAt,
      })
      broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      logger.error('resurrect_starred_session_invalid_id', {
        sessionId: record.sessionId,
        displayName: record.displayName,
      })
      wakeInFlight.delete(record.sessionId)
      continue
    }

    const templateError = validateWakeTemplate(record)
    if (templateError) {
      db.updateSession(record.sessionId, {
        lastResumeError: templateError.message,
        lastResumeAttemptAt: attemptAt,
      })
      broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: templateError.message,
      })
      logger.error('resurrect_starred_session_failed', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: templateError.message,
      })
      wakeInFlight.delete(record.sessionId)
      continue
    }

    const command = buildResumeCommand(record.launchCommand, record.sessionId, record.agentType)
    const projectPath =
      record.projectPath ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      '.'

    try {
      const created = sessionManager.createWindow(
        projectPath,
        record.displayName,
        command,
        { excludeSessionId: record.sessionId }
      )
      resurrectedSessionGrace.set(record.sessionId, Date.now())
      try {
        sessionManager.setWindowOption(created.tmuxWindow, 'remain-on-exit', 'failed')
      } catch { /* non-fatal — older tmux may not support 'failed' value */ }
      db.updateSession(record.sessionId, {
        currentWindow: created.tmuxWindow,
        displayName: created.name,
        lastResumeAttemptAt: attemptAt,
        lastResumeError: null, // Clear any previous error on success
      })
      logger.info('resurrect_starred_session_success', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        tmuxWindow: created.tmuxWindow,
      })
    } catch (error) {
      // Resurrection failed. Preserve the star so the Snoozed row remains
      // actionable, but record the failure and throttle future auto-wake tries.
      const errorMsg = error instanceof Error ? error.message : String(error)
      db.updateSession(record.sessionId, {
        lastResumeError: errorMsg,
        lastResumeAttemptAt: attemptAt,
      })
      broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      logger.error('resurrect_starred_session_failed', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
    } finally {
      wakeInFlight.delete(record.sessionId)
    }
  }
}

function handleSessionWake(
  message: Extract<ClientMessage, { type: 'session-wake' }>,
  ws: ServerWebSocket<WSData>
) {
  const sessionId = message.sessionId
  if (!isValidSessionId(sessionId)) {
    logger.warn('session_wake_failed', { sessionId, reason: 'invalid_id' })
    const error: WakeError = {
      code: 'NOT_FOUND',
      message: 'Invalid session id',
    }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    logger.warn('session_wake_failed', { sessionId, reason: 'not_found' })
    const error: WakeError = { code: 'NOT_FOUND', message: 'Session not found' }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  if (record.currentWindow) {
    // Idempotent ack when the session is already live AND we can confirm it
    // in the registry — protects against stale messages from a reconnect
    // storm. If the registry doesn't know about it we fall through to the
    // error so the client can refresh rather than silently trusting stale DB.
    const liveSession =
      registry.get(record.currentWindow) ??
      registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)
    if (liveSession) {
      logger.info('session_wake_noop', {
        sessionId,
        agentType: record.agentType,
        displayName: record.displayName,
      })
      send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
      return
    }
    logger.warn('session_wake_failed', { sessionId, reason: 'already_active_stale_registry' })
    const error: WakeError = {
      code: 'ALREADY_ACTIVE',
      message: 'Session is already active',
    }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  if (wakeInFlight.has(sessionId)) {
    logger.info('session_wake_noop', {
      sessionId,
      reason: 'wake_in_flight',
      agentType: record.agentType,
      displayName: record.displayName,
    })
    const error: WakeError = {
      code: 'WAKE_IN_PROGRESS',
      message: 'Wake already in progress for this session',
    }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  wakeInFlight.add(sessionId)
  const attemptAt = new Date().toISOString()

  try {
    const latest = db.getSessionById(sessionId) ?? record
    if (latest.currentWindow) {
      const liveSession =
        registry.get(latest.currentWindow) ??
        registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)
      if (liveSession) {
        send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
        return
      }
    }

    const rematched = tryRematchDormantSession(latest)
    if (rematched) {
      send(ws, { type: 'session-wake-result', sessionId, ok: true, session: rematched.session })
      broadcast({
        type: 'session-activated',
        session: toAgentSession(rematched.record),
        window: rematched.session.tmuxWindow,
      })
      return
    }

    const templateError = validateWakeTemplate(latest)
    if (templateError) {
      logger.error('session_wake_failed', {
        sessionId,
        reason: 'bad_template',
        agentType: latest.agentType,
      })
      db.updateSession(sessionId, {
        lastResumeError: templateError.message,
        lastResumeAttemptAt: attemptAt,
      })
      updateDormantAgentSessions()
      send(ws, { type: 'session-wake-result', sessionId, ok: false, error: templateError })
      return
    }

    const command = buildResumeCommand(latest.launchCommand, sessionId, latest.agentType)
    const projectPath =
      latest.projectPath ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      '.'

    const startedAt = Date.now()
    db.updateSession(sessionId, { lastResumeAttemptAt: attemptAt })
    // Name is driven by the stored displayName — createWindow will auto-suffix
    // on genuine collisions with other live sessions (excludeSessionId keeps
    // the session's own prior name from matching itself).
    const created = stampLocalSession(sessionManager.createWindow(
      projectPath,
      latest.displayName,
      command,
      { excludeSessionId: sessionId }
    ))
    const updatedRecord = db.updateSession(sessionId, {
      currentWindow: created.tmuxWindow,
      displayName: created.name,
      lastResumeAttemptAt: attemptAt,
      lastResumeError: null, // Clear any previous error on success
    })
    // Add session to registry immediately so terminal can attach
    // (async refresh will update with any additional data later)
    refreshGeneration++
    const currentSessions = registry.getAll()
    registry.replaceSessions([created, ...currentSessions])
    updateDormantAgentSessions()
    refreshSessions()
    send(ws, { type: 'session-wake-result', sessionId, ok: true, session: created })
    broadcast({
      type: 'session-activated',
      session: toAgentSession(
        updatedRecord ?? {
          ...latest,
          currentWindow: created.tmuxWindow,
          displayName: created.name,
          lastResumeAttemptAt: attemptAt,
          lastResumeError: null,
        }
      ),
      window: created.tmuxWindow,
    })
    logger.info('session_wake_success', {
      sessionId,
      agentType: latest.agentType,
      displayName: latest.displayName,
      tmuxWindow: created.tmuxWindow,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to wake session'
    // Persist the failure reason so every tab sees an error badge via the
    // normal agent-sessions broadcast, not just the tab that triggered the
    // wake. Starred idle sessions remain in the Snoozed rail.
    db.updateSession(sessionId, {
      lastResumeError: message,
      lastResumeAttemptAt: attemptAt,
    })
    updateDormantAgentSessions()
    logger.error('session_wake_failed', {
      sessionId,
      reason: 'create_window_failed',
      agentType: record.agentType,
      error: message,
    })
    const err: WakeError = { code: 'WAKE_FAILED', message }
    send(ws, { type: 'session-wake-result', sessionId, ok: false, error: err })
  } finally {
    wakeInFlight.delete(sessionId)
  }
}

function initializePersistentTerminal(ws: ServerWebSocket<WSData>) {
  if (ws.data.terminal) {
    return
  }

  const terminal = createPersistentTerminal(ws)
  ws.data.terminal = terminal

  void terminal.start().catch((error) => {
    ws.data.terminal = null
    clearAttachDedup(ws)
    handleTerminalError(ws, null, error, 'ERR_TMUX_ATTACH_FAILED')
  })
}

function createPersistentTerminal(ws: ServerWebSocket<WSData>) {
  const sessionName = `${config.tmuxSession}-ws-${ws.data.connectionId}`

  const terminal = createTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: config.tmuxSession,
    monitorTargets: config.terminalMonitorTargets,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) {
        return
      }
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced (e.g. by SSH proxy)
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (sockets.has(ws)) {
        sendTerminalError(
          ws,
          sessionId,
          'ERR_TMUX_ATTACH_FAILED',
          'tmux client exited',
          true
        )
      }
    },
  })

  return terminal
}

function isTerminalAttachCurrent(ws: ServerWebSocket<WSData>, attachSeq: number): boolean {
  return ws.data.terminalAttachSeq === attachSeq
}

async function ensurePersistentTerminal(
  ws: ServerWebSocket<WSData>,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (!ws.data.terminal) {
    const created = createPersistentTerminal(ws)
    // If a newer attach/detach arrived while creating the proxy, dispose it.
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      await created.dispose()
      return null
    }
    ws.data.terminal = created
  }

  const terminal = ws.data.terminal
  try {
    await terminal.start()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return null
    }
    return terminal
  } catch (error) {
    if (ws.data.terminal === terminal) {
      ws.data.terminal = null
      clearAttachDedup(ws)
    }
    throw error
  }
}

async function ensureCorrectProxyType(
  ws: ServerWebSocket<WSData>,
  session: Session,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  const needsSsh = session.remote === true && !!session.host
  const currentHost = ws.data.terminalHost

  // Same type — reuse existing proxy
  if (!needsSsh && !currentHost) {
    return ensurePersistentTerminal(ws, attachSeq)
  }
  if (needsSsh && currentHost === session.host) {
    if (ws.data.terminal) {
      const terminal = ws.data.terminal
      try {
        await terminal.start()
        if (!isTerminalAttachCurrent(ws, attachSeq)) {
          return null
        }
        return terminal
      } catch (error) {
        if (ws.data.terminal === terminal) {
          ws.data.terminal = null
          ws.data.terminalHost = null
          clearAttachDedup(ws)
        }
        throw error
      }
    }
  }

  // Type mismatch — dispose old proxy and create new one
  if (ws.data.terminal) {
    const oldTerminal = ws.data.terminal
    // Clear references BEFORE dispose so the onExit guard sees the proxy was replaced
    // (dispose triggers process exit → onExit callback, which checks ws.data.terminal !== terminal)
    if (isTerminalAttachCurrent(ws, attachSeq) && ws.data.terminal === oldTerminal) {
      ws.data.terminal = null
      ws.data.terminalHost = null
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      clearAttachDedup(ws)
    }
    await oldTerminal.dispose()
  }

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (needsSsh) {
    return createAndStartSshProxy(ws, session.host!, attachSeq)
  } else {
    return ensurePersistentTerminal(ws, attachSeq)
  }
}

async function createAndStartSshProxy(
  ws: ServerWebSocket<WSData>,
  host: string,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  const sshOptions = sshOptionsForHost()
  const sessionName = `${config.tmuxSession}-ws-${ws.data.connectionId}`

  const terminal = new SshTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: '', // not used for SSH standalone sessions
    host,
    sshOptions,
    commandTimeoutMs: config.remoteTimeoutMs,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) return
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      logger.warn('ssh_proxy_onExit', {
        sessionName,
        sessionId,
        host,
        connectionId: ws.data.connectionId,
      })
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (sockets.has(ws)) {
        sendTerminalError(ws, sessionId, 'ERR_TMUX_ATTACH_FAILED', 'SSH tmux client exited', true)
      }
    },
  })

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    await terminal.dispose()
    return null
  }

  ws.data.terminal = terminal
  ws.data.terminalHost = host

  try {
    await terminal.start()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      await terminal.dispose()
      return null
    }
    if (ws.data.terminal !== terminal) {
      // Another attach request replaced this proxy while it was starting.
      await terminal.dispose()
      return null
    }
    return terminal
  } catch (error) {
    if (ws.data.terminal === terminal) {
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
    }
    throw error
  }
}

async function attachTerminalPersistent(
  ws: ServerWebSocket<WSData>,
  message: Extract<ClientMessage, { type: 'terminal-attach' }>,
  attachSeq: number
) {
  const { sessionId, tmuxTarget, cols, rows } = message

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (!isValidSessionId(sessionId)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid session id', false)
    }
    return
  }

  const session = registry.get(sessionId)
  if (!session) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Session not found', false)
    }
    return
  }
  if (session.remote && !config.remoteAllowAttach) {
    const host = session.host ? ` on ${session.host}` : ''
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', `Remote session${host} is read-only`, false)
    }
    return
  }

  const target = tmuxTarget ?? session.tmuxWindow
  if (!isValidTmuxTarget(target)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid tmux target', false)
    }
    return
  }

  const t0 = performance.now()

  let terminal: ITerminalProxy | null = null
  try {
    terminal = await ensureCorrectProxyType(ws, session, attachSeq)
    if (!terminal) return
  } catch (error) {
    if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ws, sessionId, error, 'ERR_TMUX_ATTACH_FAILED')
    }
    return
  }

  const tProxy = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (typeof cols === 'number' && typeof rows === 'number') {
    terminal.resize(cols, rows)
  }

  const effectiveTarget = terminal.resolveEffectiveTarget(target)

  // Deduplicate rapid re-attaches to the same session+target (e.g. two
  // terminal-attach messages arriving within ~34ms).  Skip the expensive
  // scrollback capture and just acknowledge readiness.
  const attachKey = `${sessionId}:${effectiveTarget}`
  const now = performance.now()
  const ATTACH_DEDUP_MS = 500

  if (ws.data.lastAttachKey === attachKey &&
      now - ws.data.lastAttachTs < ATTACH_DEDUP_MS) {
    logger.debug('terminal_attach_dedup', {
      sessionId, target, effectiveTarget, attachSeq,
      elapsedMs: Math.round(now - ws.data.lastAttachTs),
      connectionId: ws.data.connectionId,
    })
    // Still need to set currentSessionId so input works
    ws.data.currentSessionId = sessionId
    ws.data.currentTmuxTarget = effectiveTarget
    send(ws, { type: 'terminal-ready', sessionId })
    return
  }

  // Capture scrollback history BEFORE switching to avoid race with live output
  const history = session.remote && session.host
    ? await captureTmuxHistoryRemote(effectiveTarget, session.host)
    : captureTmuxHistory(effectiveTarget)

  const tCapture = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  try {
    await terminal.switchTo(target, () => {
      if (!isTerminalAttachCurrent(ws, attachSeq)) return
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = effectiveTarget
      // Send history in chunks sized to fit TCP's initial congestion window
      // (~14.6KB). On high-latency connections (5G/Tailscale), the first chunk
      // arrives before slow start ramps up, letting the client render partial
      // content immediately instead of waiting for the full payload.
      if (history) {
        const HISTORY_CHUNK_SIZE = 12_000
        const tStr = performance.now()
        let totalBytes = 0
        let chunks = 0
        for (let offset = 0; offset < history.length; offset += HISTORY_CHUNK_SIZE) {
          const chunk = history.slice(offset, offset + HISTORY_CHUNK_SIZE)
          const payload = JSON.stringify({ type: 'terminal-output', sessionId, data: chunk })
          ws.send(payload)
          totalBytes += payload.length
          chunks += 1
        }
        const stringifyMs = Math.round(performance.now() - tStr)
        logger.debug('terminal_history_send', {
          sessionId,
          stringifyMs,
          payloadBytes: totalBytes,
          historyChars: history.length,
          chunks,
          connectionId: ws.data.connectionId,
        })
      }
    })
    // Yield to flush WebSocket buffers immediately after sending history.
    // Without this, Bun buffers the ws.send() data and doesn't flush until
    // the event loop is free — which can be seconds if other sync work follows.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const tSwitch = performance.now()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    ws.data.currentSessionId = sessionId
    ws.data.currentTmuxTarget = effectiveTarget
    // Record dedup key only after successful switch — prevents a second
    // attach from hitting the dedup fast-path while the first is still in flight.
    ws.data.lastAttachKey = attachKey
    ws.data.lastAttachTs = performance.now()
    logger.info('terminal_attach_profile', {
      sessionId,
      target,
      effectiveTarget,
      remote: !!session.remote,
      proxyMs: Math.round(tProxy - t0),
      captureMs: Math.round(tCapture - tProxy),
      switchMs: Math.round(tSwitch - tCapture),
      totalMs: Math.round(tSwitch - t0),
      historyBytes: history?.length ?? 0,
      connectionId: ws.data.connectionId,
    })
    send(ws, { type: 'terminal-ready', sessionId })
  } catch (error) {
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    logger.warn('terminal_switch_failed', {
      sessionId,
      target,
      effectiveTarget,
      error: error instanceof Error ? error.message : String(error),
      connectionId: ws.data.connectionId,
    })
    if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
    }
  }
}

function captureTmuxHistory(target: string): string | null {
  try {
    // Capture only the visible pane so initial attach paints the current view
    // immediately instead of replaying the entire scrollback buffer.
    const result = Bun.spawnSync(['tmux', 'capture-pane', '-t', target, '-p', '-J'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: config.tmuxTimeoutMs,
    })
    if (result.exitCode !== 0) {
      return null
    }
    const output = result.stdout.toString()
    // Only return if there's actual content
    if (output.trim().length === 0) {
      return null
    }
    return output
  } catch {
    return null
  }
}

function sshOptionsForHost(): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=3',
    // Avoid using stale multiplex control sockets for control-plane commands.
    // Users can still enable multiplexing for poller connections via ~/.ssh/config.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    ...splitSshOptions(config.remoteSshOpts),
  ]
}

async function runRemoteTmux(host: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const remoteCmd = `tmux -u ${args.map(a => shellQuote(a)).join(' ')}`
  const opts = sshOptionsForHost()
  const proc = Bun.spawn(['ssh', ...opts, host, remoteCmd], { stdout: 'pipe', stderr: 'pipe' })

  const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 10_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout!).text(),
      new Response(proc.stderr!).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

async function runRemoteSsh(host: string, remoteCmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const opts = sshOptionsForHost()
  const proc = Bun.spawn(['ssh', ...opts, host, remoteCmd], { stdout: 'pipe', stderr: 'pipe' })

  const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 10_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout!).text(),
      new Response(proc.stderr!).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

async function captureTmuxHistoryRemote(target: string, host: string): Promise<string | null> {
  try {
    const result = await runRemoteTmux(host, ['capture-pane', '-t', target, '-p', '-J'])
    if (result.exitCode !== 0) return null
    const output = result.stdout ?? ''
    if (output.trim().length === 0) return null
    return output
  } catch {
    return null
  }
}

function detachTerminalPersistent(ws: ServerWebSocket<WSData>, sessionId: string) {
  // Cancel any in-flight attach/switch operations so stale completions don't
  // clobber the newly-selected session.
  ws.data.terminalAttachSeq += 1
  if (ws.data.currentSessionId === sessionId) {
    ws.data.currentSessionId = null
    ws.data.currentTmuxTarget = null
  }
  // Clear dedup so a fast A→B→A switch doesn't skip scrollback for A
  clearAttachDedup(ws)
}

function handleTerminalInputPersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  data: string
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  ws.data.terminal?.write(data)

  // On Enter key: immediately set "working" status and schedule refresh
  if (data.includes('\r') || data.includes('\n')) {
    if (!session?.remote) {
      setForceWorking(sessionId)
      scheduleEnterRefresh()
      scheduleLastUserMessageCapture(sessionId)
    }
  }
}

function handleTerminalResizePersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  cols: number,
  rows: number
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  ws.data.terminal?.resize(cols, rows)
}


function sendTerminalError(
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  code: TerminalErrorCode,
  message: string,
  retryable: boolean
) {
  logger.warn('sending_terminal_error', {
    sessionId,
    code,
    message,
    retryable,
    connectionId: ws.data.connectionId,
  })
  send(ws, {
    type: 'terminal-error',
    sessionId,
    code,
    message,
    retryable,
  })
}

function handleTerminalError(
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  error: unknown,
  fallbackCode: TerminalErrorCode
) {
  if (error instanceof TerminalProxyError) {
    sendTerminalError(ws, sessionId, error.code, error.message, error.retryable)
    return
  }

  const message =
    error instanceof Error ? error.message : 'Terminal operation failed'
  sendTerminalError(ws, sessionId, fallbackCode, message, true)
}
