/** Real broker process fixture: one subscriber deliberately withholds credits. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTmuxTmpDir, privateTmuxEnv, privateTmuxSocket } from '../testEnvironment'
import type { PaneBrokerResponse } from '../../relay/paneOutputProtocol'
const root = createTmuxTmpDir('ab-pane-credit-')
const socket = privateTmuxSocket(root)
await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 })
const env = privateTmuxEnv(root)
const tmux = (args: string[]) => {
  const result = Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
const worker = new Worker(new URL('../../paneOutputWorker.ts', import.meta.url).href, { type: 'module', env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) })
const ready = new Set<string>()
let slowFailed = false
let fastFailed = false
let fastBytes = 0
let tail = ''
let released = false
let stopped = false
worker.onmessage = (event: MessageEvent<PaneBrokerResponse>) => {
  const message = event.data
  if (message.type === 'pane-ready') ready.add(message.id)
  if (message.type === 'pane-error') { if (message.id === 'slow') slowFailed = true; else fastFailed = true }
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
  const key = tmux(['display-message', '-t', 'credit-test:0', '-p', '#{socket_path}:#{pid}:#{pane_id}'])
  for (const id of ['slow', 'fast']) worker.postMessage({ type: 'pane-subscribe', id, key, target: '%0' })
  await until(() => ready.size === 2)
  tmux(['respawn-pane', '-k', '-t', 'credit-test:0', "i=0; while [ $i -lt 80 ]; do head -c 40960 /dev/zero | tr '\\000' x; sleep 0.02; i=$((i+1)); done; printf '\\nCREDIT-END\\n'; exec cat"])
  await until(() => slowFailed && tail.includes('CREDIT-END'))
  if (fastFailed) throw new Error('Fast subscriber was stopped with slow subscriber')
  worker.postMessage({ type: 'pane-release', id: 'fast' })
  await until(() => released)
  if (tmux(['display-message', '-t', 'credit-test:0', '-p', '#{pane_pipe}']) !== '0') throw new Error('Final pipe leaked')
  worker.postMessage({ type: 'pane-shutdown' })
  await until(() => stopped)
  console.log(JSON.stringify({ slowFailed, fastFailed, fastBytes }))
} finally {
  if (!stopped) { worker.postMessage({ type: 'pane-shutdown' }); await until(() => stopped) }
  try { tmux(['kill-session', '-t', 'credit-test']) } catch { /* Already gone. */ }
  await fs.rm(root, { recursive: true, force: true })
}
process.exit(0)
