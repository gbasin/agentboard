/** Real broker + terminal-worker fixture: withhold only broker credits for
 * the slow viewer, while acknowledging its consumed terminal output. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTmuxTmpDir, privateTmuxEnv, privateTmuxSocket } from '../testEnvironment'
import type { PaneBrokerResponse } from '../../relay/paneOutputProtocol'
import { sendPaneBurst } from './paneBurst'
import type { TerminalToRelay } from '../../relay/protocol'
const root = createTmuxTmpDir('ab-pane-credit-')
const socket = privateTmuxSocket(root)
await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 })
const env = { ...privateTmuxEnv(root), TMUX_SESSION: 'credit-test', TERMINAL_MODE: 'pipe-pane', AGENTBOARD_DATA_DIR: root, LOG_FILE: path.join(root, 'fixture.log'), LOG_LEVEL: 'error', AGENTBOARD_TMUX_SET_CLIPBOARD: '0' }
const tmux = (args: string[]) => {
  const result = Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
const workerEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
const worker = new Worker(new URL('../../paneOutputWorker.ts', import.meta.url).href, { type: 'module', env: workerEnv })
const terminal = new Worker(new URL('../../terminalSessionWorker.ts', import.meta.url).href, { type: 'module', env: workerEnv })
const ready = new Set<string>()
let slowId = ''
let terminalReady = false
let terminalStopped = false
let terminalError = false
let slowFailed = false
let fastFailed = false
let fastBytes = 0
let tail = ''
let released = false
let stopped = false
terminal.onmessage = (event: MessageEvent<TerminalToRelay>) => {
  const message = event.data
  if (message.type === 'pane-subscribe') { slowId = message.id; worker.postMessage(message) }
  else if (message.type === 'pane-release') worker.postMessage(message)
  // Intentionally withhold pane-credit to exhaust only this subscription.
  else if (message.type === 'send') {
    terminal.postMessage({ type: 'credit', sequence: message.sequence })
    const frame = JSON.parse(message.payload)
    if (frame.type === 'terminal-ready') terminalReady = true
    if (frame.type === 'terminal-error') terminalError = true
  } else if (message.type === 'overflow') slowFailed = true
  else if (message.type === 'stopped') terminalStopped = true
}
worker.onmessage = (event: MessageEvent<PaneBrokerResponse>) => {
  const message = event.data
  if ('id' in message && message.id === slowId) { terminal.postMessage(message); return }
  if (message.type === 'pane-ready') ready.add(message.id)
  if (message.type === 'pane-overflow' && message.id === 'fast') fastFailed = true
  if (message.type === 'pane-error') throw new Error(message.error)
  if (message.type === 'pane-data' && message.id === 'fast') {
    fastBytes += Buffer.byteLength(message.data)
    tail = (tail + message.data).slice(-200)
    worker.postMessage({ type: 'pane-credit', id: 'fast', bytes: Buffer.byteLength(message.data) })
  }
  if (message.type === 'pane-released' && message.id === 'fast') released = true
  if (message.type === 'pane-stopped') stopped = true
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000
  while (!check()) { if (Date.now() > deadline) throw new Error('Broker credit fixture timed out'); await Bun.sleep(10) }
}
try {
  tmux(['new-session', '-d', '-s', 'credit-test', 'cat'])
  const session = { id: 'credit-test:@0', tmuxWindow: 'credit-test:0' }
  terminal.postMessage({ type: 'init', id: 'slow-terminal', ptySpawnLock: new SharedArrayBuffer(4), sessions: [session], terminalColorsEnabled: true })
  terminal.postMessage({ type: 'resume', epoch: 1 })
  terminal.postMessage({ type: 'message', epoch: 1, message: { type: 'terminal-attach', sessionId: session.id, cols: 80, rows: 24, attachId: 1 } })
  await until(() => terminalReady)
  const key = tmux(['display-message', '-t', 'credit-test:0', '-p', '#{socket_path}:#{pid}:#{pane_id}'])
  worker.postMessage({ type: 'pane-subscribe', id: 'fast', key, target: '%0' })
  await until(() => ready.has('fast'))
  await sendPaneBurst({ tmux, target: 'credit-test:0', root, marker: 'CREDIT', received: () => tail,
    failure: () => fastFailed ? 'Credited subscriber overflowed' : undefined })
  await until(() => slowFailed || terminalError)
  if (terminalError || !slowFailed) throw new Error('Broker overflow used terminal-error instead of the relay overflow recovery signal')
  if (fastFailed) throw new Error('Fast subscriber was stopped with slow subscriber')
  terminal.postMessage({ type: 'shutdown' })
  await until(() => terminalStopped)
  worker.postMessage({ type: 'pane-release', id: 'fast' })
  await until(() => released)
  if (tmux(['display-message', '-t', 'credit-test:0', '-p', '#{pane_pipe}']) !== '0') throw new Error('Final pipe leaked')
  worker.postMessage({ type: 'pane-shutdown' })
  await until(() => stopped)
  console.log(JSON.stringify({ slowFailed, terminalError, fastFailed, fastBytes }))
} finally {
  if (!terminalStopped) { terminal.postMessage({ type: 'shutdown' }); await until(() => terminalStopped) }
  if (!stopped) { worker.postMessage({ type: 'pane-shutdown' }); await until(() => stopped) }
  try { tmux(['kill-session', '-t', 'credit-test']) } catch { /* Already gone. */ }
  await fs.rm(root, { recursive: true, force: true })
}
process.exit(0)
