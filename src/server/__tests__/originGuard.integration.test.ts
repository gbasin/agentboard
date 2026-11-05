/**
 * Real-server origin guard: WebSocket handshakes and /api mutations from a
 * foreign Origin get 403 on both the terminal relay listener (whose HTTP is
 * proxied to the loopback dashboard) and the direct, non-relay listener.
 * Each listener also runs with TLS_CERT/TLS_KEY, where an http Origin on the
 * server's own host and port must be rejected too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import {
  canBindLocalhost,
  createTmuxTmpDir,
  isTmuxAvailable,
  privateTmuxEnv,
  privateTmuxSocket,
} from './testEnvironment'

const host = '127.0.0.1'
const runnable = isTmuxAvailable() && canBindLocalhost()
const hasOpenssl = Bun.spawnSync(['openssl', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0

/** Writes a throwaway self-signed certificate; clients here do not verify it. */
function writeSelfSignedCert(dir: string): { cert: string; key: string } {
  const cert = path.join(dir, 'cert.pem')
  const key = path.join(dir, 'key.pem')
  const result = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', `/CN=${host}`, '-keyout', key, '-out', cert], { stdout: 'ignore', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`)
  return { cert, key }
}

/** Sends a raw WebSocket handshake and returns the HTTP status code. */
function handshake(port: number, secure: boolean, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket: net.Socket = secure ? tls.connect({ port, host, rejectUnauthorized: false }) : net.connect(port, host)
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('handshake timed out')) }, 5000)
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      socket.write([
        'GET /ws?catalog=2 HTTP/1.1', `Host: ${host}:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(origin ? [`Origin: ${origin}`] : []), '', '',
      ].join('\r\n'))
    })
    socket.on('data', chunk => {
      buffer += chunk.toString()
      const match = /^HTTP\/1\.1 (\d{3})/.exec(buffer)
      if (match) { clearTimeout(timer); socket.destroy(); resolve(Number(match[1])) }
    })
    socket.on('error', error => { clearTimeout(timer); reject(error) })
  })
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ port: 0, host }, () => {
      const address = server.address()
      server.close(() => address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port')))
    })
  })
}

function drain(stream: ReadableStream<Uint8Array> | number | null | undefined) {
  if (!stream || typeof stream === 'number') return
  const reader = stream.getReader()
  void (async () => { while (!(await reader.read()).done) { /* discard */ } })()
}

for (const { relay, secure } of [
  { relay: true, secure: false }, { relay: false, secure: false },
  { relay: true, secure: true }, { relay: false, secure: true },
]) {
  const label = `${relay ? 'terminal relay listener' : 'direct listener'}${secure ? ' serving TLS' : ''}`
  if (!runnable) { test.skip(`${label}: tmux or localhost sockets unavailable`, () => {}); continue }
  if (secure && !hasOpenssl) { test.skip(`${label}: openssl unavailable to make a test certificate`, () => {}); continue }

  describe(`origin guard on the ${label}`, () => {
    let tmuxTmpDir = ''
    let port = 0
    let child: ReturnType<typeof Bun.spawn> | null = null
    const sessionName = `ab-origin-${relay ? 'relay' : 'direct'}${secure ? '-tls' : ''}-${process.pid}`
    const scheme = secure ? 'https' : 'http'
    /** The board's own origin, and the same host and port under the other scheme. */
    const ownOrigin = () => `${scheme}://${host}:${port}`
    const otherSchemeOrigin = () => `${secure ? 'http' : 'https'}://${host}:${port}`
    const request = (pathname: string, init: RequestInit = {}) =>
      fetch(`${ownOrigin()}${pathname}`, { ...init, tls: { rejectUnauthorized: false } })

    beforeAll(async () => {
      tmuxTmpDir = createTmuxTmpDir('ab-origin-')
      port = await freePort()
      const dataDir = path.join(tmuxTmpDir, 'data')
      const certificate = secure ? writeSelfSignedCert(tmuxTmpDir) : null
      child = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...privateTmuxEnv(tmuxTmpDir),
          PORT: String(port), HOSTNAME: host, TMUX_SESSION: sessionName, DISCOVER_PREFIXES: '',
          AGENTBOARD_DATA_DIR: dataDir, AGENTBOARD_DB_PATH: path.join(dataDir, 'agentboard.db'),
          LOG_FILE: path.join(tmuxTmpDir, 'server.log'), LOG_LEVEL: 'error', AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_TERMINAL_RELAY: relay ? '1' : '0',
          AGENTBOARD_ALLOWED_ORIGINS: ' https://board.example.com/ ',
          ...(certificate ? { TLS_CERT: certificate.cert, TLS_KEY: certificate.key } : {}),
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      drain(child.stdout); drain(child.stderr)
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        try { if ((await request('/api/health')).ok) return } catch { /* retry */ }
        await Bun.sleep(150)
      }
      throw new Error('server did not become healthy')
    }, 70000)

    afterAll(async () => {
      if (child) { child.kill(); await child.exited }
      if (tmuxTmpDir) {
        // -S pins the private socket: it can never reach the live tmux server.
        Bun.spawnSync(['tmux', '-S', privateTmuxSocket(tmuxTmpDir), 'kill-server'],
          { stdout: 'ignore', stderr: 'ignore', env: privateTmuxEnv(tmuxTmpDir) })
        fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
      }
    })

    test('WebSocket handshake: foreign Origin rejected; same, allowlisted, or no Origin accepted', async () => {
      expect(await handshake(port, secure, `${scheme}://evil.example`)).toBe(403)
      expect(await handshake(port, secure, 'null')).toBe(403)
      expect(await handshake(port, secure, `${scheme}://localhost:${port}`)).toBe(403)
      expect(await handshake(port, secure, ownOrigin())).toBe(101)
      expect(await handshake(port, secure, 'https://board.example.com')).toBe(101)
      expect(await handshake(port, secure)).toBe(101)
    })

    test(secure
      ? 'a TLS server rejects an http Origin on its own host and port'
      : 'a plain-HTTP server accepts an https Origin on its own host and port (TLS-terminating proxy)', async () => {
      const put = () => request('/api/settings/prefer-window-name', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: otherSchemeOrigin() },
        body: JSON.stringify({ enabled: false }),
      })
      expect(await handshake(port, secure, otherSchemeOrigin())).toBe(secure ? 403 : 101)
      expect((await put()).status).toBe(secure ? 403 : 200)
    })

    test('/api mutation: cross-origin PUT gets 403; same-origin and no-Origin PUT succeed', async () => {
      const put = (origin?: string) => request('/api/settings/prefer-window-name', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ enabled: false }),
      })
      const rejected = await put('http://evil.example')
      expect(rejected.status).toBe(403)
      expect(await rejected.json()).toEqual({ error: 'Cross-origin request rejected' })
      // Through the relay this also guards the shared upstream keep-alive
      // connection: an undrained rejected body turned this next PUT into a 400.
      expect((await put(ownOrigin())).status).toBe(200)
      expect((await put()).status).toBe(200)
      const post = await request('/api/paste-image', {
        method: 'POST', headers: { origin: 'http://evil.example' }, body: new FormData(),
      })
      expect(post.status).toBe(403)
    })

    test('percent-encoded and non-/api paths cannot bypass the guard', async () => {
      // The router decodes /%61pi/... to /api/...; the guard must not depend on the raw path.
      const foreignPost = (path: string) => request(path, {
        method: 'POST', headers: { origin: 'http://evil.example' }, body: new FormData(),
      })
      for (const path of ['/%61pi/paste-image', '/a%70i/paste-file', '/%61pi/client-log', '/not-an-api-path'])
        expect({ path, status: (await foreignPost(path)).status }).toEqual({ path, status: 403 })
      // The encoded route does reach the handler for a same-origin request, so
      // the 403 above comes from the guard and not from a routing miss.
      const sameOrigin = await request('/%61pi/client-log', {
        method: 'POST',
        headers: { origin: ownOrigin(), 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'info', event: 'origin_guard_probe' }),
      })
      // Exactly the handler's reply: a 500, or a 503 from the relay, must fail here.
      expect(sameOrigin.status).toBe(200)
      expect(await sameOrigin.json()).toEqual({ ok: true })
      // A rejected write must not poison the next request on the shared relay connection.
      expect((await request('/api/health')).status).toBe(200)
    })
  })
}
