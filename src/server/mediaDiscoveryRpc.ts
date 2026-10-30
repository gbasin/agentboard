/** Worker admission stays occupied after timeout until native work actually settles. */
import { resolveWorkerPath } from './workerPath'
import { sanitizedTmuxEnv } from './tmuxEnv'
import type { DiscoveryRequest, DiscoveryResponse } from './mediaDiscoveryProtocol'
type Command = DiscoveryRequest extends infer T ? T extends { id: number } ? Omit<T, 'id'> : never : never
export class DiscoveryRpc {
  private worker: Worker
  private serial = 0
  private closed = false
  private confirmedExit = false
  private idleWaiters = new Set<() => void>()
  get exited() { return this.confirmedExit }
  whenIdle(): Promise<void> {
    return this.pending.size ? new Promise(resolve => this.idleWaiters.add(resolve)) : Promise.resolve()
  }
  private settled() { if (!this.pending.size) { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() } }
  private stalled = new Set<number>()
  private pending = new Map<number, { resolve: (response: Extract<DiscoveryResponse, { value: unknown }>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(name: string, private timeout: number, private failed: (message: string) => void,
    createWorker = (url: string) => new Worker(url, { type: 'module', env: sanitizedTmuxEnv() }),
  ) {
    this.worker = createWorker(resolveWorkerPath(name))
    this.worker.onmessage = ({ data }: MessageEvent<DiscoveryResponse>) => {
      const request = this.pending.get(data.id)
      if (!request) return
      this.pending.delete(data.id); this.stalled.delete(data.id); clearTimeout(request.timer)
      if ('error' in data) request.reject(Object.assign(Error(data.error), { code: data.code }))
      else request.resolve(data)
      this.settled()
    }
    this.worker.onerror = () => this.fail('Media worker failed')
    this.worker.onmessageerror = () => this.fail('Media worker response failed')
    this.worker.addEventListener('close', () => { this.confirmedExit = true; this.fail('Media worker closed') })
  }
  request(command: Command) {
    if (this.closed) return Promise.reject(Error('Media worker unavailable'))
    if (this.stalled.size) return Promise.reject(Error('Media worker still processing a timed-out request'))
    if (this.pending.size >= 32) return Promise.reject(Error('Too many pending media requests'))
    return new Promise<Extract<DiscoveryResponse, { value: unknown }>>((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => {
        this.stalled.add(id)
        reject(Object.assign(Error('Media request timed out'), { code: 'MEDIA_TIMEOUT' }))
        // A blocked worker is not replaced: native work may still be executing.
        this.failed('Media worker stalled. Retry when it becomes available.')
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.worker.postMessage({ ...command, id }) }
      catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : Error(String(error)))
        this.settled()
      }
    })
  }
  dispose() {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('Media worker disposed')) }
    this.pending.clear(); this.settled()
    try { this.worker.postMessage({ kind: 'shutdown' }) } catch { /* A closed worker cannot accept shutdown. */ }
  }
  private fail(message: string) { if (!this.closed) { this.failed(message); this.dispose() } }
}
