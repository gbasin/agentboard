import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTmuxTmpDir, privateTmuxEnv, privateTmuxSocket } from './testEnvironment'
import { sendPaneBurst } from './fixtures/paneBurst'
import { shellQuote } from '../shellQuote'

async function until(check: () => boolean, detail = 'terminal event') {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${detail}`)
    await Bun.sleep(20)
  }
}

test('relay lease workers share pane output across close, switch and reconnect', async () => {
  const root = createTmuxTmpDir('ab-pipe-relay-')
  const socket = privateTmuxSocket(root)
  await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 })
  const env = { ...privateTmuxEnv(root), TERMINAL_MODE: 'pipe-pane', TMUX_SESSION: 'pipe-relay-test', AGENTBOARD_DATA_DIR: root,
    LOG_FILE: path.join(root, 'relay.log'), LOG_LEVEL: 'error', NODE_ENV: 'production', AGENTBOARD_TMUX_SET_CLIPBOARD: '0',
    AGENTBOARD_RELAY_GRACE_MS: '100', AGENTBOARD_RELAY_PROGRESS_MS: '90000' }
  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const clients: WebSocket[] = []
  let child: ReturnType<typeof Bun.spawn> | null = null
  const entered = path.join(root, 'stall-entered'), release = path.join(root, 'stall-release')
  try {
    const windows = [tmux(['new-session', '-d', '-s', 'pipe-relay-test', '-P', '-F', '#{window_id}', 'stty -echo; exec cat']),
      tmux(['new-window', '-d', '-t', 'pipe-relay-test', '-P', '-F', '#{window_id}', 'stty -echo; exec cat'])]
    const sessions = windows.map((window, i) => ({ id: `pipe-relay-test:${window}`, tmuxWindow: `pipe-relay-test:${window}`,
      name: `Pane ${i}`, projectPath: root, status: 'unknown', source: 'managed', createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() }))
    // Block only the subscriber that writes this marker. Its worker cannot
    // consume broker messages/credits; the other lease remains responsive.
    const bin = path.join(root, 'bin')
    await fs.mkdir(bin)
    const realTmux = Bun.which('tmux')!
    await fs.writeFile(path.join(bin, 'tmux'), `#!/bin/sh
case "$*" in *PIPE_TEST_STALL*)
  : > ${shellQuote(entered)}
  while [ ! -e ${shellQuote(release)} ]; do sleep 0.05; done;;
esac
exec '${realTmux.replaceAll("'", "'\\''")}' "$@"
`, { mode: 0o755 })
    child = Bun.spawn([process.execPath, 'src/server/__tests__/fixtures/relayHost.ts'], {
      env: { ...env, PATH: `${bin}:${process.env.PATH ?? ''}`, AGENTBOARD_TMUX_TIMEOUT_MS: '60000', RELAY_TEST_SESSIONS: JSON.stringify(sessions) }, stdout: 'pipe', stderr: Bun.file(path.join(root, 'child.err')),
    })
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    const port = JSON.parse(new TextDecoder().decode(first.value).trim()).port
    reader.releaseLock()
    const connect = async (index = 0) => {
      const frames: Array<{ type: string; data?: string; outputSeq?: number }> = []
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?catalog=2`)
      clients.push(ws)
      ws.onmessage = event => {
        const frame = JSON.parse(String(event.data)); frames.push(frame)
        if (frame.outputSeq) ws.send(JSON.stringify({ type: 'terminal-ack', outputSeq: frame.outputSeq }))
      }
      const send = (data: unknown) => ws.send(JSON.stringify(data))
      await until(() => frames.some(frame => frame.type === 'sessions'))
      send({ type: 'terminal-resume', claim: 1 })
      await until(() => frames.some(frame => frame.type === 'terminal-lease'))
      const attach = async (pane: number, attachId: number) => {
        frames.length = 0
        send({ type: 'terminal-attach', sessionId: sessions[pane].id, tmuxTarget: sessions[pane].tmuxWindow, cols: 80, rows: 24, attachId })
        await until(() => frames.some(frame => frame.type === 'terminal-ready'), JSON.stringify(frames))
      }
      await attach(index, 1)
      return { ws, frames, send, attach, output: () => frames.filter(frame => frame.type === 'terminal-output').map(frame => frame.data).join('') }
    }
    const input = (peer: Awaited<ReturnType<typeof connect>>, pane: number, attachId: number, data: string) => peer.send({ type: 'terminal-input', sessionId: sessions[pane].id, attachId, data: `${data}\n` })
    const a = await connect()
    const b = await connect()
    input(a, 0, 1, 'both-workers-output')
    await until(() => a.output().includes('both-workers-output') && b.output().includes('both-workers-output'), 'both workers receive output')
    a.ws.close()
    await Bun.sleep(350)
    input(b, 0, 1, 'survives-other-worker-close')
    await until(() => b.output().includes('survives-other-worker-close'))
    const c = await connect()
    await c.attach(1, 2)
    input(c, 1, 2, 'different-worker-pane')
    input(b, 0, 1, 'survives-other-worker-switch')
    await until(() => c.output().includes('different-worker-pane') && b.output().includes('survives-other-worker-switch'))
    expect(tmux(['display-message', '-t', sessions[0].tmuxWindow, '-p', '#{pane_pipe}'])).toBe('1')
    const slow = await connect()
    input(slow, 0, 1, 'PIPE_TEST_STALL')
    const stallDeadline = Date.now() + 10_000
    while (!await fs.access(entered).then(() => true, () => false)) {
      if (Date.now() > stallDeadline) throw Error('Slow worker never entered the fixture gate')
      await Bun.sleep(10)
    }
    await sendPaneBurst({ tmux, target: sessions[0].tmuxWindow, root, marker: 'RELAY-BURST', received: b.output,
      failure: () => b.ws.readyState !== WebSocket.OPEN ? 'Healthy subscriber disconnected' : undefined })
    await fs.writeFile(release, '')
    await until(() => slow.frames.some(frame => frame.type === 'terminal-overload' || frame.type === 'terminal-error'), 'overflow recovery signal')
    expect(slow.frames.some(frame => frame.type === 'terminal-overload')).toBe(true)
    await until(() => slow.ws.readyState === WebSocket.CLOSED, 'overflow closes slow transport for resynchronization')
    expect(slow.frames.some(frame => frame.type === 'terminal-error')).toBe(false)
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
    const recovered = await connect()
    input(recovered, 0, 1, 'after-overflow-reconnect')
    await until(() => recovered.output().includes('after-overflow-reconnect') && b.output().includes('after-overflow-reconnect'), 'fresh subscription resumes output')
    recovered.ws.close()
    b.ws.close(); c.ws.close()
    await until(() => windows.every(window => tmux(['display-message', '-t', `pipe-relay-test:${window}`, '-p', '#{pane_pipe}']) === '0'), 'final subscribers release pipes')
  } finally {
    await fs.writeFile(release, '').catch(() => {})
    for (const ws of clients) ws.close()
    let childExit = 0
    if (child) { child.kill(); childExit = await child.exited }
    try { tmux(['kill-session', '-t', 'pipe-relay-test']) } catch { /* Already gone. */ }
    await fs.rm(root, { recursive: true, force: true })
    expect(childExit).toBe(0)
  }
}, 30000)
