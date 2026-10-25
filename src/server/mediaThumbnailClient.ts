/** One decode at a time, bounded admission, and a killable deadline for optional previews. */
import { resolveWorkerPath } from './workerPath'
import { sanitizedTmuxEnv } from './tmuxEnv'
import type { ThumbnailRef, ThumbnailResponse } from './mediaThumbnailTypes'

type Pending = {
  id: number; ref: ThumbnailRef; signal?: AbortSignal
  resolve(body: Uint8Array): void; reject(error: Error): void
  abort(): void
}
function failure(code: string) { return Object.assign(new Error(code), { code }) }

export class MediaThumbnailClient {
  private worker: Worker | null = null
  private queue: Pending[] = []
  private current: Pending | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private serial = 0
  private stopped = false

  constructor(
    private readonly createWorker = (url: string) => new Worker(url, { type: 'module', env: sanitizedTmuxEnv() }),
    private readonly timeoutMs = 10_000,
    private readonly capacity = 16,
  ) {}

  get(ref: ThumbnailRef, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.stopped || this.queue.length + Number(!!this.current) >= this.capacity) return Promise.reject(failure('BUSY'))
    if (signal?.aborted) return Promise.reject(failure('ABORTED'))
    return new Promise((resolve, reject) => {
      const pending: Pending = { id: ++this.serial, ref, signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(pending)
        if (index >= 0) this.queue.splice(index, 1)
        // Running work retains its slot until it responds or the worker is terminated.
        reject(failure('ABORTED'))
        signal?.removeEventListener('abort', pending.abort)
      } }
      signal?.addEventListener('abort', pending.abort, { once: true })
      this.queue.push(pending)
      this.pump()
    })
  }

  dispose() {
    this.stopped = true
    this.retire()
    if (this.current) this.settle(this.current, failure('STOPPED'))
    this.current = null
    for (const pending of this.queue.splice(0)) this.settle(pending, failure('STOPPED'))
  }

  private pump() {
    if (this.stopped || this.current || !this.queue.length) return
    const pending = this.queue.shift()!
    this.current = pending
    try {
      if (!this.worker) {
        const worker = this.createWorker(resolveWorkerPath('mediaThumbnailWorker'))
        this.worker = worker
        worker.onmessage = (event: MessageEvent<ThumbnailResponse>) => {
          if (this.worker !== worker || this.current?.id !== event.data.id) return
          const request = this.current
          this.current = null
          if (this.timer) clearTimeout(this.timer)
          this.timer = null
          if ('body' in event.data) this.settle(request, null, event.data.body)
          else this.settle(request, failure(event.data.code))
          this.pump()
        }
        worker.onerror = () => { if (this.worker === worker) this.failed() }
        worker.onmessageerror = () => { if (this.worker === worker) this.failed() }
      }
      this.timer = setTimeout(() => this.failed(), this.timeoutMs)
      this.worker.postMessage({ id: pending.id, ref: pending.ref })
    } catch { this.failed() }
  }

  private failed() {
    this.retire()
    if (this.current) this.settle(this.current, failure('BUSY'))
    this.current = null
    this.pump()
  }

  private retire() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const worker = this.worker
    this.worker = null
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate() }
  }

  private settle(pending: Pending, error: Error | null, body?: Uint8Array) {
    pending.signal?.removeEventListener('abort', pending.abort)
    if (error) pending.reject(error)
    else pending.resolve(body!)
  }
}
