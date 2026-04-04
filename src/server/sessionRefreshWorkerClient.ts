/**
 * Client for the session refresh worker.
 * Provides async interface for refreshing session list off the main thread.
 */
import { config } from './config'
import type { Session } from '../shared/types'
import type { RefreshWorkerRequest, RefreshWorkerResponse } from './sessionRefreshWorker'

interface PendingRequest {
  generation: number
  resolve: (response: RefreshWorkerResponse) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

const LAST_USER_MESSAGE_TIMEOUT_MS = 10000
const MIN_REFRESH_WINDOW_BUDGET = 1
const REFRESH_WINDOW_HEADROOM = 1
const REQUEST_TIMEOUT_OVERHEAD_MS = 2000

export class SessionRefreshWorkerTimeoutError extends Error {
  constructor(message = 'Session refresh worker timed out') {
    super(message)
    this.name = 'SessionRefreshWorkerTimeoutError'
  }
}

function getRefreshTimeoutMs(expectedWindowCount = 0): number {
  const safeExpectedWindowCount = Number.isFinite(expectedWindowCount)
    ? Math.max(0, Math.floor(expectedWindowCount))
    : 0
  const windowBudget = Math.max(
    MIN_REFRESH_WINDOW_BUDGET,
    safeExpectedWindowCount + REFRESH_WINDOW_HEADROOM
  )

  // Refresh does one list-windows call plus one capture-pane call per window.
  return ((windowBudget + 1) * config.tmuxTimeoutMs) + REQUEST_TIMEOUT_OVERHEAD_MS
}

export class SessionRefreshWorkerClient {
  private worker: Worker | null = null
  private disposed = false
  private counter = 0
  private generation = 0
  private pending = new Map<string, PendingRequest>()

  constructor() {
    this.spawnWorker()
  }

  async refresh(
    managedSession: string,
    discoverPrefixes: string[],
    options: { expectedWindowCount?: number } = {}
  ): Promise<Session[]> {
    if (this.disposed) {
      throw new Error('Session refresh worker is disposed')
    }
    if (!this.worker) {
      this.spawnWorker()
    }

    const id = `${Date.now()}-${this.counter++}`
    const generation = this.generation
    const payload: RefreshWorkerRequest = {
      id,
      kind: 'refresh',
      managedSession,
      discoverPrefixes,
    }

    return new Promise<Session[]>((resolve, reject) => {
      const timeoutMs = getRefreshTimeoutMs(options.expectedWindowCount)
      const timeoutId = setTimeout(() => {
        this.failGeneration(generation, new SessionRefreshWorkerTimeoutError())
        this.restartWorker(generation)
      }, timeoutMs)

      this.pending.set(id, {
        generation,
        resolve: (response) => {
          if (response.type === 'result' && response.kind === 'refresh') {
            resolve(response.sessions)
          } else {
            const message =
              response.type === 'error' ? response.error : 'Session refresh failed'
            reject(new Error(message))
          }
        },
        reject,
        timeoutId,
      })
      this.worker?.postMessage(payload)
    })
  }

  async getLastUserMessage(
    tmuxWindow: string,
    scrollbackLines?: number
  ): Promise<string | null> {
    if (this.disposed) {
      throw new Error('Session refresh worker is disposed')
    }
    if (!this.worker) {
      this.spawnWorker()
    }

    const id = `${Date.now()}-${this.counter++}`
    const generation = this.generation
    const payload: RefreshWorkerRequest = {
      id,
      kind: 'last-user-message',
      tmuxWindow,
      scrollbackLines,
    }

    return new Promise<string | null>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.failGeneration(generation, new SessionRefreshWorkerTimeoutError())
        this.restartWorker(generation)
      }, LAST_USER_MESSAGE_TIMEOUT_MS)

      this.pending.set(id, {
        generation,
        resolve: (response) => {
          if (response.type === 'result' && response.kind === 'last-user-message') {
            resolve(response.message ?? null)
          } else {
            const message =
              response.type === 'error'
                ? response.error
                : 'Last user message refresh failed'
            reject(new Error(message))
          }
        },
        reject,
        timeoutId,
      })
      this.worker?.postMessage(payload)
    })
  }

  dispose(): void {
    this.disposed = true
    this.failAll(new Error('Session refresh worker disposed'))
    // Don't call worker.terminate() — it triggers a segfault in compiled Bun binaries
    // (known Bun bug BUN-118B). The worker will be cleaned up on process exit.
    this.detachWorker(this.worker)
    this.worker = null
  }

  private spawnWorker(): void {
    if (this.disposed) return
    // Compiled Bun binaries need string paths; dev mode needs URL resolution
    const workerPath = import.meta.url.includes('$bunfs')
      ? './sessionRefreshWorker.ts'
      : new URL('./sessionRefreshWorker.ts', import.meta.url).href
    const worker = new Worker(workerPath, {
      type: 'module',
    })
    const generation = ++this.generation
    worker.onmessage = (event) => {
      this.handleMessage(generation, event.data as RefreshWorkerResponse)
    }
    worker.onerror = (event) => {
      if (generation !== this.generation) return
      const message =
        event instanceof ErrorEvent ? event.message : 'Session refresh worker error'
      this.failGeneration(generation, new Error(message))
      this.restartWorker(generation)
    }
    worker.onmessageerror = () => {
      if (generation !== this.generation) return
      this.failGeneration(generation, new Error('Session refresh worker message error'))
      this.restartWorker(generation)
    }
    this.worker = worker
  }

  private restartWorker(expectedGeneration?: number): void {
    if (this.disposed) return
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) {
      return
    }
    // Don't call worker.terminate() — abandon the old worker instead
    this.detachWorker(this.worker)
    this.worker = null
    this.spawnWorker()
  }

  private handleMessage(generation: number, response: RefreshWorkerResponse): void {
    if (generation !== this.generation) return
    const pending = this.pending.get(response.id)
    if (!pending) return
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId)
    }
    this.pending.delete(response.id)
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

  private failGeneration(generation: number, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) {
        continue
      }
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId)
      }
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private detachWorker(worker: Worker | null): void {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
  }
}
