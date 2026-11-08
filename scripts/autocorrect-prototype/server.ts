/** Isolated keyboard experiment. Records native events; never connects to user sessions. */
import { join } from 'node:path'
const root = import.meta.dir
const bundle = await Bun.build({ entrypoints: [join(root, 'client.ts')], target: 'browser' })
if (!bundle.success) throw new Error('Prototype client build failed')
const events: unknown[] = []
const peers = new Map<Bun.ServerWebSocket<undefined>, Bun.Subprocess>()
const server = Bun.serve<undefined>({ port: 18497, hostname: process.env.PROBE_HOST ?? '127.0.0.1', async fetch(req, server) {
  if (new URL(req.url).pathname === '/pty') {
    if (server.upgrade(req)) return
    return new Response('Upgrade required', {status:400})
  }
  const url = new URL(req.url)
  if (url.pathname === '/events' && req.method === 'POST') {
    events.push(await req.json()); if (events.length > 10000) events.shift(); return new Response('ok')
  }
  if (url.pathname === '/events') return Response.json(events)
  if (url.pathname === '/client.js') return new Response(bundle.outputs[0], {headers: {'Content-Type':'application/javascript'}})
  if (url.pathname === '/xterm.css') return new Response(Bun.file(join(root, '../../node_modules/@xterm/xterm/css/xterm.css')))
  return new Response(Bun.file(join(root, 'index.html')))
}, websocket: {
  open(ws) {
    const pty = Bun.spawn(['/usr/bin/python3', '-c', 'import readline\nwhile True:\n s=input("prompt> "); print("RECEIVED: "+repr(s))'], {
      env:{...process.env, TMUX:undefined, TERM:'xterm-256color'},
      terminal: {cols:36, rows:5, data(_terminal, data) {ws.send(data)}}
    })
    peers.set(ws, pty)
  },
  message(ws, data) {peers.get(ws)?.terminal?.write(String(data))},
  close(ws) {peers.get(ws)?.kill(); peers.get(ws)?.terminal?.close(); peers.delete(ws)}
}})
console.log('Keyboard experiment: http://localhost:18497')

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  for (const child of peers.values()) { child.kill(); child.terminal?.close() }
  void server.stop(true)
  process.exit(0)
})
