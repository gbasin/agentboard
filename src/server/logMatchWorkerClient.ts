import type { MatchWorkerRequest, MatchWorkerResponse } from './logMatchWorkerTypes'

export type { MatchWorkerRequest, MatchWorkerResponse } from './logMatchWorkerTypes'

interface PendingRequest {
  resolve: (response: MatchWorkerResponse) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

const DEFAULT_TIMEOUT_MS = 15000
const READY_TIMEOUT_MS = 10000

class WorkerInitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerInitError'
  }
}

export class LogMatchWorkerClient {
  private worker: Worker | null = null
  private disposed = false
  private counter = 0
  private pending = new Map<string, PendingRequest>()
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null

  constructor() {
    this.spawnWorker()
  }

  async poll(
    request: Omit<MatchWorkerRequest, 'id'>,
    options?: { timeoutMs?: number }
  ): Promise<MatchWorkerResponse> {
    if (this.disposed) {
      throw new Error('Log match worker is disposed')
    }
    if (!this.worker) {
      this.spawnWorker()
    }

    // Wait for the worker to be ready before sending the first message
    if (this.readyPromise) {
      try {
        await this.readyPromise
      } catch (error) {
        /* logging-audit:intentional */
        // Worker failed to initialize - restart and retry once
        if (error instanceof WorkerInitError) {
          if (this.disposed) {
            throw new Error('Log match worker is disposed', { cause: error })
          }
          this.restartWorker()
          if (this.readyPromise) {
            await this.readyPromise // This will throw if restart also fails
          }
        } else {
          throw error
        }
      }
    }
    if (this.disposed) {
      throw new Error('Log match worker is disposed')
    }

    const id = `${Date.now()}-${this.counter++}`
    const payload: MatchWorkerRequest = { ...request, id }
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<MatchWorkerResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Log match worker timed out'))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timeoutId })
      this.worker?.postMessage(payload)
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.readyReject) {
      this.readyReject(new Error('Log match worker is disposed'))
      this.readyReject = null
    }
    this.readyResolve = null
    this.readyPromise = null
    this.failAll(new Error('Log match worker is disposed'))
    // Don't call worker.terminate() — it triggers a segfault in compiled Bun binaries
    // (known Bun bug BUN-118B). The worker will be cleaned up on process exit.
    this.worker = null
  }

  private spawnWorker(): void {
    if (this.disposed) return

    // Set up ready promise before creating the worker
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      // Timeout if worker doesn't become ready
      setTimeout(() => {
        if (this.readyReject) {
          const rejectFn = this.readyReject
          this.readyResolve = null
          this.readyReject = null
          this.readyPromise = null
          rejectFn(new WorkerInitError('Log match worker failed to initialize'))
        }
      }, READY_TIMEOUT_MS)
    })

    // Compiled Bun binaries need string paths; dev mode needs URL resolution
    const workerPath = import.meta.url.includes('$bunfs')
      ? './logMatchWorker.ts'
      : new URL('./logMatchWorker.ts', import.meta.url).href
    const worker = new Worker(workerPath, {
      type: 'module',
    })
    worker.onmessage = (event) => {
      const data = event.data as MatchWorkerResponse | { type: 'ready' }
      // Handle ready signal from worker
      if (data && data.type === 'ready') {
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
          this.readyReject = null
          this.readyPromise = null
        }
        return
      }
      this.handleMessage(data as MatchWorkerResponse)
    }
    worker.onerror = (event) => {
      const message = event instanceof ErrorEvent ? event.message : 'Log match worker error'
      // Reject readiness immediately so callers don't wait for timeout
      if (this.readyReject) {
        const rejectFn = this.readyReject
        this.readyResolve = null
        this.readyReject = null
        this.readyPromise = null
        rejectFn(new WorkerInitError(message))
      }
      this.failAll(new Error(message))
      this.restartWorker()
    }
    worker.onmessageerror = () => {
      // Reject readiness immediately so callers don't wait for timeout
      if (this.readyReject) {
        const rejectFn = this.readyReject
        this.readyResolve = null
        this.readyReject = null
        this.readyPromise = null
        rejectFn(new WorkerInitError('Log match worker message error'))
      }
      this.failAll(new Error('Log match worker message error'))
      this.restartWorker()
    }
    this.worker = worker
  }

  private restartWorker(): void {
    if (this.disposed) return
    // Don't call worker.terminate() — abandon the old worker instead
    this.worker = null
    this.spawnWorker()
  }

  private handleMessage(response: MatchWorkerResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId)
    }
    this.pending.delete(response.id)
    if (response.type === 'error') {
      pending.reject(new Error(response.error ?? 'Log match worker error'))
      return
    }
    pending.resolve(response)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId)
      }
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
