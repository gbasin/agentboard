/**
 * Client for the session refresh worker.
 * Provides async interface for refreshing session list off the main thread.
 */
import { config } from './config'
import type { Session } from '../shared/types'
import type { RefreshWorkerRequest, RefreshWorkerResponse } from './sessionRefreshWorker'
import { TMUX_TIMEOUT_ERROR_CODE } from './tmuxTimeout'

interface PendingRequest {
  generation: number
  resolve: (response: RefreshWorkerResponse) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

const MIN_LAST_USER_MESSAGE_TIMEOUT_MS = 10000
const MIN_REFRESH_WINDOW_BUDGET = 1
const REFRESH_WINDOW_HEADROOM = 1
const REQUEST_TIMEOUT_OVERHEAD_MS = 2000

export class SessionRefreshWorkerTimeoutError extends Error {
  constructor(message = 'Session refresh worker timed out') {
    super(message)
    this.name = 'SessionRefreshWorkerTimeoutError'
  }
}

function toWorkerResponseError(
  response: Extract<RefreshWorkerResponse, { type: 'error' }>
): Error {
  if (response.errorCode === TMUX_TIMEOUT_ERROR_CODE) {
    return new SessionRefreshWorkerTimeoutError(response.error)
  }
  return new Error(response.error)
}

export function getRefreshTimeoutMs(
  expectedWindowCount = 0,
  tmuxTimeoutMs = config.tmuxTimeoutMs
): number {
  const safeExpectedWindowCount = Number.isFinite(expectedWindowCount)
    ? Math.max(0, Math.floor(expectedWindowCount))
    : 0
  const windowBudget = Math.max(
    MIN_REFRESH_WINDOW_BUDGET,
    safeExpectedWindowCount + REFRESH_WINDOW_HEADROOM
  )

  // Refresh does one list-windows call plus one capture-pane call per window.
  return ((windowBudget + 1) * tmuxTimeoutMs) + REQUEST_TIMEOUT_OVERHEAD_MS
}

export function getLastUserMessageTimeoutMs(tmuxTimeoutMs = config.tmuxTimeoutMs): number {
  return Math.max(
    MIN_LAST_USER_MESSAGE_TIMEOUT_MS,
    tmuxTimeoutMs + REQUEST_TIMEOUT_OVERHEAD_MS
  )
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
        this.handleRequestTimeout(id, generation)
      }, timeoutMs)

      this.pending.set(id, {
        generation,
        resolve: (response) => {
          if (response.type === 'result' && response.kind === 'refresh') {
            resolve(response.sessions)
          } else {
            reject(
              response.type === 'error'
                ? toWorkerResponseError(response)
                : new Error('Session refresh failed')
            )
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
        this.handleRequestTimeout(id, generation)
      }, getLastUserMessageTimeoutMs())

      this.pending.set(id, {
        generation,
        resolve: (response) => {
          if (response.type === 'result' && response.kind === 'last-user-message') {
            resolve(response.message ?? null)
          } else {
            reject(
              response.type === 'error'
                ? toWorkerResponseError(response)
                : new Error('Last user message refresh failed')
            )
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
    // (known Bun bug BUN-118B). Ask the worker to exit cooperatively instead.
    this.requestWorkerShutdown(this.worker)
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
    // Don't call worker.terminate() — it can segfault in compiled Bun binaries.
    // Ask the old worker to exit after its current handler unwinds, then replace it.
    this.requestWorkerShutdown(this.worker)
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

  private failRequest(id: string, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId)
    }
    this.pending.delete(id)
    pending.reject(error)
  }

  private handleRequestTimeout(id: string, generation: number): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }

    const error = new SessionRefreshWorkerTimeoutError()
    this.failGeneration(generation, error)
    this.restartWorker(generation)
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

  private requestWorkerShutdown(worker: Worker | null): void {
    if (!worker) return
    try {
      worker.postMessage({
        id: `shutdown-${Date.now()}-${this.counter++}`,
        kind: 'shutdown',
      } satisfies RefreshWorkerRequest)
    } catch {
      // Ignore postMessage failures from already-crashed workers.
    }
  }
}
