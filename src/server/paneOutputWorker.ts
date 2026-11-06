/// <reference lib="webworker" />
/** One shared output owner across terminal lease realms. Slow tmux commands
 * stay outside the relay event loop and every viewer's input worker. */
import { subscribePaneOutput, type PaneOutputLease } from './terminal/PaneOutputFeed'
import { config } from './config'
import { timedSpawnSync } from './syncSpawnTiming'
import { sanitizedTmuxEnv } from './tmuxEnv'
import type { PaneBrokerRequest, PaneBrokerResponse } from './relay/paneOutputProtocol'
const ctx = self as DedicatedWorkerGlobalScope
const leases = new Map<string, { lease: PaneOutputLease; pendingBytes: number }>()
let stopping = false
const releases = new Set<Promise<void>>()
function release(id: string): Promise<void> {
  const entry = leases.get(id)
  leases.delete(id)
  const task = entry?.lease.release() ?? Promise.resolve()
  releases.add(task)
  void task.finally(() => releases.delete(task))
  return task
}
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const post = (message: PaneBrokerResponse) => ctx.postMessage(message)
const transport = {
  spawn: Bun.spawn,
  runTmux(args: string[]): string {
    const result = timedSpawnSync(['tmux', ...args], { env: sanitizedTmuxEnv(), timeout: config.tmuxMutationTimeoutMs, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr?.toString() || 'Tmux pipe command failed')
    return result.stdout?.toString() ?? ''
  },
}
ctx.onmessage = async (event: MessageEvent<PaneBrokerRequest>) => {
  const message = event.data
  if (message.type === 'pane-shutdown') {
    stopping = true
    await Promise.all([...leases.keys()].map(release))
    await Promise.all(releases)
    post({ type: 'pane-stopped' })
    // Bun 1.3.14 can SIGTRAP while closing nested worker realms. Remain
    // inert after acknowledgment; the parent process owns realm teardown.
    return
  }
  if (message.type === 'pane-subscribe') {
    if (stopping) { post({ type: 'pane-error', id: message.id, error: 'Pane output shutting down' }); return }
    if (leases.has(message.id)) return
    if (leases.size >= 64) { post({ type: 'pane-error', id: message.id, error: 'Pane output capacity reached' }); return }
    const lease = subscribePaneOutput(message.key, message.target, {
      ...transport,
      onResource: resource => post({ type: 'pane-resource', key: message.key, target: message.target, ...resource }),
    }, {
      onData: data => {
        const entry = leases.get(message.id)
        if (!entry) return
        const bytes = Buffer.byteLength(data)
        if (entry.pendingBytes + bytes > MAX_PENDING_BYTES) {
          void release(message.id).then(() => post({ type: 'pane-overflow', id: message.id }))
          return
        }
        entry.pendingBytes += bytes
        post({ type: 'pane-data', id: message.id, data })
      },
      onExit: () => post({ type: 'pane-exit', id: message.id }),
    })
    leases.set(message.id, { lease, pendingBytes: 0 })
    try { await lease.ready; post({ type: 'pane-ready', id: message.id }) }
    catch (error) {
      await release(message.id)
      post({ type: 'pane-error', id: message.id, error: String(error) })
    }
  } else if (message.type === 'pane-release') {
    await release(message.id)
    post({ type: 'pane-released', id: message.id })
  } else if (message.type === 'pane-credit') {
    const entry = leases.get(message.id)
    if (entry) entry.pendingBytes = Math.max(0, entry.pendingBytes - message.bytes)
  }
}
