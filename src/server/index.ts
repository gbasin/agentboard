import type { ServerWebSocket } from 'bun'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { initDatabase } from './db'
import { LogPoller } from './logPoller'
import { toAgentSession } from './agentSessions'
import {
  createTerminalProxy,
  resolveTerminalMode,
  TerminalProxyError,
} from './terminal'
import type { ITerminalProxy } from './terminal'
import { resolveProjectPath } from './paths'
import type {
  ClientMessage,
  ServerMessage,
  TerminalErrorCode,
  DirectoryListing,
  DirectoryErrorResponse,
  AgentSession,
  ResumeError,
  Session,
} from '../shared/types'
import { logger } from './logger'

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

const MAX_FIELD_LENGTH = 4096
const MAX_DIRECTORY_ENTRIES = 200
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:@-]+$/
const TMUX_TARGET_PATTERN =
  /^(?:[A-Za-z0-9_.-]+:)?(?:@[0-9]+|[A-Za-z0-9_.-]+)$/

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
const sessionManager = new SessionManager()
const registry = new SessionRegistry()
const db = initDatabase()
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
  maxLogsPerPoll: config.logPollMax,
  rgThreads: config.rgThreads,
  matchProfile: config.logMatchProfile,
  matchWorker: config.logMatchWorker,
})

interface WSData {
  terminal: ITerminalProxy | null
  currentSessionId: string | null
  connectionId: string
}

const sockets = new Set<ServerWebSocket<WSData>>()

function updateAgentSessions() {
  const active = db.getActiveSessions().map(toAgentSession)
  const inactive = db.getInactiveSessions().map(toAgentSession)
  registry.setAgentSessions(active, inactive)
}

