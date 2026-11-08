/** Real TCP forwarding + real server; only Tailscale discovery is substituted.
 * IPv6 loopback stands in for the tailnet interface, so CI needs no tailnet or
 * privileged interface aliases. No listener is exposed beyond this machine.
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const root = process.env.E2E_TMUX_TMPDIR
if (!root || process.env.TMUX || !process.env.E2E_TMUX_SESSION) throw Error('Private E2E environment required')
const port = Number(process.env.PORT)
const bin = path.join(root, 'bin')
fs.mkdirSync(bin, { recursive: true })
const sockets = new Set<net.Socket>()
const forwarder = net.createServer(client => {
  const upstream = net.connect({ host: '127.0.0.1', port })
  for (const socket of [client, upstream]) {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => { client.destroy(); upstream.destroy() })
  }
  client.pipe(upstream).pipe(client)
})
// Install the forwarder when startup performs discovery, after its broad
// port-in-use preflight but before it attempts the secondary listener.
const discovery = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
  if (!forwarder.listening) await new Promise<void>((resolve, reject) => {
    forwarder.once('error', reject)
    forwarder.listen({ host: '::1', port, ipv6Only: true }, resolve)
  })
  return new Response('::1')
} })
fs.writeFileSync(path.join(bin, 'tailscale'), `#!/usr/bin/env bun
console.log(await (await fetch('http://127.0.0.1:${discovery.port}/')).text())
`, { mode: 0o755 })
const child = Bun.spawn(['bun', 'src/server/index.ts'], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOSTNAME: '127.0.0.1',
    TMUX_SESSION: process.env.E2E_TMUX_SESSION, AGENTBOARD_STATIC_DIR: 'dist/client',
    AGENTBOARD_LOG_WATCH_MODE: 'poll', AGENTBOARD_TERMINAL_RELAY: '1',
    LANG: 'C', LC_ALL: 'C' },
  stdout: 'inherit', stderr: 'inherit',
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
const code = await child.exited
for (const socket of sockets) socket.destroy()
forwarder.close()
discovery.stop(true)
process.exit(code)
