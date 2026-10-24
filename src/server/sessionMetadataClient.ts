import { resolveWorkerPath } from './workerPath'
/** Coalesced background scans; cached values contain no authoritative session state. */
import type { AgentSessionRecord } from './db'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import type { MetadataRequest, MetadataResponse, SessionMetadata } from './sessionMetadataWorker'
import { logger } from './logger'

export function metadataIdentity(record: Pick<AgentSessionRecord, 'sessionId' | 'logFilePath' | 'agentType'>): string {
  return JSON.stringify([record.sessionId, record.logFilePath, record.agentType])
}
export class MetadataScanSupersededError extends Error {
  constructor() { super('Session log changed'); this.name = 'MetadataScanSupersededError' }
}
const EMPTY: SessionMetadata = { prs: [], media: [] }

export class SessionMetadataClient {
  private worker: Worker | null = null
  private stopped = false
  private scheduled = false
  private serial = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelayMs = 1000
  private pending = new Map<string, AgentSessionRecord>()
  private current: { id: number; record: AgentSessionRecord } | null = null
  private cache = new Map<string, { identity: string; metadata: SessionMetadata }>()
  private links: CodexSubagentLink[] = []
  private waiters = new Map<string, { minimumId: number; resolve: (value: SessionMetadata) => void; reject: (error: Error) => void }[]>()

  constructor(
    private readonly changed: (record: AgentSessionRecord, metadata: SessionMetadata) => void,
    private readonly createWorker = (url: string) => new Worker(url, { type: 'module' }),
  ) {}

  get(record: AgentSessionRecord): SessionMetadata {
    const entry = this.cache.get(record.sessionId)
    return entry?.identity === metadataIdentity(record) ? entry.metadata : EMPTY
  }

  queue(record: AgentSessionRecord) { this.enqueue(record, false) }

  private enqueue(record: AgentSessionRecord, fresh: boolean) {
    if (this.stopped) return
    const running = this.current?.record
    // A repeated view read is not new work. Growth or reassociation is.
    if (!fresh && running?.sessionId === record.sessionId &&
        metadataIdentity(running) === metadataIdentity(record) &&
        running.lastKnownLogSize === record.lastKnownLogSize &&
        !this.pending.has(record.sessionId)) return
    const replaced = this.pending.get(record.sessionId)
    if (replaced && metadataIdentity(replaced) !== metadataIdentity(record)) {
      const identity = metadataIdentity(replaced)
      for (const waiter of this.waiters.get(identity) ?? []) waiter.reject(new MetadataScanSupersededError())
      this.waiters.delete(identity)
    }
    this.pending.set(record.sessionId, { ...record })
    this.schedule()
  }

  /** HTTP detail reads await a fresh scan without blocking terminal traffic. */
  scan(record: AgentSessionRecord): Promise<SessionMetadata> {
    if (this.stopped) return Promise.reject(new Error('Metadata worker disposed'))
    return new Promise((resolve, reject) => {
      const identity = metadataIdentity(record)
      const waiting = this.waiters.get(identity) ?? []
      // A running scan may have captured the file before this HTTP request,
      // even if the DB's size has not caught up. Wait for a subsequent scan.
      waiting.push({ minimumId: this.serial + 1, resolve, reject })
      this.waiters.set(identity, waiting)
      this.enqueue(record, true)
    })
  }

  setIndex(links: CodexSubagentLink[]) {
    this.links = links
    this.worker?.postMessage({ kind: 'index', links } satisfies MetadataRequest)
    // An index update during a scan must cause another pass, even with unchanged sizes.
    if (this.current && !this.pending.has(this.current.record.sessionId)) {
      this.pending.set(this.current.record.sessionId, this.current.record)
    }
  }

  dispose() {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.rejectWaiters(new Error('Metadata worker disposed'))
    this.pending.clear()
    this.cache.clear()
    this.current = null
    this.retire()
  }

  private schedule() {
    if (this.retryTimer || this.scheduled || this.current || this.stopped || !this.pending.size) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private pump() {
    if (this.retryTimer || this.current || this.stopped) return
    const records = [...this.pending.values()]
    const record = records.find((r) => this.waiters.has(metadataIdentity(r))) ??
      records.find((r) => r.currentWindow !== null) ?? records[0]
    if (!record) return
    this.pending.delete(record.sessionId)
    this.current = { id: ++this.serial, record }
    try {
      if (!this.worker) this.spawn()
      this.worker!.postMessage({ kind: 'scan', ...this.current } satisfies MetadataRequest)
    } catch (error) { this.failed(String(error)) }
  }

  private spawn() {
    const workerPath = resolveWorkerPath('sessionMetadataWorker')
    const worker = this.createWorker(workerPath)
    this.worker = worker
    worker.onmessage = (event: MessageEvent<MetadataResponse>) => {
      if (this.worker !== worker || this.stopped) return
      const response = event.data
      const current = this.current
      if (!current || current.id !== response.id) return
      this.current = null
      this.retryDelayMs = 1000
      const { record } = current
      const waiting = this.waiters.get(metadataIdentity(record)) ?? []
      const later = waiting.filter((waiter) => waiter.minimumId > response.id)
      if (later.length) this.waiters.set(metadataIdentity(record), later)
      else this.waiters.delete(metadataIdentity(record))
      for (const waiter of waiting) {
        if (waiter.minimumId > response.id) continue
        if ('error' in response) waiter.reject(new Error(response.error))
        else waiter.resolve(response.metadata)
      }
      const next = this.pending.get(record.sessionId)
      if ('error' in response) {
        logger.warn('session_metadata_scan_failed', { message: response.error })
      } else if (!next || metadataIdentity(next) === metadataIdentity(record)) {
        const previous = this.get(record)
        this.cache.delete(record.sessionId)
        this.cache.set(record.sessionId, { identity: metadataIdentity(record), metadata: response.metadata })
        if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!)
        if (JSON.stringify(previous) !== JSON.stringify(response.metadata)) {
          try { this.changed(record, response.metadata) }
          catch (error) { logger.warn('session_metadata_publish_failed', { message: String(error) }) }
        }
      }
      this.schedule()
    }
    worker.onerror = (event) => {
      if (this.worker === worker) this.failed(event instanceof ErrorEvent ? event.message : 'Metadata worker failed')
    }
    worker.onmessageerror = () => {
      if (this.worker === worker) this.failed('Metadata worker message error')
    }
    worker.postMessage({ kind: 'index', links: this.links } satisfies MetadataRequest)
  }

  private failed(message: string) {
    logger.warn('session_metadata_worker_failed', { message })
    const interrupted = this.current?.record
    if (interrupted && !this.pending.has(interrupted.sessionId)) {
      this.pending.set(interrupted.sessionId, interrupted)
    }
    this.current = null
    this.rejectWaiters(new Error(message))
    this.retire()
    // Dormant rows may never be queued again by polling. Retain their work
    // and retry with bounded backoff; periodic active refreshes cannot bypass it.
    if (!this.stopped && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.schedule()
      }, this.retryDelayMs)
      this.retryTimer.unref?.()
      this.retryDelayMs = Math.min(30000, this.retryDelayMs * 2)
    }
  }

  private rejectWaiters(error: Error) {
    for (const waiting of this.waiters.values()) {
      for (const waiter of waiting) waiter.reject(error)
    }
    this.waiters.clear()
  }

  private retire() {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    try { worker.postMessage({ kind: 'shutdown' } satisfies MetadataRequest) } catch { /* already exited */ }
  }
}