function hydrateSessionsWithAgentSessions(sessions: Session[]): Session[] {
  const activeSessions = db.getActiveSessions()
  const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
  const activeMap = new Map<string, typeof activeSessions[number]>()
  const orphaned: AgentSession[] = []

  // Safeguard: don't mass-orphan if window list seems incomplete
  // This can happen if tmux commands fail temporarily on server restart
  const wouldOrphanCount = activeSessions.filter(
    (s) => s.currentWindow && !windowSet.has(s.currentWindow)
  ).length
  if (wouldOrphanCount > 0 && wouldOrphanCount === activeSessions.length) {
    logger.warn('hydrate_would_orphan_all', {
      activeSessionCount: activeSessions.length,
      windowCount: windowSet.size,
      wouldOrphanCount,
      message: 'Would orphan ALL active sessions - skipping to prevent data loss',
    })
    return sessions
  }

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

function refreshSessions() {
  const sessions = sessionManager.listWindows()
  const hydrated = hydrateSessionsWithAgentSessions(sessions)
  registry.replaceSessions(hydrated)
}

// Debounced refresh triggered by Enter key in terminal input
let enterRefreshTimer: Timer | null = null

function scheduleEnterRefresh() {
  if (enterRefreshTimer) {
    clearTimeout(enterRefreshTimer)
  }
  enterRefreshTimer = setTimeout(() => {
    enterRefreshTimer = null
    refreshSessions()
  }, config.enterRefreshDelayMs)
}

// Try to re-match orphaned sessions to windows by display name
function recoverOrphanedSessions() {
  const orphanedSessions = db.getInactiveSessions()
  const windows = sessionManager.listWindows()
  const activeSessions = db.getActiveSessions()

  // Build set of windows that already have sessions
  const claimedWindows = new Set(
    activeSessions.map((s) => s.currentWindow).filter(Boolean)
  )

  // Build map of window name -> window for unclaimed windows
  const unclaimedByName = new Map<string, typeof windows[number]>()
  for (const window of windows) {
    if (!claimedWindows.has(window.tmuxWindow)) {
      unclaimedByName.set(window.name, window)
    }
  }

  let recovered = 0
  for (const session of orphanedSessions) {
    const matchingWindow = unclaimedByName.get(session.displayName)
    if (matchingWindow) {
      db.updateSession(session.sessionId, {
        currentWindow: matchingWindow.tmuxWindow,
      })
      unclaimedByName.delete(session.displayName)
      recovered += 1
      logger.info('session_recovered', {
        sessionId: session.sessionId,
        displayName: session.displayName,
        window: matchingWindow.tmuxWindow,
      })
    }
  }

  if (recovered > 0) {
    logger.info('recovery_complete', { recoveredCount: recovered })
  }

  return recovered
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

// Try to recover orphaned sessions by matching display names to windows
recoverOrphanedSessions()

refreshSessions()
setInterval(refreshSessions, config.refreshIntervalMs)
if (config.logPollIntervalMs > 0) {
  logPoller.start(config.logPollIntervalMs)
}

registry.on('session-update', (session) => {
  broadcast({ type: 'session-update', session })
})

registry.on('sessions', (sessions) => {
  broadcast({ type: 'sessions', sessions })
})

registry.on('agent-sessions', ({ active, inactive }) => {
  broadcast({ type: 'agent-sessions', active, inactive })
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/sessions', (c) => c.json(registry.getAll()))

app.get('/api/session-preview/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  if (!sessionId || sessionId.length > MAX_FIELD_LENGTH || !SESSION_ID_PATTERN.test(sessionId)) {
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

app.use('/*', serveStatic({ root: './dist/client' }))

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
            connectionId: createConnectionId(),
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
function cleanupAllTerminals() {
  for (const ws of sockets) {
    cleanupTerminals(ws)
  }
  logPoller.stop()
  db.close()
}

process.on('SIGINT', () => {
  cleanupAllTerminals()
  process.exit(0)
})

process.on('SIGTERM', () => {
  cleanupAllTerminals()
  process.exit(0)
})

function cleanupTerminals(ws: ServerWebSocket<WSData>) {
  if (ws.data.terminal) {
    void ws.data.terminal.dispose()
    ws.data.terminal = null
  }
  ws.data.currentSessionId = null
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
      try {
        const created = sessionManager.createWindow(
          message.projectPath,
          message.name,
          message.command
        )
        refreshSessions()
        send(ws, { type: 'session-created', session: created })
      } catch (error) {
        send(ws, {
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Unable to create session',
        })
      }
      return
    case 'session-kill':
      handleKill(message.sessionId, ws)
      return
    case 'session-rename':
      handleRename(message.sessionId, message.newName, ws)
      return
    case 'terminal-attach':
      void attachTerminalPersistent(ws, message)
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
      handleCancelCopyMode(message.sessionId)
      return
    case 'session-resume':
      handleSessionResume(message, ws)
      return
    default:
      send(ws, { type: 'error', message: 'Unknown message type' })
  }
}

function handleCancelCopyMode(sessionId: string) {
  const session = registry.get(sessionId)
  if (!session) return

  try {
    // Exit tmux copy-mode quietly.
    Bun.spawnSync(['tmux', 'send-keys', '-X', '-t', session.tmuxWindow, 'cancel'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    // Ignore errors - copy-mode may not be active
  }
}

function handleKill(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' })
    return
  }
  if (session.source !== 'managed' && !config.allowKillExternal) {
    send(ws, { type: 'error', message: 'Cannot kill external sessions' })
    return
  }

  try {
    sessionManager.killWindow(session.tmuxWindow)
    refreshSessions()
  } catch (error) {
    send(ws, {
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Unable to kill session',
    })
  }
}

function handleRename(
  sessionId: string,
  newName: string,
  ws: ServerWebSocket<WSData>
) {
  const session = registry.get(sessionId)
  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' })
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
  const command = resumeTemplate.replace('{sessionId}', sessionId)
  const projectPath =
    record.projectPath ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    '.'

  try {
    const created = sessionManager.createWindow(
      projectPath,
      message.name ?? record.displayName,
      command
    )
    db.updateSession(sessionId, {
      currentWindow: created.tmuxWindow,
      displayName: created.name,
    })
    refreshSessions()
    send(ws, { type: 'session-resume-result', sessionId, ok: true })
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
      const sessionId = ws.data.currentSessionId
      if (!sessionId) {
        return
      }
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      const sessionId = ws.data.currentSessionId
      ws.data.currentSessionId = null
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

async function ensurePersistentTerminal(
  ws: ServerWebSocket<WSData>
): Promise<ITerminalProxy | null> {
  if (!ws.data.terminal) {
    ws.data.terminal = createPersistentTerminal(ws)
  }

  try {
    await ws.data.terminal.start()
    return ws.data.terminal
  } catch (error) {
    handleTerminalError(ws, ws.data.currentSessionId, error, 'ERR_TMUX_ATTACH_FAILED')
    ws.data.terminal = null
    return null
  }
}

async function attachTerminalPersistent(
  ws: ServerWebSocket<WSData>,
  message: Extract<ClientMessage, { type: 'terminal-attach' }>
) {
  const { sessionId, tmuxTarget, cols, rows } = message

  if (!isValidSessionId(sessionId)) {
    sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid session id', false)
    return
  }

  const session = registry.get(sessionId)
  if (!session) {
    sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Session not found', false)
    return
  }

  const target = tmuxTarget ?? session.tmuxWindow
  if (!isValidTmuxTarget(target)) {
    sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid tmux target', false)
    return
  }

  const terminal = await ensurePersistentTerminal(ws)
  if (!terminal) {
    return
  }

  if (typeof cols === 'number' && typeof rows === 'number') {
    terminal.resize(cols, rows)
  }

  // Capture scrollback history BEFORE switching to avoid race with live output
  const history = captureTmuxHistory(target)

  try {
    await terminal.switchTo(target, () => {
      ws.data.currentSessionId = sessionId
      // Send history in onReady callback, before output suppression is lifted
      if (history) {
        send(ws, { type: 'terminal-output', sessionId, data: history })
      }
    })
    ws.data.currentSessionId = sessionId
    send(ws, { type: 'terminal-ready', sessionId })
  } catch (error) {
    handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
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

function detachTerminalPersistent(ws: ServerWebSocket<WSData>, sessionId: string) {
  if (ws.data.currentSessionId === sessionId) {
    ws.data.currentSessionId = null
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
  ws.data.terminal?.write(data)

  // Schedule a quick status refresh after Enter key to catch working/waiting changes
  if (data.includes('\r') || data.includes('\n')) {
    scheduleEnterRefresh()
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
  ws.data.terminal?.resize(cols, rows)
}


function sendTerminalError(
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  code: TerminalErrorCode,
  message: string,
  retryable: boolean
) {
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

function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.length > MAX_FIELD_LENGTH) {
    return false
  }
  return SESSION_ID_PATTERN.test(sessionId)
}

function isValidTmuxTarget(target: string): boolean {
  if (!target || target.length > MAX_FIELD_LENGTH) {
    return false
  }
  return TMUX_TARGET_PATTERN.test(target)
}
