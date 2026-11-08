import { resolveWorkerPath } from '../workerPath'
/** Owns the public listener worker while the parent serves HTTP on loopback. */
import type { Session } from '../../shared/types'
import { logger } from '../logger'
import { workerEnvironment, type ParentToRelay, type RelayOptions, type RelayToParent } from './protocol'

export class TerminalRelayClient {
  private catalogSignature = ''
  private worker: Worker
  private binds = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  private stopped: (() => void) | null = null
  readonly ready: Promise<void>

  constructor(options: RelayOptions, sessions: Session[], private readonly onMessage: (message: RelayToParent) => void) {
    const workerPath = resolveWorkerPath('terminalRelayWorker')
    this.worker = new Worker(workerPath, { type: 'module', env: workerEnvironment() })
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<RelayToParent>) => {
        const message = event.data
        if (message.type === 'listening' && message.hostname === options.hostname) resolve()
        if (message.type === 'bind-error' && message.hostname === options.hostname) reject(new Error(message.error))
        if (message.type === 'listening' || message.type === 'bind-error') {
          const bind = this.binds.get(message.hostname)
          this.binds.delete(message.hostname)
          if (message.type === 'listening') bind?.resolve()
          else bind?.reject(new Error(message.error))
        }
        if (message.type === 'stopped') this.stopped?.()
        onMessage(message)
      }
      this.worker.onerror = event => {
        const error = new Error(event.message || 'Terminal relay stopped')
        logger.error('terminal_relay_error', { error: error.message })
        reject(error)
        onMessage({ type: 'fatal', error: error.message })
      }
    })
    this.post({ type: 'init', options, sessions })
  }

  async bind(hostname: string): Promise<void> {
    await this.ready
    return new Promise((resolve, reject) => {
      this.binds.set(hostname, { resolve, reject })
      this.post({ type: 'bind', hostname })
    })
  }

  post(message: ParentToRelay) {
    if (message.type === 'init' || message.type === 'sessions') {
      const sessions = message.sessions.map(({ id, tmuxWindow, host, remote }) => ({ id, tmuxWindow, host: host ?? undefined, remote: remote === true }))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      const colors = message.type === 'init' ? message.options.terminalColorsEnabled : message.terminalColorsEnabled
      const signature = JSON.stringify([colors, sessions])
      if (message.type === 'sessions' && signature === this.catalogSignature) return
      this.catalogSignature = signature
      this.worker.postMessage({ ...message, sessions })
    } else this.worker.postMessage(message)
  }

  async shutdown(): Promise<void> {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { this.onMessage({ type: 'fatal', error: 'Terminal relay did not finish shutdown' }) }, 6000)
      this.stopped = () => { clearTimeout(timeout); resolve() }
      this.post({ type: 'shutdown' })
    })
  }
}
