/** Run after the release build: bun scripts/verify-terminal-relay-binary.ts /path/to/agentboard */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ServerMessage } from '../src/shared/types'

const binary = process.argv[2]
if (!binary) throw new Error('Pass the compiled Agentboard executable path')
const dir = mkdtempSync(path.join(tmpdir(), 'ab-compiled-'))
const env: Record<string, string | undefined> = {
  ...process.env, TMUX_TMPDIR: dir, TMUX_SESSION: 'relay-compiled',
  AGENTBOARD_DATA_DIR: dir, AGENTBOARD_DB_PATH: path.join(dir, 'db'),
  LOG_FILE: path.join(dir, 'server.log'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
  CODEX_HOME: path.join(dir, 'codex'), PI_HOME: path.join(dir, 'pi'),
  PI_CODING_AGENT_DIR: path.join(dir, 'omp'), DEVIN_CLI_DIR: path.join(dir, 'devin'),
  GROK_HOME: path.join(dir, 'grok'), AGENTBOARD_TMUX_PID_FILE: path.join(dir, 'tmux-server.pid'),
  AGENTBOARD_TERMINAL_RELAY: '1', HOSTNAME: '127.0.0.1', AGENTBOARD_REMOTE_HOSTS: '',
  AGENTBOARD_OWNERSHIP_MATCHING: 'false', AGENTBOARD_TMUX_SET_CLIPBOARD: '0',
  AGENTBOARD_RELAY_GRACE_MS: '500', NODE_ENV: 'production',
}
delete env.TMUX
// Bun subprocesses receive this exact environment; the user's tmux is never used.
delete env.TMUX_PANE
for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_HOME', 'PI_CODING_AGENT_DIR', 'DEVIN_CLI_DIR', 'GROK_HOME']) mkdirSync(env[key]!, { recursive: true })
const reservation = Bun.serve({ hostname: env.HOSTNAME, port: 0, fetch: () => new Response('') })
const port = reservation.port!
reservation.stop(true)
env.PORT = String(port)
const base = `http://${env.HOSTNAME}:${port}`
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const peers: WebSocket[] = []
let child: ReturnType<typeof Bun.spawn> | undefined

function tmux(...args: string[]) {
  const result = Bun.spawnSync(['tmux', ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function connect(window: string, token?: string, claim = 1) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?catalog=2`)
  peers.push(ws)
  const frames: ServerMessage[] = []
  ws.onmessage = event => {
    const frame: ServerMessage = JSON.parse(String(event.data))
    frames.push(frame)
    if (frame.type === 'terminal-output' && frame.outputSeq) {
      ws.send(JSON.stringify({ type: 'terminal-ack', outputSeq: frame.outputSeq }))
    }
  }
  async function receive<T extends ServerMessage['type']>(type: T, predicate: (frame: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
    const end = performance.now() + 15_000
    while (performance.now() < end) {
      const index = frames.findIndex(frame => frame.type === type && predicate(frame as Extract<ServerMessage, { type: T }>))
      if (index >= 0) return frames.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>
      await wait(10)
    }
    throw new Error(`Timed out waiting for ${type}`)
  }
  const initial = await receive('sessions', frame => frame.sessions.some(session => session.tmuxWindow.endsWith(window)))
  const session = initial.sessions.find(session => session.tmuxWindow.endsWith(window))!
  ws.send(JSON.stringify({ type: 'terminal-resume', token, claim }))
  const lease = await receive('terminal-lease')
  async function attach(attachId: number) {
    ws.send(JSON.stringify({ type: 'terminal-attach', sessionId: session.id, tmuxTarget: session.tmuxWindow, cols: 80, rows: 24, attachId }))
    const ready = await receive('terminal-ready')
    if (ready.attachId !== attachId) throw new Error('Ready frame lost attachment identity')
  }
  return { ws, receive, session, token: lease.token, attach }
}

try {
  const window = tmux('-f', '/dev/null', 'new-session', '-d', '-s', env.TMUX_SESSION!, '-P', '-F', '#{window_id}', 'stty -echo; exec /bin/cat')
  child = Bun.spawn([path.resolve(binary)], { env, stdout: Bun.file(path.join(dir, 'out')), stderr: Bun.file(path.join(dir, 'err')) })
  let listening = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/server-info`)).ok) { listening = true; break } } catch {}
    await wait(100)
  }
  if (!listening) throw new Error('Compiled server unavailable')
  const first = await connect(window)
  await first.attach(1)
  const tty = tmux('list-clients', '-F', '#{client_tty}')
  const second = await connect(window, first.token, 2)
  await second.attach(2)
  if (second.token !== first.token || tty !== tmux('list-clients', '-F', '#{client_tty}')) throw new Error('Observer was not retained')
  const marker = `COMPILED_${crypto.randomUUID()}`
  second.ws.send(JSON.stringify({ type: 'terminal-input', sessionId: second.session.id, attachId: 2, data: `${marker}\r` }))
  let output = ''
  while (!output.includes(marker)) output += (await second.receive('terminal-output')).data
  second.ws.close()
  await wait(1100)
  if (tmux('list-sessions', '-F', '#{session_name}') !== env.TMUX_SESSION) throw new Error('Observer not reclaimed')
  // Source-mode Bun can lose signal delivery after concurrent worker PTYs.
  // Exercise the actual release artifact with a warm, multi-worker idle pool.
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => connect(window)))
  await Promise.all(concurrent.map(peer => peer.attach(1)))
  if (tmux('list-clients', '-F', '#{client_tty}').split('\n').filter(Boolean).length !== 6) throw new Error('Concurrent observers were not attached')
  for (const peer of concurrent) peer.ws.close()
  await wait(2000)
  if (tmux('list-sessions', '-F', '#{session_name}') !== env.TMUX_SESSION) throw new Error('Concurrent observers were not reclaimed')
  await wait(10_000)
  const log = await Bun.file(env.LOG_FILE!).text()
  if (/ModuleNotFound|worker_error|worker_failed/.test(log)) throw new Error('Compiled worker failed; inspect diagnostics')
  console.log('PASS: compiled HTTP, real terminal attach, retained reconnect, echo, six-worker expiry and idle pool, agent survival')
} catch (error) {
  console.error(error)
  for (const filename of ['err', 'server.log']) {
    const file = Bun.file(path.join(dir, filename))
    if (await file.exists()) console.error(filename, (await file.text()).slice(-7000))
  }
  process.exitCode = 1
} finally {
  for (const ws of peers) ws.close()
  if (child) {
    child.kill()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const graceful = await Promise.race([
      child.exited.then(code => ({ code })),
      new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 10_000) }),
    ])
    clearTimeout(timeout)
    if (!graceful) {
      console.error('Compiled shutdown did not finish within 10 seconds')
      process.exitCode = 1
      child.kill('SIGKILL')
    }
    const code = graceful?.code ?? await child.exited
    console.log('Compiled shutdown:', code, child.signalCode)
    if (code !== 0 || child.signalCode) process.exitCode = 1
  }
  try {
    for (const session of tmux('list-sessions', '-F', '#{session_name}').split('\n')) tmux('kill-session', '-t', `=${session}`)
  } catch {}
  rmSync(dir, { recursive: true, force: true })
}
