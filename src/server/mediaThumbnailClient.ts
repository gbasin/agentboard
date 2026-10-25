/** One decode at a time; slow optional previews retain their slot until the worker responds. */
import { logger } from './logger'
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
  private timedOut = false

  constructor(
    private readonly createWorker = (url: string) => new Worker(url, { type: 'module', env: sanitizedTmuxEnv() }),
    private readonly timeoutMs = 10_000,
    private readonly capacity = 16,
  ) {}

  get(ref: ThumbnailRef, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.stopped || this.timedOut || this.queue.length + Number(!!this.current) >= this.capacity) return Promise.reject(failure('BUSY'))
    if (signal?.aborted) return Promise.reject(failure('ABORTED'))
    return new Promise((resolve, reject) => {
      const pending: Pending = { id: ++this.serial, ref, signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(pending)
        if (index >= 0) this.queue.splice(index, 1)
        // Running work retains its slot until it responds; deadlines never create another decoder.
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
          const expired = this.timedOut
          this.timedOut = false
          if (this.timer) clearTimeout(this.timer)
          this.timer = null
          if (expired) { this.pump(); return }
          if ('body' in event.data) this.settle(request, null, event.data.body)
          else this.settle(request, failure(event.data.code))
          this.pump()
        }
        worker.onerror = () => { if (this.worker === worker) this.failed() }
        worker.onmessageerror = () => { if (this.worker === worker) this.failed() }
      }
      this.timer = setTimeout(() => this.expire(), this.timeoutMs)
      this.worker.postMessage({ id: pending.id, ref: pending.ref })
    } catch { this.failed() }
  }

  private expire() {
    this.timer = null
    this.timedOut = true
    logger.warn('media_thumbnail_deadline', { timeoutMs: this.timeoutMs, queued: this.queue.length })
    // Reject callers without abandoning live native work. A late response frees
    // the slot; a permanently stuck codec disables previews until restart.
    if (this.current) this.settle(this.current, failure('BUSY'))
    for (const pending of this.queue.splice(0)) this.settle(pending, failure('BUSY'))
  }

  private failed() {
    // A worker error does not prove its native work stopped. Fail closed instead
    // of creating another decoder and accumulating abandoned workers.
    logger.warn('media_thumbnail_worker_failed', { queued: this.queue.length })
    this.dispose()
  }

  private retire() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null
      // terminate() is unsafe in compiled Bun (BUN-118B) and cannot reliably
      // interrupt native waits. Let the worker exit after its current callback.
      try { worker.postMessage({ kind: 'shutdown' }) } catch { /* already exited */ }
    }
  }

  private settle(pending: Pending, error: Error | null, body?: Uint8Array) {
    pending.signal?.removeEventListener('abort', pending.abort)
    if (error) pending.reject(error)
    else pending.resolve(body!)
  }
}
