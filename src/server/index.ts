import type { ServerWebSocket } from 'bun'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config, isValidHostname } from './config'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { initDatabase } from './db'
import { LogPoller } from './logPoller'
import { toAgentSession } from './agentSessions'
import { getLogSearchDirs } from './logDiscovery'
import { verifyWindowLogAssociationDetailed } from './logMatcher'
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
  type HostStatus,
  type ResumeError,
  type Session,
} from '../shared/types'
import { logger } from './logger'
import { SessionRefreshWorkerClient } from './sessionRefreshWorkerClient'
import {
  setForceWorkingUntil,
  applyForceWorkingOverrides,
} from './forceWorkingStatus'
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

function checkPortAvailable(port: number): void {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(['lsof', '-i', `:${port}`, '-t'], {
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
      ['tmux', 'list-sessions', '-F', '#{session_name}\t#{session_attached}'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
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
  const lines = output.split('\n')
  let pruned = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, attachedRaw] = trimmed.split('\t')
    if (!name || !name.startsWith(prefix)) continue
    const attached = Number.parseInt(attachedRaw ?? '', 10)
    if (Number.isNaN(attached) || attached > 0) continue
    try {
      const killResult = Bun.spawnSync(['tmux', 'kill-session', '-t', name], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
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
  onSessionOrphaned: (sessionId) => {
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({ type: 'session-orphaned', session: toAgentSession(session) })
    }
  },
  onSessionActivated: (sessionId, window) => {
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

function updateAgentSessions() {
  const active = db.getActiveSessions().map(toAgentSession)
  let inactive = db.getInactiveSessions({ maxAgeHours: runtimeInactiveMaxAgeHours }).map(toAgentSession)
  // Filter out sessions from excluded project directories
  // Use "<empty>" as a special marker to exclude sessions with no project path
  if (config.excludeProjects?.length > 0) {
    inactive = inactive.filter((session) => {
      const projectPath = session.projectPath || ''
      return !config.excludeProjects.some((excluded) => {
        if (excluded === '<empty>') return projectPath === ''
        return projectPath.startsWith(excluded)
      })
    })
  }
  registry.setAgentSessions(active, inactive)
}

function hydrateSessionsWithAgentSessions(
  sessions: Session[],
  { verifyAssociations = false }: { verifyAssociations?: boolean } = {}
): Session[] {
  const activeSessions = db.getActiveSessions()
  const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
  const activeMap = new Map<string, typeof activeSessions[number]>()
  const orphaned: AgentSession[] = []
  const logDirs = getLogSearchDirs()

  for (const agentSession of activeSessions) {
    if (!agentSession.currentWindow || !windowSet.has(agentSession.currentWindow)) {
      logger.info('session_orphaned', {
        sessionId: agentSession.sessionId,
        displayName: agentSession.displayName,
        currentWindow: agentSession.currentWindow,
        windowSetSize: windowSet.size,
        windowSetSample: Array.from(windowSet).slice(0, 5),
      })
      const orphanedSession = db.orphanSession(agentSession.sessionId)
      if (orphanedSession) {
        orphaned.push(toAgentSession(orphanedSession))
      }
      continue
    }

    // Verify the association by checking terminal content matches the log
    // This catches stale associations from tmux restarts where window IDs changed
    // Only run on startup to avoid blocking periodic refreshes
    if (verifyAssociations) {
      // Exclude logs from other active sessions to prevent cross-session pollution
      // (e.g., discussing session A's content in session B causes B's log to match A's window)
      const otherSessionLogPaths = activeSessions
        .filter((s) => s.sessionId !== agentSession.sessionId && s.currentWindow)
        .map((s) => s.logFilePath)

      const verification = verifyWindowLogAssociationDetailed(
        agentSession.currentWindow,
        agentSession.logFilePath,
        logDirs,
        {
          context: { agentType: agentSession.agentType, projectPath: agentSession.projectPath },
          excludeLogPaths: otherSessionLogPaths,
        }
      )

      // Get the window to check name match for fallback
      const window = sessions.find((s) => s.tmuxWindow === agentSession.currentWindow)
      const nameMatches = Boolean(window && window.name === agentSession.displayName)

      // Decide whether to orphan based on verification status and name match
      let shouldOrphan = false
      let fallbackUsed = false

      if (verification.status === 'verified') {
        // Content confirms association - keep
        shouldOrphan = false
      } else if (nameMatches) {
        // Name matches - trust it over content mismatch/inconclusive
        // Window names are user-intentional signals, so honor them even if
        // content matching finds a "better" match in another log (which can
        // happen due to similar content across sessions or limited scrollback)
        shouldOrphan = false
        fallbackUsed = true
      } else {
        // No name match and content doesn't verify - orphan
        shouldOrphan = true
      }

      if (shouldOrphan) {
        logger.info('session_verification_failed', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow: agentSession.currentWindow,
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
          currentWindow: agentSession.currentWindow,
          verificationStatus: verification.status,
        })
      }
    }

    activeMap.set(agentSession.currentWindow, agentSession)
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
  }

  updateAgentSessions()
  return hydrated
}

let refreshInFlight = false

async function refreshSessionsAsync(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    const sessions = await sessionRefreshWorker.refresh(
      config.tmuxSession,
      config.discoverPrefixes
    )
    const hydrated = hydrateSessionsWithAgentSessions(sessions)
    const withOverrides = applyForceWorkingOverrides(hydrated)
    registry.replaceSessions(mergeRemoteSessions(withOverrides))
  } catch (error) {
    // Fallback to sync on worker failure
    logger.warn('session_refresh_worker_error', {
      message: error instanceof Error ? error.message : String(error),
    })
    const sessions = sessionManager.listWindows()
    const hydrated = hydrateSessionsWithAgentSessions(sessions)
    const withOverrides = applyForceWorkingOverrides(hydrated)
    registry.replaceSessions(mergeRemoteSessions(withOverrides))
  } finally {
    refreshInFlight = false
  }
}

function refreshSessions() {
  void refreshSessionsAsync()
}

// Sync version for startup - ensures sessions are ready before server starts
function refreshSessionsSync({ verifyAssociations = false } = {}) {
  const sessions = sessionManager.listWindows()
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
    const message = await sessionRefreshWorker.getLastUserMessage(tmuxWindow)
    if (!message || !message.trim()) return
    const record = db.getSessionByWindow(tmuxWindow)
    if (!record) return
    if (record.lastUserMessage === message) return
    const updated = db.updateSession(record.sessionId, { lastUserMessage: message })
    if (!updated) return
    registry.updateSession(tmuxWindow, { lastUserMessage: message })
    updateAgentSessions()
  } catch (error) {
    logger.warn('last_user_message_capture_error', {
      tmuxWindow,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}


// Log startup state for debugging orphan issues
const startupActiveSessions = db.getActiveSessions()
const startupWindows = sessionManager.listWindows()
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

refreshSessionsSync({ verifyAssociations: true }) // Sync for startup - ensures sessions are ready
resurrectPinnedSessions() // Resurrect pinned sessions that lost their tmux windows
refreshSessionsSync() // Re-hydrate after resurrection
setInterval(refreshSessions, config.refreshIntervalMs) // Async for periodic
if (config.logPollIntervalMs > 0) {
  logPoller.start(config.logPollIntervalMs)
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

registry.on('agent-sessions', ({ active, inactive }) => {
  broadcast({ type: 'agent-sessions', active, inactive })
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

    // Read last 64KB of the file
    const TAIL_BYTES = 64 * 1024
    const fileSize = stats.size
    const offset = Math.max(0, fileSize - TAIL_BYTES)
    const fd = await fs.open(logPath, 'r')
    const buffer = Buffer.alloc(Math.min(TAIL_BYTES, fileSize))
    await fd.read(buffer, 0, buffer.length, offset)
    await fd.close()

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
      .sort((a, b) => {
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
  const tailscaleIp = getTailscaleIp()
  return c.json({
    port: config.port,
    tailscaleIp,
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
  try {
    const body = await c.req.json()
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400)
    }
    db.setAppSetting(TMUX_MOUSE_MODE_KEY, String(body.enabled))
    sessionManager.setMouseMode(body.enabled)
    return c.json({ enabled: body.enabled })
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
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
    updateAgentSessions()
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

Bun.serve<WSData>({
  port: config.port,
  hostname: config.hostname,
  ...(tlsEnabled && {
    tls: {
      cert: Bun.file(config.tlsCert),
      key: Bun.file(config.tlsKey),
    },
  }),
  fetch(req, server) {
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
          },
        })
      ) {
        return
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    return app.fetch(req)
  },
  websocket: {
    open(ws) {
      sockets.add(ws)
      send(ws, { type: 'sessions', sessions: registry.getAll() })
      send(ws, { type: 'host-status', hosts: hostStatuses })
      send(ws, {
        type: 'server-config',
        remoteAllowControl: config.remoteAllowControl,
        remoteAllowAttach: config.remoteAllowAttach,
        hostLabel: config.hostLabel,
      })
      const agentSessions = registry.getAgentSessions()
      send(ws, {
        type: 'agent-sessions',
        active: agentSessions.active,
        inactive: agentSessions.inactive,
      })
      initializePersistentTerminal(ws)
    },
    message(ws, message) {
      handleMessage(ws, message)
    },
    close(ws) {
      cleanupTerminals(ws)
      sockets.delete(ws)
    },
  },
})

const protocol = tlsEnabled ? 'https' : 'http'
const displayHost = config.hostname === '0.0.0.0' ? 'localhost' : config.hostname
logger.info('server_started', {
  url: `${protocol}://${displayHost}:${config.port}`,
  tailscaleUrl: config.hostname === '0.0.0.0' ? (() => {
    const tsIp = getTailscaleIp()
    return tsIp ? `${protocol}://${tsIp}:${config.port}` : null
  })() : null,
})

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

function cleanupTerminals(ws: ServerWebSocket<WSData>) {
  if (ws.data.terminal) {
    void ws.data.terminal.dispose()
    ws.data.terminal = null
  }
  ws.data.currentSessionId = null
  ws.data.currentTmuxTarget = null
  ws.data.terminalHost = null
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
    case 'session-resume':
      handleSessionResume(message, ws)
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
        '-F', '#{window_index}\t#{window_id}',
        '-t', tmuxSession, '-n', windowName, '-c', trimmedPath, wrappedCommand,
      ])
    } else {
      // Session doesn't exist — create it with the desired window directly
      // (avoids an orphan window 0 from a separate new-session call)
      createResult = await runRemoteTmux(host, [
        'new-session', '-d', '-P',
        '-F', '#{window_index}\t#{window_id}',
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
    const parts = printOutput.split('\t')
    const now = Date.now()

    if (parts.length < 2 || !parts[0]) {
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
        ['tmux', 'display-message', '-p', '-t', target, '#{pane_in_mode}'],
        { stdout: 'pipe', stderr: 'pipe' }
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
      updateAgentSessions()
      for (const orphanedSession of orphaned.values()) {
        broadcast({ type: 'session-orphaned', session: orphanedSession })
      }
    }
    const remaining = registry.getAll().filter((item) => item.id !== sessionId)
    registry.replaceSessions(remaining)
    refreshSessions()
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

  updateAgentSessions()
}

function resurrectPinnedSessions() {
  const orphanedPinned = db.getPinnedOrphaned()
  if (orphanedPinned.length === 0) {
    return
  }

  logger.info('resurrect_pinned_sessions_start', { count: orphanedPinned.length })

  for (const record of orphanedPinned) {
    // Validate sessionId before using in command
    if (!isValidSessionId(record.sessionId)) {
      const errorMsg = 'Invalid session id format'
      db.updateSession(record.sessionId, { isPinned: false, lastResumeError: errorMsg })
      broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      logger.error('resurrect_pinned_session_invalid_id', {
        sessionId: record.sessionId,
        displayName: record.displayName,
      })
      continue
    }

    const resumeTemplate =
      record.agentType === 'claude' ? config.claudeResumeCmd : config.codexResumeCmd

    // Validate template contains {sessionId} placeholder
    if (!resumeTemplate.includes('{sessionId}')) {
      const errorMsg = `Resume command template missing {sessionId} placeholder: ${resumeTemplate}`
      db.updateSession(record.sessionId, { isPinned: false, lastResumeError: errorMsg })
      broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      logger.error('resurrect_pinned_session_invalid_template', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        template: resumeTemplate,
      })
      continue
    }

    const command = resumeTemplate.replace('{sessionId}', record.sessionId)
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
      db.updateSession(record.sessionId, {
        currentWindow: created.tmuxWindow,
        displayName: created.name,
        lastResumeError: null, // Clear any previous error on success
      })
      logger.info('resurrect_pinned_session_success', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        tmuxWindow: created.tmuxWindow,
      })
    } catch (error) {
      // Resurrection failed - unpin the session and persist error
      const errorMsg = error instanceof Error ? error.message : String(error)
      db.updateSession(record.sessionId, { isPinned: false, lastResumeError: errorMsg })
      broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      logger.error('resurrect_pinned_session_failed', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
    }
  }
}

function handleSessionResume(
  message: Extract<ClientMessage, { type: 'session-resume' }>,
  ws: ServerWebSocket<WSData>
) {
  const sessionId = message.sessionId
  if (!isValidSessionId(sessionId)) {
    const error: ResumeError = {
      code: 'NOT_FOUND',
      message: 'Invalid session id',
    }
    send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
    return
  }

  const record = db.getSessionById(sessionId)
  if (!record) {
    const error: ResumeError = { code: 'NOT_FOUND', message: 'Session not found' }
    send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
    return
  }

  if (record.currentWindow) {
    const error: ResumeError = {
      code: 'ALREADY_ACTIVE',
      message: 'Session is already active',
    }
    send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
    return
  }

  const resumeTemplate =
    record.agentType === 'claude' ? config.claudeResumeCmd : config.codexResumeCmd

  // Validate template contains {sessionId} placeholder
  if (!resumeTemplate.includes('{sessionId}')) {
    const error: ResumeError = {
      code: 'RESUME_FAILED',
      message: `Resume command template missing {sessionId} placeholder`,
    }
    send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
    return
  }

  const command = resumeTemplate.replace('{sessionId}', sessionId)
  const projectPath =
    record.projectPath ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    '.'

  try {
    const created = stampLocalSession(sessionManager.createWindow(
      projectPath,
      message.name ?? record.displayName,
      command,
      { excludeSessionId: sessionId }
    ))
    db.updateSession(sessionId, {
      currentWindow: created.tmuxWindow,
      displayName: created.name,
      lastResumeError: null, // Clear any previous error on success
    })
    // Add session to registry immediately so terminal can attach
    // (async refresh will update with any additional data later)
    const currentSessions = registry.getAll()
    registry.replaceSessions([created, ...currentSessions])
    refreshSessions()
    send(ws, { type: 'session-resume-result', sessionId, ok: true, session: created })
    broadcast({
      type: 'session-activated',
      session: toAgentSession({
        ...record,
        currentWindow: created.tmuxWindow,
        displayName: created.name,
      }),
      window: created.tmuxWindow,
    })
  } catch (error) {
    const err: ResumeError = {
      code: 'RESUME_FAILED',
      message:
        error instanceof Error ? error.message : 'Unable to resume session',
    }
    send(ws, { type: 'session-resume-result', sessionId, ok: false, error: err })
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

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (typeof cols === 'number' && typeof rows === 'number') {
    terminal.resize(cols, rows)
  }

  // Capture scrollback history BEFORE switching to avoid race with live output
  const history = session.remote && session.host
    ? await captureTmuxHistoryRemote(target, session.host)
    : captureTmuxHistory(target)

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  try {
    await terminal.switchTo(target, () => {
      if (!isTerminalAttachCurrent(ws, attachSeq)) return
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = target
      // Send history in onReady callback, before output suppression is lifted
      if (history) {
        send(ws, { type: 'terminal-output', sessionId, data: history })
      }
    })
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    ws.data.currentSessionId = sessionId
    ws.data.currentTmuxTarget = target
    logger.info('terminal_ready_sent', { sessionId, target, connectionId: ws.data.connectionId })
    send(ws, { type: 'terminal-ready', sessionId })
  } catch (error) {
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    logger.warn('terminal_switch_failed', {
      sessionId,
      target,
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
    // Capture full scrollback history (-S - means from start, -E - means to end, -J joins wrapped lines)
    const result = Bun.spawnSync(
      ['tmux', 'capture-pane', '-t', target, '-p', '-S', '-', '-E', '-', '-J'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
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
  const remoteCmd = `tmux ${args.map(a => shellQuote(a)).join(' ')}`
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
    const result = await runRemoteTmux(host, ['capture-pane', '-t', target, '-p', '-S', '-', '-E', '-', '-J'])
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
