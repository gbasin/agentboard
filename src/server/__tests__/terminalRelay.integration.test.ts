import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ClientMessage, ServerMessage, Session } from '../../shared/types'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type Frame = ServerMessage
class Peer {
  readonly ws: WebSocket
  frames: Frame[] = []
  token = ''
  closed = false
  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.onmessage = event => { const frame = JSON.parse(String(event.data)); this.frames.push(frame); if (frame.type === 'terminal-lease') this.token = frame.token }
    this.ws.onclose = () => { this.closed = true }
  }
  async receive<T extends Frame['type']>(type: T, timeout = 5000): Promise<Extract<Frame, { type: T }>> {
    const end = performance.now() + timeout
    while (performance.now() < end) {
      const index = this.frames.findIndex(frame => frame.type === type)
      if (index >= 0) return this.frames.splice(index, 1)[0] as Extract<Frame, { type: T }>
      await wait(5)
    }
    throw new Error(`Timed out waiting for ${type}; closed=${this.closed}; frames=${JSON.stringify(this.frames)}`)
  }
  send(message: ClientMessage) { this.ws.send(JSON.stringify(message)) }
  async attach(session: Session, attachId: number) {
    this.send({ type: 'terminal-attach', sessionId: session.id, tmuxTarget: session.tmuxWindow, cols: 80, rows: 24, attachId })
    const frame = await this.receive('terminal-ready')
    expect(frame.attachId).toBe(attachId)
  }
  async echo(session: Session, attachId: number) {
    const marker = `relay_${crypto.randomUUID()}`
    const start = performance.now()
    this.send({ type: 'terminal-input', sessionId: session.id, attachId, data: `${marker}\r` })
    let output = ''
    while (!output.includes(marker)) {
      const frame = await this.receive('terminal-output')
      output += frame.data
      if (frame.outputSeq) this.send({ type: 'terminal-ack', outputSeq: frame.outputSeq })
    }
    return performance.now() - start
  }
}

