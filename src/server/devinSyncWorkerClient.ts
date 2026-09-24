/**
 * Client for the devin sync worker.
 * Keeps sessions.db mirroring off the main thread; see devinSyncWorker.ts.
 */
import type { DevinSyncResult } from './devinSync'
import { logger } from './logger'
import type {
  DevinSyncWorkerRequest,
  DevinSyncWorkerResponse,
} from './devinSyncWorker'

interface PendingRequest {
  generation: number
  resolve: (response: DevinSyncWorkerResponse) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

// The sync reads every message_nodes row per session — on a large sessions.db
// under memory pressure that legitimately takes tens of seconds. Past this we
// only warn: the request stays pending until the worker replies. Restarting
// instead (terminate() is off the table, so the old worker keeps running its
// queued sync) would let a second worker append the same rows to the same
// JSONL mirrors and race on the shared temp-file path.
const DEVIN_SYNC_SLOW_MS = 120_000

export interface DevinSyncResponse {
  result: DevinSyncResult | null
  durationMs: number
}

export class DevinSyncWorkerClient {
  private worker: Worker | null = null
  private disposed = false
  private counter = 0
  private generation = 0
  private pending = new Map<string, PendingRequest>()

  constructor(private slowAfterMs: number = DEVIN_SYNC_SLOW_MS) {}

  async sync(outDir: string): Promise<DevinSyncResponse> {
    if (this.disposed) {
      throw new Error('Devin sync worker is disposed')
    }
    if (!this.worker) {
      this.spawnWorker()
    }

    const id = `${Date.now()}-${this.counter++}`
    const generation = this.generation
    const payload: DevinSyncWorkerRequest = { id, kind: 'sync', outDir }

    return new Promise<DevinSyncResponse>((resolve, reject) => {
      const startedAt = Date.now()
      const timeoutId = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        pending.timeoutId = null
        logger.warn('devin_sync_slow', {
          elapsedMs: Date.now() - startedAt,
          slowAfterMs: this.slowAfterMs,
        })
      }, this.slowAfterMs)

      this.pending.set(id, {
        generation,
        resolve: (response) => {
          if (response.type === 'result') {
            resolve({ result: response.result, durationMs: response.durationMs })
          } else {
            reject(new Error(response.error))
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
    this.failAll(new Error('Devin sync worker disposed'))
    // Don't call worker.terminate() — it triggers a segfault in compiled Bun
    // binaries (known Bun bug BUN-118B). Ask the worker to exit cooperatively.
    this.requestWorkerShutdown(this.worker)
    this.detachWorker(this.worker)
    this.worker = null
  }

  private spawnWorker(): void {
    if (this.disposed) return
    // Compiled Bun binaries need string paths; dev mode needs URL resolution
    const workerPath = import.meta.url.includes('$bunfs')
      ? './devinSyncWorker.ts'
      : new URL('./devinSyncWorker.ts', import.meta.url).href
    const worker = new Worker(workerPath, {
      type: 'module',
    })
    const generation = ++this.generation
    worker.onmessage = (event) => {
      this.handleMessage(generation, event.data as DevinSyncWorkerResponse)
    }
    worker.onerror = (event) => {
      if (generation !== this.generation) return
      const message =
        event instanceof ErrorEvent ? event.message : 'Devin sync worker error'
      this.failGeneration(generation, new Error(message))
      this.restartWorker(generation)
    }
    worker.onmessageerror = () => {
      if (generation !== this.generation) return
      this.failGeneration(generation, new Error('Devin sync worker message error'))
      this.restartWorker(generation)
    }
    this.worker = worker
  }

  private restartWorker(expectedGeneration?: number): void {
    if (this.disposed) return
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) {
      return
    }
    this.requestWorkerShutdown(this.worker)
    this.detachWorker(this.worker)
    this.worker = null
  }

  private handleMessage(generation: number, response: DevinSyncWorkerResponse): void {
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

  private requestWorkerShutdown(worker: Worker | null): void {
    if (!worker) return
    try {
      worker.postMessage({
        id: `shutdown-${Date.now()}-${this.counter++}`,
        kind: 'shutdown',
      } satisfies DevinSyncWorkerRequest)
    } catch {
      // Ignore postMessage failures from already-crashed workers.
    }
  }
}
