import type { Session } from '../shared/types'
import type { ExactMatchProfiler } from './logMatcher'
import type { LogEntrySnapshot } from './logPollData'
import type { SessionSnapshot } from './logMatchGate'

interface MatchWorkerSearchOptions {
  tailBytes?: number
  rgThreads?: number
  profile?: boolean
}

export interface MatchWorkerRequest {
  id: string
  windows: Session[]
  maxLogsPerPoll: number
  logDirs?: string[]
  sessions: SessionSnapshot[]
  scrollbackLines: number
  minTokensForMatch?: number
  search?: MatchWorkerSearchOptions
}

export interface MatchWorkerResponse {
  id: string
  type: 'result' | 'error'
  entries?: LogEntrySnapshot[]
  scanMs?: number
  sortMs?: number
  matchMs?: number
  matchWindowCount?: number
  matchLogCount?: number
  matchSkipped?: boolean
  matches?: Array<{ logPath: string; tmuxWindow: string }>
  profile?: ExactMatchProfiler
  error?: string
}

interface PendingRequest {
  resolve: (response: MatchWorkerResponse) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

const DEFAULT_TIMEOUT_MS = 15000

export class LogMatchWorkerClient {
  private worker: Worker | null = null
  private disposed = false
  private counter = 0
  private pending = new Map<string, PendingRequest>()

  constructor() {
    this.spawnWorker()
  }

  async poll(request: Omit<MatchWorkerRequest, 'id'>): Promise<MatchWorkerResponse> {
    if (this.disposed) {
      throw new Error('Log match worker is disposed')
    }
    if (!this.worker) {
      this.spawnWorker()
    }

    const id = `${Date.now()}-${this.counter++}`
    const payload: MatchWorkerRequest = { ...request, id }

    return new Promise<MatchWorkerResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Log match worker timed out'))
      }, DEFAULT_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timeoutId })
      this.worker?.postMessage(payload)
    })
  }

  dispose(): void {
    this.disposed = true
    this.failAll(new Error('Log match worker disposed'))
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
  }

  private spawnWorker(): void {
    if (this.disposed) return
    const worker = new Worker(new URL('./logMatchWorker.ts', import.meta.url).href, {
      type: 'module',
    })
    worker.onmessage = (event) => {
      this.handleMessage(event.data as MatchWorkerResponse)
    }
    worker.onerror = (event) => {
      const message = event instanceof ErrorEvent ? event.message : 'Log match worker error'
      this.failAll(new Error(message))
      this.restartWorker()
    }
    worker.onmessageerror = () => {
      this.failAll(new Error('Log match worker message error'))
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
