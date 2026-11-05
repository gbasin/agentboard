import fs from 'node:fs/promises'
import { resolveWorkerPath } from '../workerPath'
import { timedSpawnAsync } from '../syncSpawnTiming'
import { sanitizedTmuxEnv } from '../tmuxEnv'
import { workerEnvironment } from './protocol'
import type { PaneOutputRequest, PaneBrokerResponse } from './paneOutputProtocol'

type Resource = { key: string; target: string; root: string; pid?: number }
/** One lazily allocated output realm; relay only routes bounded subscriptions. */
export class PaneOutputRouter {
  private broker: Worker | null = null
  private subscriptions = new Map<string, Worker>()
  private resources = new Map<string, Resource>()
  private failed = false
  private stopping = false
  private shutdownPromise: Promise<void> | null = null
  private stopped: (() => void) | null = null

  constructor(private fatal: (error: string) => void, private createBroker: () => Worker = () => new Worker(resolveWorkerPath('paneOutputWorker'), { type: 'module', env: workerEnvironment(), smol: true })) {}

  handle(worker: Worker, message: PaneOutputRequest): boolean {
    if (message.type !== 'pane-subscribe' && message.type !== 'pane-release' && message.type !== 'pane-credit') return false
    if (message.type === 'pane-subscribe') {
      if (this.failed || this.stopping || this.subscriptions.size >= 64 || this.subscriptions.has(message.id)) {
        worker.postMessage({ type: 'pane-error', id: message.id, error: 'Pane output unavailable' })
        return true
      }
      this.subscriptions.set(message.id, worker)
      try { this.start().postMessage(message) }
      catch (error) {
        this.subscriptions.delete(message.id)
        worker.postMessage({ type: 'pane-error', id: message.id, error: String(error) })
      }
    } else if (this.subscriptions.get(message.id) === worker) this.broker?.postMessage(message)
    else if (message.type === 'pane-release') worker.postMessage({ type: 'pane-released', id: message.id })
    return true
  }

  private start(): Worker {
    if (this.broker) return this.broker
    const broker = this.createBroker()
    this.broker = broker
    broker.onmessage = (event: MessageEvent<PaneBrokerResponse>) => {
      const message = event.data
      if (message.type === 'pane-resource') {
        if (message.closed) this.resources.delete(message.root)
        else this.resources.set(message.root, message)
        return
      }
      if (message.type === 'pane-stopped') { this.stopped?.(); return }
      const worker = this.subscriptions.get(message.id)
      try { worker?.postMessage(message) } catch { /* Lease worker already stopped. */ }
      if (message.type === 'pane-released' || message.type === 'pane-error') this.subscriptions.delete(message.id)
    }
    broker.onerror = () => { void this.fail() }
    return broker
  }

  private async fail(): Promise<void> {
    if (this.failed) return
    this.failed = true
    for (const [id, worker] of this.subscriptions) {
      try { worker.postMessage({ type: 'pane-error', id, error: 'Pane output worker stopped' }) } catch { /* Gone. */ }
    }
    this.subscriptions.clear()
    // Never replace a crashed owner and leave its output children behind.
    // Cleanup runs asynchronously, and only touches reported private resources.
    await Promise.all([...this.resources.values()].map(async resource => {
      const epoch = resource.key.match(/:(\d+):(%\d+)$/)
      if (epoch) {
        await timedSpawnAsync(['tmux', 'if-shell', '-F', '-t', epoch[2], `#{==:#{pid},${epoch[1]}}`, `pipe-pane -t ${epoch[2]}`], {
          env: sanitizedTmuxEnv(), timeout: 3000,
        }).catch(() => {})
      }
      if (resource.pid) { try { process.kill(resource.pid, 'SIGTERM') } catch { /* Already exited. */ } }
      await fs.rm(resource.root, { recursive: true, force: true }).catch(() => {})
    }))
    this.resources.clear()
    this.stopped?.()
    this.fatal('Pane output worker failed; owned output resources released')
  }

  remove(worker: Worker): void {
    for (const [id, owner] of this.subscriptions) {
      if (owner === worker) this.broker?.postMessage({ type: 'pane-release', id })
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopping = true
    if (!this.broker || this.failed) return Promise.resolve()
    this.shutdownPromise = new Promise<void>(resolve => {
      this.stopped = resolve
      this.broker!.postMessage({ type: 'pane-shutdown' })
    }).then(() => {
      this.broker = null
      this.subscriptions.clear()
    })
    return this.shutdownPromise
  }
}
