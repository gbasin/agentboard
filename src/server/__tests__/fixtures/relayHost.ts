/** A separately scheduled dashboard for real relay contention tests. */
import { existsSync, writeFileSync } from 'node:fs'
import { TerminalRelayClient } from '../../relay/client'
import type { Session } from '../../../shared/types'
import { CATALOG_VERSION } from '../../../shared/catalogProtocol'
import { startCatalogUpgradeNotice } from '../../catalogUpgrade'
const notices = new Map<string, () => void>()

const sessions: Session[] = JSON.parse(process.env.RELAY_TEST_SESSIONS!)
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/block') {
    setTimeout(() => {
      const gate = process.env.RELAY_TEST_BLOCK!
      writeFileSync(`${gate}.entered`, '')
      while (existsSync(gate)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }, 0)
  }
  return Response.json({ dashboard: true })
} })
const relay = new TerminalRelayClient({
  port: 0, hostname: '127.0.0.1', upstreamPort: upstream.port!, tlsCert: '', tlsKey: '', terminalColorsEnabled: true, allowedOrigins: [],
}, sessions, message => {
  if (message.type === 'listening') console.log(JSON.stringify({ port: message.port }))
  if (message.type === 'fatal') { console.error(message.error); process.exit(1) }
  if (message.type === 'open') {
    const send = (payload: string) => relay.post({ type: 'send', id: message.id, payload })
    if (message.catalogVersion === CATALOG_VERSION) send(JSON.stringify({ type: 'sessions', sessions }))
    else notices.set(message.id, startCatalogUpgradeNotice({ send }))
  }
  if (message.type === 'close') { notices.get(message.id)?.(); notices.delete(message.id) }
})
process.on('SIGTERM', () => { for (const stop of notices.values()) stop(); void relay.shutdown().finally(() => { upstream.stop(true); process.exit(0) }) })
