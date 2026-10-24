import { resolveWorkerPath } from '../workerPath'
/** Bounded observers survive transport replacement; agent panes never belong to a lease. */
import type { ServerWebSocket } from 'bun'
import type { ClientMessage } from '../../shared/types'
import { workerEnvironment, type TerminalSession, type RelayToTerminal, type TerminalToRelay } from './protocol'

export interface RelaySocketData {
  id: string
  lease: Lease | null
  outputSerial: number
  outstanding: Map<number, number>
  outstandingBytes: number
}
type Socket = ServerWebSocket<RelaySocketData>
interface Lease {
  id: string
  token: string
  worker: Worker
  owner: Socket | null
  epoch: number
  claim: number
  retained: boolean
  progressAt: number
  detachedAt: number | null
}
function duration(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const GRACE_MS = duration('AGENTBOARD_RELAY_GRACE_MS', 60_000)
const PROGRESS_MS = duration('AGENTBOARD_RELAY_PROGRESS_MS', 90_000)
const MAX_LEASES = 32
const MAX_OUTPUT_BYTES = 1024 * 1024
const TERMINAL_TYPES = new Set(['terminal-attach', 'terminal-detach', 'terminal-input', 'terminal-paste', 'terminal-resize', 'tmux-cancel-copy-mode', 'tmux-check-copy-mode'])

export class TerminalLeases {
  private leases = new Map<string, Lease>()
  private sessions: TerminalSession[] = []
  private colors = true
  private timer = setInterval(() => this.sweep(), Math.min(1000, GRACE_MS, PROGRESS_MS))
  private retiring = new Set<Promise<void>>()
  // PTY worker realm teardown SIGTRAPs in Bun 1.3.14 on macOS. Reuse only
  // after disposal acknowledges; active + retiring + idle never exceeds 32.
  private idleWorkers: Worker[] = []

  constructor(private notify: (message: { type: 'submit'; sessionId: string } | { type: 'group-created' } | { type: 'lease-created' | 'lease-removed'; id: string } | { type: 'fatal'; error: string }) => void) {}

  update(sessions: TerminalSession[], colors: boolean) {
    this.sessions = sessions
    this.colors = colors
    for (const lease of this.leases.values()) this.post(lease, { type: 'sessions', sessions, terminalColorsEnabled: colors })
  }

  handle(ws: Socket, message: ClientMessage): boolean {
    if (message.type === 'terminal-resume') {
      this.resume(ws, message.token, message.claim)
      return true
    }
    if (message.type === 'terminal-ack') {
      const seq = message.outputSeq
      if (Number.isSafeInteger(seq) && seq > 0 && seq <= ws.data.outputSerial) {
        for (const [pending, bytes] of ws.data.outstanding) if (pending <= seq) {
          ws.data.outstandingBytes -= bytes
          ws.data.outstanding.delete(pending)
        }
      }
      this.progress(ws)
      return true
    }
    if (!TERMINAL_TYPES.has(message.type)) return false
    if (message.attachId !== undefined && (!Number.isSafeInteger(message.attachId) || message.attachId <= 0)) return true
    let lease = ws.data.lease
    if (!lease) {
      // Old clients do not negotiate retention or output acknowledgments.
      lease = this.create(ws, 0, false)
      if (!lease) return true
    }
    if (lease.owner !== ws) return true
    lease.progressAt = performance.now()
    this.post(lease, { type: 'message', epoch: lease.epoch, message })
    return true
  }

  progress(ws: Socket) {
    if (ws.data.lease?.owner === ws) ws.data.lease.progressAt = performance.now()
  }

  close(ws: Socket) {
    const lease = ws.data.lease
    if (!lease || lease.owner !== ws) return
    lease.owner = null
    lease.detachedAt = performance.now()
    this.post(lease, { type: 'suspend' })
    if (!lease.retained) this.retire(lease)
  }

  private resume(ws: Socket, token: string | undefined, claim: number) {
    if (ws.readyState !== 1 || (ws.data.lease && ws.data.lease.owner !== ws)) return
    if (!Number.isSafeInteger(claim) || claim < 1 || (token !== undefined && typeof token !== 'string')) {
      ws.close(1008, 'Invalid terminal resume')
      return
    }
    const known = token ? this.leases.get(token) : undefined
    if (known && claim <= known.claim) {
      ws.close(1008, 'Obsolete terminal connection')
      return
    }
    // Repeated handshake on the current socket cannot abandon an existing observer.
    if (ws.data.lease && ws.data.lease !== known) this.retire(ws.data.lease)
    const lease = known ?? this.create(ws, claim, true)
    if (!lease) return
    if (known) {
      const old = lease.owner
      lease.owner = ws
      lease.epoch++
      lease.claim = claim
      lease.detachedAt = null
      lease.progressAt = performance.now()
      ws.data.lease = lease
      this.post(lease, { type: 'resume', epoch: lease.epoch })
      if (old && old !== ws) old.close(4001, 'Terminal resumed elsewhere')
    }
    this.send(ws, JSON.stringify({ type: 'terminal-lease', token: lease.token }))
  }

  private create(ws: Socket, claim: number, retained: boolean): Lease | null {
    this.sweep()
    if (this.leases.size + this.retiring.size >= MAX_LEASES) {
      const idle = [...this.leases.values()].find(lease => !lease.owner)
      if (idle) this.retire(idle)
    }
    if (this.leases.size + this.retiring.size >= MAX_LEASES) { ws.close(1013, 'Terminal capacity reached'); return null }
    const token = crypto.randomUUID()
    const id = crypto.randomUUID()
    const workerPath = resolveWorkerPath('terminalSessionWorker')
    const worker = this.idleWorkers.pop() ?? new Worker(workerPath, { type: 'module', env: workerEnvironment(), smol: true })
    const lease: Lease = { id, token, worker, owner: ws, epoch: 1, claim, retained, progressAt: performance.now(), detachedAt: null }
    this.leases.set(token, lease)
    this.notify({ type: 'lease-created', id })
    ws.data.lease = lease
    worker.onmessage = (event: MessageEvent<TerminalToRelay>) => {
      const message = event.data
      if (message.type === 'send') {
        const owner = lease.owner
        if (owner && message.epoch === lease.epoch) this.sendTerminal(owner, message.payload)
        this.post(lease, { type: 'credit', sequence: message.sequence })
      } else if (message.type === 'overflow') {
        lease.owner?.close(1013, 'Terminal output needs resynchronization')
      } else if (message.type === 'submit' || message.type === 'group-created') this.notify(message)
    }
    worker.onerror = () => {
      lease.owner?.close(1011, 'Terminal worker stopped')
      this.notify({ type: 'fatal', error: 'Terminal worker failed' })
    }
    this.post(lease, { type: 'init', id, sessions: this.sessions, terminalColorsEnabled: this.colors })
    this.post(lease, { type: 'resume', epoch: lease.epoch })
    return lease
  }

  private sendTerminal(ws: Socket, raw: string) {
    const message = JSON.parse(raw)
    if (message.type === 'terminal-output' && ws.data.lease?.retained) {
      const outputSeq = ++ws.data.outputSerial
      const payload = JSON.stringify({ ...message, outputSeq })
      const bytes = Buffer.byteLength(payload)
      if (ws.data.outstandingBytes + bytes > MAX_OUTPUT_BYTES) {
        ws.close(1013, 'Terminal output needs resynchronization')
        return
      }
      ws.data.outstanding.set(outputSeq, bytes)
      ws.data.outstandingBytes += bytes
      this.send(ws, payload)
    } else this.send(ws, raw)
  }

  send(ws: Socket, payload: string) {
    if (ws.readyState !== 1) return
    // Never drop arbitrary ANSI output and then continue the same stream.
    if (Buffer.byteLength(payload) + ws.getBufferedAmount() > 16 * MAX_OUTPUT_BYTES || ws.send(payload) === 0) ws.close(1013, 'Connection needs resynchronization')
  }

  private post(lease: Lease, message: RelayToTerminal) { lease.worker.postMessage(message) }

  private sweep() {
    const now = performance.now()
    for (const lease of this.leases.values()) {
      if (lease.owner && now - lease.progressAt > PROGRESS_MS) {
        lease.owner.close(4001, 'Terminal lease expired')
        this.retire(lease)
      } else if (lease.detachedAt !== null && now - lease.detachedAt > GRACE_MS) this.retire(lease)
    }
  }

  private retire(lease: Lease) {
    if (!this.leases.delete(lease.token)) return
    this.notify({ type: 'lease-removed', id: lease.id })
    lease.owner = null
    const task = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // Bun's compiled worker termination can crash the runtime. Fail the
        // service rather than continue accepting work with an orphan observer.
        this.notify({ type: 'fatal', error: 'Terminal worker did not finish disposal' })
      }, 5000)
      const previous = lease.worker.onmessage
      lease.worker.onmessage = event => {
        if ((event.data as TerminalToRelay).type === 'stopped') {
          clearTimeout(timer)
          lease.worker.onmessage = null
          this.idleWorkers.push(lease.worker)
          resolve()
        }
        else previous?.call(lease.worker, event)
      }
      this.post(lease, { type: 'shutdown' })
    })
    this.retiring.add(task)
    void task.finally(() => { this.retiring.delete(task) })
  }

  async shutdown() {
    clearInterval(this.timer)
    for (const lease of this.leases.values()) this.retire(lease)
    await Promise.allSettled(this.retiring)
  }
}
