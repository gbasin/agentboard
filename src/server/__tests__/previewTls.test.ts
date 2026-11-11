/** Real TLS sockets: renewal keeps origin/capability and active WebSockets. */
import { test, expect } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { createHash } from 'node:crypto'
import { outputRoutes } from '../outputs/routes'
import type { AgentSessionRecord } from '../db'
import { PreviewServers } from '../outputs/previewServers'
import { validateCertificate } from '../outputs/certificates'
import { previewCertificate } from './fixtures/previewCertificate'

const fingerprint = (port: number, ca: string[]) => new Promise<string>((resolve, reject) => {
  const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca }, () => {
    resolve(socket.getPeerCertificate().fingerprint256); socket.destroy()
  })
  socket.on('error', reject)
})

test('HTTPS renewal rebinds the same port, preserves sockets and blocks capability-free access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-preview-tls-'))
  const files = [previewCertificate(root, 'first'), previewCertificate(root, 'second')]
  const certificates = await Promise.all(files.map(async f => validateCertificate(await fs.readFile(f.cert, 'utf8'), await fs.readFile(f.key, 'utf8'), 'localhost')))
  let selected = 0, fail = false, errors = 0
  const previews = new PreviewServers({ hostname: '127.0.0.1', idleMs: 1, getCertificate: async () => { if (fail) throw Error('temporarily unavailable'); return certificates[selected] }, onTlsError: () => errors++ })
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) {
    if (req.headers.get('upgrade') === 'websocket' && server.upgrade(req)) return
    return new Response('preview content')
  }, websocket: { message(ws, message) { ws.send(message) } } })
  let socket: WebSocket | undefined
  try {
    const target = { kind: 'localhost' as const, url: `http://127.0.0.1:${upstream.port}/` }
    const board = new URL('https://localhost:4040')
    const url = await previews.open(target, board), port = Number(new URL(url).port)
    expect(url.startsWith('https:')).toBe(true)
    expect(await fingerprint(port, certificates.map(c => c.cert))).toBe(certificates[0].fingerprint)
    const options = { tls: { ca: certificates.map(c => c.cert) }, redirect: 'manual' as const }
    const response = await fetch(url, options)
    expect(response.status).toBe(302)
    expect(response.headers.get('set-cookie')).toContain('; Secure')
    const cookie = response.headers.get('set-cookie')!.split(';')[0]
    const entry = new URL('/', url).href
    expect((await fetch(entry, options)).status).toBe(403)
    const Socket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket }
    socket = new Socket(entry.replace('https:', 'wss:'), { headers: { cookie }, tls: { ca: certificates.map(c => c.cert) } })
    const send = (text: string) => new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('WebSocket timed out')), 3000)
      socket!.onmessage = e => { clearTimeout(timeout); resolve(String(e.data)) }
      socket!.send(text)
    })
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(Error('TLS websocket failed')) })
    expect(await send('before')).toBe('before')
    fail = true; await previews.refreshCertificates(); expect(errors).toBe(1)
    expect(await fingerprint(port, certificates.map(c => c.cert))).toBe(certificates[0].fingerprint)
    fail = false; selected = 1
    await previews.refreshCertificates()
    await Bun.sleep(5) // Draining sockets must also prevent idle reaping.
    expect(await previews.open(target, board)).toBe(url)
    expect(await fingerprint(port, certificates.map(c => c.cert))).toBe(certificates[1].fingerprint)
    expect(await send('after')).toBe('after')
    expect(await (await fetch(entry, { ...options, headers: { cookie }, keepalive: false })).text()).toBe('preview content')
    expect(previews.isPreviewOrigin(new URL(url).origin)).toBe(true)
    const plain = await previews.open(target, new URL('http://localhost:4040'))
    expect(plain.startsWith('http:')).toBe(true)
    expect(new URL(plain).port).not.toBe(String(port))
  } finally { socket?.close(); previews.dispose(); upstream.stop(true); await fs.rm(root, { recursive: true, force: true }) }
}, 15_000)


test('proxy HTTPS header and browser protocol select TLS; missing TLS fails explicitly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-preview-route-tls-'))
  const files = previewCertificate(root, 'cert')
  const cert = validateCertificate(await fs.readFile(files.cert, 'utf8'), await fs.readFile(files.key, 'utf8'), 'localhost')
  const previews = new PreviewServers({ hostname: '127.0.0.1', getCertificate: async () => cert })
  const missing = new PreviewServers({ hostname: '127.0.0.1' })
  try {
    const report = path.join(root, 'index.html'), log = path.join(root, 'session.jsonl')
    await fs.writeFile(report, '<h1>HTTPS</h1>')
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `[Report](${report})` }] } })
    await fs.writeFile(log, line + '\n')
    const record = { sessionId: 'fixture', agentType: 'claude', projectPath: root, logFilePath: log } as AgentSessionRecord
    const options = { getSession: () => record, blockedPorts: () => [], cacheRoot: root, ready: async () => {} }
    const query = new URLSearchParams({ path: log, offset: '0', index: '0', digest: createHash('sha256').update(line).digest('hex'), format: 'json' })
    const app = outputRoutes({ ...options, previews })
    const url = 'http://localhost/fixture/open?' + query
    for (const response of [await app.request(url + '&protocol=https%3A'), await app.request(url, { headers: { 'X-Forwarded-Proto': 'https' } })]) {
      expect(response.status).toBe(200)
      expect((await response.json()).url).toStartWith('https://')
    }
    const failure = await outputRoutes({ ...options, previews: missing }).request(url + '&protocol=https%3A')
    expect(failure.status).toBe(503)
    expect((await failure.json()).error).toContain('HTTPS previews need')
  } finally { previews.dispose(); missing.dispose(); await fs.rm(root, { recursive: true, force: true }) }
})
