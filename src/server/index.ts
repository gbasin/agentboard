import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { LegacyTerminalProxy } from './LegacyTerminalProxy'
import { TerminalProxy, TerminalProxyError } from './TerminalProxy'
import type { ClientMessage, ServerMessage, TerminalErrorCode } from '../shared/types'

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
    console.error(`\nPort ${port} already in use by PID ${pid} (${processName})`)
    console.error(`Run: kill ${pid}\n`)
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

const MAX_FIELD_LENGTH = 4096
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

const app = new Hono()
const sessionManager = new SessionManager()
const registry = new SessionRegistry()

function refreshSessions() {
  const sessions = sessionManager.listWindows()
  registry.replaceSessions(sessions)
}

refreshSessions()
setInterval(refreshSessions, config.refreshIntervalMs)

registry.on('session-update', (session) => {
  broadcast({ type: 'session-update', session })
})

registry.on('sessions', (sessions) => {
  broadcast({ type: 'sessions', sessions })
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/sessions', (c) => c.json(registry.getAll()))

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

interface WSData {
  terminals: Map<string, LegacyTerminalProxy>
  terminal: TerminalProxy | null
  currentSessionId: string | null
  connectionId: string
}

const sockets = new Set<ServerWebSocket<WSData>>()

const tlsEnabled = config.tlsCert && config.tlsKey

Bun.serve<WSData>({
  port: config.port,
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
            terminals: new Map(),
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
      if (config.persistentClient) {
        initializePersistentTerminal(ws)
      }
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
console.log(`Agentboard server running on ${protocol}://localhost:${config.port}`)

// Cleanup all terminals on server shutdown
function cleanupAllTerminals() {
  for (const ws of sockets) {
    cleanupTerminals(ws)
  }
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
  if (config.persistentClient) {
    if (ws.data.terminal) {
      void ws.data.terminal.dispose()
      ws.data.terminal = null
    }
    ws.data.currentSessionId = null
    return
  }

  for (const terminal of ws.data.terminals.values()) {
    terminal.dispose()
  }
  ws.data.terminals.clear()
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
      if (config.persistentClient) {
        void attachTerminalPersistent(ws, message)
      } else {
        attachTerminalLegacy(ws, message.sessionId)
      }
      return
    case 'terminal-detach':
      if (config.persistentClient) {
        detachTerminalPersistent(ws, message.sessionId)
      } else {
        detachTerminalLegacy(ws, message.sessionId)
      }
      return
    case 'terminal-input':
      if (config.persistentClient) {
        handleTerminalInputPersistent(ws, message.sessionId, message.data)
      } else {
        ws.data.terminals.get(message.sessionId)?.write(message.data)
      }
      return
    case 'terminal-resize':
      if (config.persistentClient) {
        handleTerminalResizePersistent(
          ws,
          message.sessionId,
          message.cols,
          message.rows
        )
      } else {
        ws.data.terminals
          .get(message.sessionId)
          ?.resize(message.cols, message.rows)
      }
      return
    default:
      send(ws, { type: 'error', message: 'Unknown message type' })
  }
}

function handleKill(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' })
    return
  }
  if (session.source !== 'managed') {
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

function attachTerminalLegacy(ws: ServerWebSocket<WSData>, sessionId: string) {
  const session = registry.get(sessionId)
  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' })
    return
  }

  // Detach ALL existing terminals first - only one terminal at a time
  for (const [existingId, terminal] of ws.data.terminals) {
    terminal.dispose()
    ws.data.terminals.delete(existingId)
  }

  const terminal = new LegacyTerminalProxy(session.tmuxWindow, {
    onData: (data) => {
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      detachTerminalLegacy(ws, sessionId)
    },
  })

  terminal.start()
  ws.data.terminals.set(sessionId, terminal)
}

function detachTerminalLegacy(ws: ServerWebSocket<WSData>, sessionId: string) {
  const terminal = ws.data.terminals.get(sessionId)
  if (!terminal) {
    return
  }

  terminal.dispose()
  ws.data.terminals.delete(sessionId)
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

  const terminal = new TerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: config.tmuxSession,
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
): Promise<TerminalProxy | null> {
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

  try {
    await terminal.switchTo(target, () => {
      ws.data.currentSessionId = sessionId
    })
    ws.data.currentSessionId = sessionId
    send(ws, { type: 'terminal-ready', sessionId })
  } catch (error) {
    handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
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
