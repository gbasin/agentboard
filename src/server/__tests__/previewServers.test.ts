import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PreviewServers } from '../outputs/previewServers'
import { upstreamHeaders } from '../outputs/liveProxy'

const managers: PreviewServers[] = []
const dirs: string[] = []
afterEach(async () => { managers.splice(0).forEach(m => m.dispose()); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
const manager = () => { const m = new PreviewServers({ hostname: '127.0.0.1' }); managers.push(m); return m }
async function authorize(url: string) {
  const res = await fetch(url, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]
  const entry = new URL(res.headers.get('location')!, url).href
  return { cookie, entry }
}

describe('isolated preview origins', () => {
  test('serves HTML and assets with capabilities; blocks hidden files and symlink escapes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-output-')); dirs.push(dir)
    await fs.mkdir(path.join(dir, 'report'))
    await fs.writeFile(path.join(dir, 'report/index.html'), '<h1>Hello</h1>')
    await fs.writeFile(path.join(dir, 'report/style.css'), 'h1 { color: red }')
    await fs.writeFile(path.join(dir, 'secret.json'), '{"private":true}')
    await fs.writeFile(path.join(dir, 'report/.env'), 'SECRET=x')
    await fs.symlink(path.join(dir, 'secret.json'), path.join(dir, 'report/escape.json'))
    const m = manager()
    const url = await m.open({ kind: 'html', file: path.join(dir, 'report/index.html') }, new URL('http://127.0.0.1:4040'))
    expect(new URL(url).port).not.toBe('4040')
    expect(m.isPreviewOrigin(new URL(url).origin)).toBe(true)
    expect(m.isPreviewOrigin('null')).toBe(true)
    const { cookie, entry } = await authorize(url)
    expect((await fetch(entry)).status).toBe(403)
    expect((await fetch(url.replace(/token=.*/, 'token=invalid'))).status).toBe(403)
    expect((await fetch(entry, { headers: { cookie, Origin: 'http://127.0.0.1:49999' } })).status).toBe(403)
    expect(await (await fetch(entry, { headers: { cookie } })).text()).toBe('<h1>Hello</h1>')
    expect((await fetch(new URL('/style.css', entry), { headers: { cookie } })).status).toBe(200)
    for (const route of ['/escape.json', '/.env', '/secret.json']) expect((await fetch(new URL(route, entry), { headers: { cookie } })).status).toBeGreaterThanOrEqual(400)
    await fs.unlink(path.join(dir, 'report/index.html'))
    expect((await fetch(entry, { headers: { cookie } })).status).toBe(404)
  })
  test('proxies root assets, API POSTs, redirects, and WebSocket messages', async () => {
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/socket') { if (server.upgrade(req)) return; return new Response('no', { status: 400 }) }
      if (url.pathname === '/redirect') return Response.redirect(new URL('/api', req.url))
      if (url.pathname === '/api') return new Response(req.method === 'POST' ? req.body : 'ok')
      return new Response('asset')
    }, websocket: { message(ws, msg) { ws.send(msg) } } })
    try {
      const m = manager()
      const url = await m.open({ kind: 'localhost', url: `http://127.0.0.1:${upstream.port}/` }, new URL('http://127.0.0.1:4040'))
      const { cookie, entry } = await authorize(url)
      expect(await (await fetch(new URL('/api', entry), { method: 'POST', headers: { cookie }, body: 'posted' })).text()).toBe('posted')
      const redirect = await fetch(new URL('/redirect', entry), { headers: { cookie }, redirect: 'manual' })
      expect(redirect.headers.get('location')).toBe(new URL('/api', entry).href)
      const Socket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket }
      const socket = new Socket(new URL('/socket', entry).href.replace('http:', 'ws:'), { headers: { cookie } })
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 3000)
        socket.onopen = () => socket.send('hello')
        socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')) }
        socket.onmessage = e => { clearTimeout(timer); resolve(String(e.data)); socket.close() }
      })
      expect(reply).toBe('hello')
      upstream.stop(true)
      expect((await fetch(entry, { headers: { cookie } })).status).toBe(502)
    } finally { upstream.stop(true) }
  })
  test('preserves app authorization without forwarding preview capabilities', () => {
    const headers = upstreamHeaders(new Headers({ authorization: 'secret', cookie: 'ab_preview_123=secret; app=value', origin: 'http://viewer:5555' }), new URL('http://localhost:3000'))
    expect(headers.get('authorization')).toBe('secret')
    expect(headers.get('cookie')).toBe('app=value')
    expect(headers.get('origin')).toBe('http://localhost:3000')
  })
})
