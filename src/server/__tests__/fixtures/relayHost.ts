/** A separately scheduled dashboard for real relay contention tests. */
import { TerminalRelayClient } from '../../relay/client'
import type { Session } from '../../../shared/types'

const sessions: Session[] = JSON.parse(process.env.RELAY_TEST_SESSIONS!)
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/block') {
    setTimeout(() => { const end = performance.now() + 600; while (performance.now() < end) {} }, 30)
  }
  return Response.json({ dashboard: true })
} })
const relay = new TerminalRelayClient({
  port: 0, hostname: '127.0.0.1', upstreamPort: upstream.port!, tlsCert: '', tlsKey: '', terminalColorsEnabled: true,
}, sessions, message => {
  if (message.type === 'listening') console.log(JSON.stringify({ port: message.port }))
  if (message.type === 'fatal') { console.error(message.error); process.exit(1) }
  if (message.type === 'open') relay.post({ type: 'send', id: message.id, payload: JSON.stringify({ type: 'sessions', sessions }) })
})
process.on('SIGTERM', () => { void relay.shutdown().finally(() => { upstream.stop(true); process.exit(0) }) })