describe('isolated terminal relay with real tmux', () => {
  let dir: string, url: string, child: ReturnType<typeof Bun.spawn>, sessions: Session[], env: Record<string, string>
  const peers: Peer[] = []
  function tmux(...args: string[]) {
    const result = Bun.spawnSync(['tmux', ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  async function connect(token?: string, claim = 1) {
    const peer = new Peer(url); peers.push(peer)
    await peer.receive('sessions')
    peer.send({ type: 'terminal-resume', token, claim })
    await peer.receive('terminal-lease')
    return peer
  }
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ab-relay-'))
    env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.TMUX; delete env.TMUX_PANE
    Object.assign(env, { TMUX_TMPDIR: dir, TMUX_SESSION: 'relay-test', AGENTBOARD_DATA_DIR: dir, LOG_FILE: path.join(dir, 'relay.log'), LOG_LEVEL: 'error', NODE_ENV: 'production', AGENTBOARD_TMUX_SET_CLIPBOARD: '0', AGENTBOARD_RELAY_GRACE_MS: '500', AGENTBOARD_RELAY_PROGRESS_MS: '2000' })
    const a = tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'relay-test', '-P', '-F', '#{window_id}', 'stty -echo; exec /bin/cat')
    const b = tmux('new-window', '-t', 'relay-test', '-P', '-F', '#{window_id}', 'stty -echo; exec /bin/cat')
    sessions = [a, b].map((window, i) => ({ id: `relay-test:${window}`, tmuxWindow: `relay-test:${window}`, name: `Target ${i}`, projectPath: dir, status: 'unknown', lastActivity: new Date().toISOString(), createdAt: new Date().toISOString(), source: 'managed' }))
    const bin = path.join(dir, 'bin'); mkdirSync(bin)
    const realTmux = Bun.spawnSync(['which', 'tmux'], { env, stdout: 'pipe' }).stdout.toString().trim()
    writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\ncase "$*" in *new-session*) if [ -f "$RELAY_TEST_SLOW_START" ]; then sleep 0.6; fi;; esac\nexec '${realTmux.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 })
    const childEnv = { ...env, PATH: `${bin}:${env.PATH}`, RELAY_TEST_SLOW_START: path.join(dir, 'slow'), RELAY_TEST_SESSIONS: JSON.stringify(sessions) }
    child = Bun.spawn([process.execPath, 'src/server/__tests__/fixtures/relayHost.ts'], { env: childEnv, stdout: 'pipe', stderr: Bun.file(path.join(dir, 'child.err')) })
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader(); let text = ''
    while (!url) {
      const part = await reader.read()
      if (part.done) throw new Error('Relay fixture exited')
      text += new TextDecoder().decode(part.value)
      const line = text.split('\n').find(line => line.startsWith('{"port":'))
      if (line) url = `ws://127.0.0.1:${JSON.parse(line).port}/ws`
    }
  }, 15000)
  afterAll(async () => {
    for (const peer of peers) peer.ws.close()
    if (child) { child.kill(); expect(await child.exited).toBe(0); expect(child.signalCode).toBeNull() }
    if (env) {
      try { for (const session of tmux('list-sessions', '-F', '#{session_name}').split('\n')) tmux('kill-session', '-t', `=${session}`) } catch {}
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('dashboard stall does not block ping or PTY echo', async () => {
    const peer = await connect(); await peer.attach(sessions[0], 1)
    await fetch(url.replace('ws:', 'http:').replace('/ws', '/block'))
    await wait(90)
    const start = performance.now()
    peer.send({ type: 'ping', seq: 7 }); expect((await peer.receive('pong')).seq).toBe(7)
    expect(performance.now() - start).toBeLessThan(350)
    expect(await peer.echo(sessions[0], 1)).toBeLessThan(350)
    await wait(650); peer.ws.close()
  })

  test('slow new tmux observer cannot stall a different terminal', async () => {
    const first = await connect(); await first.attach(sessions[0], 1)
    const second = await connect()
    writeFileSync(path.join(dir, 'slow'), '')
    try {
      second.send({ type: 'terminal-attach', sessionId: sessions[1].id, attachId: 1, cols: 80, rows: 24 })
      await wait(80)
      expect(await first.echo(sessions[0], 1)).toBeLessThan(350)
      await second.receive('terminal-ready')
    } finally { unlinkSync(path.join(dir, 'slow')); first.ws.close(); second.ws.close() }
  })

  test('resume retains observer, revalidates target, and fences old attach IDs', async () => {
    const first = await connect(); await first.attach(sessions[0], 1)
    const before = tmux('list-clients', '-F', '#{client_tty}').split('\n').sort()
    const second = await connect(first.token, 2); await second.attach(sessions[1], 2)
    expect(second.token).toBe(first.token)
    expect(tmux('list-clients', '-F', '#{client_tty}').split('\n').sort()).toEqual(before)
    second.send({ type: 'terminal-input', sessionId: sessions[1].id, attachId: 1, data: 'FORBIDDEN_STALE\r' })
    await second.echo(sessions[1], 2)
    expect(tmux('capture-pane', '-p', '-t', sessions[1].tmuxWindow)).not.toContain('FORBIDDEN_STALE')
    second.ws.close()
  })

  test('legacy clients and repeated disposal reuse preserve live agent panes', async () => {
    await wait(1100)
    for (let cycle = 0; cycle < 8; cycle++) {
      const peer = new Peer(url); peers.push(peer)
      await peer.receive('sessions')
      peer.send({ type: 'terminal-attach', sessionId: sessions[0].id, cols: 80, rows: 24 })
      const ready = await peer.receive('terminal-ready')
      expect(ready.attachId).toBeUndefined()
      peer.send({ type: 'terminal-input', sessionId: sessions[0].id, data: `legacy_${cycle}\r` })
      await wait(50)
      expect(tmux('capture-pane', '-p', '-t', sessions[0].tmuxWindow)).toContain(`legacy_${cycle}`)
      peer.ws.close()
      await wait(100)
    }
    expect(tmux('list-sessions', '-F', '#{session_name}')).toBe('relay-test')
  }, 15000)

  test('server reclaims silent OPEN and disconnected leases without killing agents', async () => {
    const first = await connect(); await first.attach(sessions[0], 1)
    await wait(2600)
    expect(first.closed).toBe(true)
    expect(tmux('list-windows', '-t', 'relay-test')).toContain('cat')
    const second = await connect(first.token, 2); await second.attach(sessions[0], 2)
    expect(second.token).not.toBe(first.token)
    second.ws.close(); await wait(1100)
    expect(tmux('list-sessions', '-F', '#{session_name}')).toBe('relay-test')
  }, 10000)
})
