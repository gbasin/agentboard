import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { StatusWatcher } from './StatusWatcher'
import { TerminalProxy } from './TerminalProxy'
import type { ClientMessage, ServerMessage } from '../shared/types'

ensureTmux()

const app = new Hono()
const sessionManager = new SessionManager()
const registry = new SessionRegistry()
const statusWatcher = new StatusWatcher(registry)
statusWatcher.start()

async function refreshSessions() {
  const sessions = sessionManager.listWindows()
  registry.replaceSessions(sessions)
  await statusWatcher.syncSessions(registry.getAll())
}

await refreshSessions()
setInterval(() => {
  void refreshSessions()
}, config.refreshIntervalMs)

registry.on('session-update', (session) => {
  broadcast({ type: 'session-update', session })
})

registry.on('sessions', (sessions) => {
  broadcast({ type: 'sessions', sessions })
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/sessions', (c) => c.json(registry.getAll()))

app.use('/*', serveStatic({ root: './dist/client' }))

interface WSData {
  terminals: Map<string, TerminalProxy>
}

const sockets = new Set<ServerWebSocket<WSData>>()

Bun.serve<WSData>({
  port: config.port,
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

console.log(`Agentboard server running on http://localhost:${config.port}`)

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

async function handleMessage(
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
      await refreshSessions()
      return
    case 'session-create':
      try {
        sessionManager.createWindow(message.projectPath, message.name)
        await refreshSessions()
      } catch (error) {
        send(ws, {
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Unable to create session',
        })
      }
      return
    case 'session-kill':
      await handleKill(message.sessionId, ws)
      return
    case 'session-rename':
      await handleRename(message.sessionId, message.newName, ws)
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

async function handleKill(
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
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
    await refreshSessions()
  } catch (error) {
    send(ws, {
      type: 'error',
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
  const session = registry.get(sessionId)
  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' })
    return
  }

  try {
    sessionManager.renameWindow(session.tmuxWindow, newName)
    await refreshSessions()
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
