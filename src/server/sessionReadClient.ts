import { resolveWorkerPath } from './workerPath'
/** One lazily opened read connection shared by polling and catalog import. */
import type { SessionReader, SnapshotOptions } from './sessionReads'
import type { ReadOperation, ReadRequest, ReadResponse, ReadResult } from './sessionReadWorker'
import { logger } from './logger'

interface Pending {
  resolve: (result: ReadResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SessionReadClient implements SessionReader {
  private worker: Worker | null = null
  private disposed = false
  private counter = 0
  private pending = new Map<number, Pending>()

  constructor(private readonly path: string) {
    if (!path || path === ':memory:') throw new Error('Read worker requires a file database')
  }

  async snapshot(options: SnapshotOptions) {
    const result = await this.request({ kind: 'snapshot', options })
    if (result.kind !== 'snapshot') throw new Error('Unexpected snapshot response')
    return result.snapshot
  }

  async importCandidates() {
    const result = await this.request({ kind: 'import' })
    if (result.kind !== 'import') throw new Error('Unexpected import response')
    return result.ids
  }

  dispose() {
    this.disposed = true
    this.failAll(new Error('Session read worker disposed'))
    this.retireWorker()
  }

  private request(operation: ReadOperation): Promise<ReadResult> {
    if (this.disposed) return Promise.reject(new Error('Session read worker disposed'))
    if (!this.worker) this.spawnWorker()
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      // Keep a slow read in flight rather than queuing replacement workers
      // behind the same disk stall. Callers coalesce polls/imports until done.
      const timer = setTimeout(() => {
        logger.warn('session_read_slow', { operation: operation.kind, elapsedMs: 30000 })
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.worker!.postMessage({ id, path: this.path, operation } satisfies ReadRequest)
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)))
        this.retireWorker()
      }
    })
  }

  private spawnWorker() {
    const workerPath = resolveWorkerPath('sessionReadWorker')
    const worker = new Worker(workerPath, { type: 'module' })
    this.worker = worker
    worker.onmessage = (event: MessageEvent<ReadResponse>) => {
      if (this.worker !== worker) return
      const response = event.data
      const pending = this.pending.get(response.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      if ('error' in response) pending.reject(new Error(response.error))
      else {
        logger.debug('session_read', { operation: response.result.kind, durationMs: response.durationMs })
        pending.resolve(response.result)
      }
    }
    const failed = (message: string) => {
      if (this.worker !== worker) return
      this.failAll(new Error(message))
      this.retireWorker()
    }
    worker.onerror = (event) => failed(event instanceof ErrorEvent ? event.message : 'Session read worker failed')
    worker.onmessageerror = () => failed('Session read worker message error')
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private retireWorker() {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    // terminate() can crash compiled Bun binaries. Close SQLite and exit
    // cooperatively after any current read finishes instead.
    try { worker.postMessage({ kind: 'shutdown' } satisfies ReadRequest) } catch { /* already exited */ }
  }
}
