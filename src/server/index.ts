import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { TerminalProxy } from './TerminalProxy'
import type { ClientMessage, ServerMessage } from '../shared/types'

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
  terminals: Map<string, TerminalProxy>
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
      if (server.upgrade(req, { data: { terminals: new Map() } })) {
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
      attachTerminal(ws, message.sessionId)
      return
    case 'terminal-detach':
      detachTerminal(ws, message.sessionId)
      return
    case 'terminal-input':
      ws.data.terminals.get(message.sessionId)?.write(message.data)
      return
    case 'terminal-resize':
      ws.data.terminals
        .get(message.sessionId)
        ?.resize(message.cols, message.rows)
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

function attachTerminal(ws: ServerWebSocket<WSData>, sessionId: string) {
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

  const terminal = new TerminalProxy(session.tmuxWindow, {
    onData: (data) => {
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      detachTerminal(ws, sessionId)
    },
  })

  terminal.start()
  ws.data.terminals.set(sessionId, terminal)
}

function detachTerminal(ws: ServerWebSocket<WSData>, sessionId: string) {
  const terminal = ws.data.terminals.get(sessionId)
  if (!terminal) {
    return
  }

  terminal.dispose()
  ws.data.terminals.delete(sessionId)
}
