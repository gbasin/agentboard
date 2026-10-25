/// <reference lib="webworker" />
/** Public listener: terminal traffic never enters the dashboard event loop. */
import type { Server, ServerWebSocket } from 'bun'
import type { ClientMessage } from '../shared/types'
import { TerminalLeases, type RelaySocketData } from './relay/leases'
import type { ParentToRelay, RelayOptions, RelayToParent } from './relay/protocol'
import { logger } from './logger'

const ctx = self as DedicatedWorkerGlobalScope
const sockets = new Map<string, ServerWebSocket<RelaySocketData>>()
const servers: Server<RelaySocketData>[] = []
const post = (message: RelayToParent) => ctx.postMessage(message)
const leases = new TerminalLeases(message => post(message))
let options: RelayOptions

function bind(hostname: string) {
  try {
    const server = Bun.serve<RelaySocketData>({
      hostname, port: options.port,
      ...(options.tlsCert && options.tlsKey ? { tls: { cert: Bun.file(options.tlsCert), key: Bun.file(options.tlsKey) } } : {}),
      async fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === '/ws') {
          const id = crypto.randomUUID()
          if (server.upgrade(req, { data: { id, lease: null, outputSerial: 0, outstanding: new Map(), outstandingBytes: 0 } })) {
            post({ type: 'open', id, remoteAddress: server.requestIP(req)?.address ?? null, userAgent: req.headers.get('user-agent')?.slice(0, 200) ?? null })
            return
          }
          return new Response('WebSocket upgrade failed', { status: 400 })
        }
        // HTTP may wait on dashboard work; terminal I/O uses neither this fetch nor its loop.
        const upstream = new URL(url.pathname + url.search, `http://127.0.0.1:${options.upstreamPort}`)
        try {
          return await fetch(new Request(upstream, req), { redirect: 'manual' })
        } catch {
          return new Response('Dashboard temporarily unavailable', { status: 503 })
        }
      },
      websocket: {
        idleTimeout: 40, sendPings: true, perMessageDeflate: true,
        open(ws) { sockets.set(ws.data.id, ws) },
        message(ws, raw) {
          const payload = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
          let message: ClientMessage
          try { message = JSON.parse(payload) } catch { leases.send(ws, JSON.stringify({ type: 'error', message: 'Invalid message payload' })); return }
          if (!message || typeof message !== 'object' || typeof message.type !== 'string') return
          leases.progress(ws)
          if (message.type === 'ping') {
            const bufferedBefore = ws.getBufferedAmount()
            const accepted = leases.send(ws, JSON.stringify({ type: 'pong', ...(message.seq !== undefined ? { seq: message.seq } : {}) }))
            logger.debug('terminal_relay_heartbeat', { connectionId: ws.data.id, seq: message.seq, accepted,
              bufferedBefore, bufferedAfter: ws.getBufferedAmount() })
          } else if (!leases.handle(ws, message)) post({ type: 'message', id: ws.data.id, payload })
        },
        close(ws) {
          leases.close(ws)
          sockets.delete(ws.data.id)
          post({ type: 'close', id: ws.data.id })
        },
      },
    })
    servers.push(server)
    post({ type: 'listening', hostname, port: server.port ?? options.port })
  } catch (error) {
    post({ type: 'bind-error', hostname, error: String(error) })
  }
}

ctx.onmessage = async (event: MessageEvent<ParentToRelay>) => {
  const message = event.data
  switch (message.type) {
    case 'init':
      options = message.options
      leases.update(message.sessions, options.terminalColorsEnabled)
      bind(options.hostname)
      return
    case 'bind': bind(message.hostname); return
    case 'sessions': leases.update(message.sessions, message.terminalColorsEnabled); return
    case 'send': {
      const socket = sockets.get(message.id)
      if (socket) leases.send(socket, message.payload)
      return
    }
    case 'shutdown':
      for (const server of servers) server.stop(true)
      await leases.shutdown()
      post({ type: 'stopped' })
      // The parent exits after this acknowledgement. Closing nested Bun PTY
      // worker realms can SIGTRAP; dispose resources, then let process exit own realms.
  }
}
