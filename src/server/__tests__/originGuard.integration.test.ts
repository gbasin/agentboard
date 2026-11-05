/**
 * Real-server origin guard: WebSocket handshakes and /api mutations from a
 * foreign Origin get 403 on both the terminal relay listener (whose HTTP is
 * proxied to the loopback dashboard) and the direct, non-relay listener.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  canBindLocalhost,
  createTmuxTmpDir,
  isTmuxAvailable,
  privateTmuxEnv,
  privateTmuxSocket,
} from './testEnvironment'

const host = '127.0.0.1'
const runnable = isTmuxAvailable() && canBindLocalhost()

/** Sends a raw WebSocket handshake and returns the HTTP status code. */
function handshake(port: number, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('handshake timed out')) }, 5000)
    socket.on('connect', () => {
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

for (const relay of [true, false]) {
  const label = relay ? 'terminal relay listener' : 'direct listener'
  if (!runnable) { test.skip(`${label}: tmux or localhost sockets unavailable`, () => {}); continue }

  describe(`origin guard on the ${label}`, () => {
    let tmuxTmpDir = ''
    let port = 0
    let child: ReturnType<typeof Bun.spawn> | null = null
    const sessionName = `ab-origin-${relay ? 'relay' : 'direct'}-${process.pid}`

    beforeAll(async () => {
      tmuxTmpDir = createTmuxTmpDir('ab-origin-')
      port = await freePort()
      const dataDir = path.join(tmuxTmpDir, 'data')
      child = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...privateTmuxEnv(tmuxTmpDir),
          PORT: String(port), HOSTNAME: host, TMUX_SESSION: sessionName, DISCOVER_PREFIXES: '',
          AGENTBOARD_DATA_DIR: dataDir, AGENTBOARD_DB_PATH: path.join(dataDir, 'agentboard.db'),
          LOG_FILE: path.join(tmuxTmpDir, 'server.log'), LOG_LEVEL: 'error', AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_TERMINAL_RELAY: relay ? '1' : '0',
          AGENTBOARD_ALLOWED_ORIGINS: ' https://board.example.com/ ',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      drain(child.stdout); drain(child.stderr)
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        try { if ((await fetch(`http://${host}:${port}/api/health`)).ok) return } catch { /* retry */ }
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
      expect(await handshake(port, 'http://evil.example')).toBe(403)
      expect(await handshake(port, 'null')).toBe(403)
      expect(await handshake(port, `http://localhost:${port}`)).toBe(403)
      expect(await handshake(port, `http://${host}:${port}`)).toBe(101)
      expect(await handshake(port, 'https://board.example.com')).toBe(101)
      expect(await handshake(port)).toBe(101)
    })

    test('/api mutation: cross-origin PUT gets 403; same-origin and no-Origin PUT succeed', async () => {
      const put = (origin?: string) => fetch(`http://${host}:${port}/api/settings/prefer-window-name`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ enabled: false }),
      })
      const rejected = await put('http://evil.example')
      expect(rejected.status).toBe(403)
      expect(await rejected.json()).toEqual({ error: 'Cross-origin request rejected' })
      // Through the relay this also guards the shared upstream keep-alive
      // connection: an undrained rejected body turned this next PUT into a 400.
      expect((await put(`http://${host}:${port}`)).status).toBe(200)
      expect((await put()).status).toBe(200)
      const post = await fetch(`http://${host}:${port}/api/paste-image`, {
        method: 'POST', headers: { origin: 'http://evil.example' }, body: new FormData(),
      })
      expect(post.status).toBe(403)
    })
  })
}
