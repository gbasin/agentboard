/**
 * Client for the session refresh worker.
 * Provides async interface for refreshing session list off the main thread.
 */
import type { Session } from '../shared/types'
import type { RefreshWorkerRequest, RefreshWorkerResponse } from './sessionRefreshWorker'

interface PendingRequest {
  resolve: (response: RefreshWorkerResponse) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

const DEFAULT_TIMEOUT_MS = 10000

export class SessionRefreshWorkerClient {
  private worker: Worker | null = null
  private disposed = false
  private counter = 0
  private pending = new Map<string, PendingRequest>()

  constructor() {
    this.spawnWorker()
  }

  async refresh(
    managedSession: string,
    discoverPrefixes: string[]
  ): Promise<Session[]> {
    if (this.disposed) {
      throw new Error('Session refresh worker is disposed')
    }
    if (!this.worker) {
      this.spawnWorker()
    }

    const id = `${Date.now()}-${this.counter++}`
    const payload: RefreshWorkerRequest = {
      id,
      kind: 'refresh',
      managedSession,
      discoverPrefixes,
    }

    return new Promise<Session[]>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Session refresh worker timed out'))
      }, DEFAULT_TIMEOUT_MS)

      this.pending.set(id, {
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
    const payload: RefreshWorkerRequest = {
      id,
      kind: 'last-user-message',
      tmuxWindow,
      scrollbackLines,
    }

    return new Promise<string | null>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Session refresh worker timed out'))
      }, DEFAULT_TIMEOUT_MS)

      this.pending.set(id, {
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
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
  }

  private spawnWorker(): void {
    if (this.disposed) return
    const worker = new Worker(
      new URL('./sessionRefreshWorker.ts', import.meta.url).href,
      { type: 'module' }
    )
    worker.onmessage = (event) => {
      this.handleMessage(event.data as RefreshWorkerResponse)
    }
    worker.onerror = (event) => {
      const message =
        event instanceof ErrorEvent ? event.message : 'Session refresh worker error'
      this.failAll(new Error(message))
      this.restartWorker()
    }
    worker.onmessageerror = () => {
      this.failAll(new Error('Session refresh worker message error'))
      this.restartWorker()
    }
    this.worker = worker
  }

  private restartWorker(): void {
    if (this.disposed) return
    if (this.worker) {
      this.worker.terminate()
    }
    this.worker = null
    this.spawnWorker()
  }

  private handleMessage(response: RefreshWorkerResponse): void {
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
}
