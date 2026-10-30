/** PR scans and progressive media discovery publish independently through one facade. */
import { resolveWorkerPath } from './workerPath'
import path from 'node:path'
import { config } from './config'
import { sanitizedTmuxEnv } from './tmuxEnv'
import type { MediaPage, MediaNeighbors, MediaQuery, MediaStreamEvent, MediaSummary } from '../shared/media'
import type { AgentSessionRecord } from './db'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import type { MetadataRequest, MetadataResponse, SessionMetadata } from './sessionMetadataWorker'
import { MediaDiscoveryClient } from './mediaDiscovery'
import { logger } from './logger'

export function metadataIdentity(record: Pick<AgentSessionRecord, 'sessionId' | 'logFilePath' | 'agentType'>): string {
  return JSON.stringify([record.sessionId, record.logFilePath, record.agentType])
}
export class MetadataScanSupersededError extends Error {
  readonly code = 'STALE_CURSOR'
  constructor() { super('Session log changed'); this.name = 'MetadataScanSupersededError' }
}
type MediaClient = Pick<MediaDiscoveryClient, 'get' | 'queue' | 'page' | 'neighbors' | 'watch' | 'invalidate' | 'setIndex' | 'dispose'>
type MediaFactory = (changed: (record: AgentSessionRecord, summary: MediaSummary) => void,
  options: { indexPath: string; requestTimeoutMs: number }) => MediaClient

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
  private associations = new Map<string, string>()
  private links: CodexSubagentLink[] = []
  private waiters = new Map<string, { minimumId: number; resolve: (value: SessionMetadata) => void; reject: (error: Error) => void }[]>()
  private readonly media: MediaClient

  constructor(
    private readonly changed: (record: AgentSessionRecord, metadata: SessionMetadata) => void,
    private readonly createWorker = (url: string) => new Worker(url, { type: 'module', env: sanitizedTmuxEnv() }),
    indexPath = path.join(config.dataDir, 'media-index.sqlite'),
    pageTimeoutMs = 30_000,
    createMedia: MediaFactory = (changed, options) => new MediaDiscoveryClient(changed, options),
  ) {
    this.media = createMedia((record, mediaSummary) => {
      if (!this.isCurrent(record)) return
      this.publish(record, { prs: this.cachedPrs(record), mediaSummary })
    }, { indexPath, requestTimeoutMs: pageTimeoutMs })
  }

  get(record: AgentSessionRecord): SessionMetadata {
    return { prs: this.cachedPrs(record), mediaSummary: this.media.get(record) }
  }

  queue(record: AgentSessionRecord) {
    if (this.stopped) return
    this.remember(record)
    this.media.queue(record)
    this.enqueue(record, false)
  }

  invalidate(record: AgentSessionRecord): void {
    if (!this.isCurrent(record)) return
    this.media.invalidate(record)
  }

  /** Persistence needs fresh PRs, but must never wait for media discovery. */
  scan(record: AgentSessionRecord): Promise<SessionMetadata> {
    if (this.stopped) return Promise.reject(new Error('Metadata worker disposed'))
    this.remember(record)
    this.media.queue(record)
    return new Promise((resolve, reject) => {
      const identity = metadataIdentity(record)
      const waiting = this.waiters.get(identity) ?? []
      waiting.push({ minimumId: this.serial + 1, resolve, reject })
      this.waiters.set(identity, waiting)
      this.enqueue(record, true)
    })
  }

  page(record: AgentSessionRecord, cursor?: string, query?: MediaQuery): Promise<MediaPage> {
    if (this.stopped) return Promise.reject(new Error('Metadata worker disposed'))
    this.remember(record)
    return this.media.page(record, cursor, query)
  }

  neighbors(record: AgentSessionRecord, anchor: string): Promise<MediaNeighbors> {
    if (this.stopped) return Promise.reject(new Error('Metadata worker disposed'))
    this.remember(record)
    return this.media.neighbors(record, anchor)
  }

  async *watch(record: AgentSessionRecord, cursor?: string, query?: MediaQuery, signal?: AbortSignal): AsyncIterable<MediaStreamEvent> {
    if (this.stopped) throw new Error('Metadata worker disposed')
    this.remember(record)
    yield* this.media.watch(record, cursor, query, signal)
  }

  setIndex(links: CodexSubagentLink[]) {
    if (this.stopped) return
    this.links = links
    this.media.setIndex(links)
    this.worker?.postMessage({ kind: 'index', links } satisfies MetadataRequest)
    if (this.current && !this.pending.has(this.current.record.sessionId)) this.pending.set(this.current.record.sessionId, this.current.record)
  }

  dispose() {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.rejectWaiters(new Error('Metadata worker disposed'))
    this.pending.clear()
    this.cache.clear()
    this.associations.clear()
    this.current = null
    this.media.dispose()
    this.retire()
  }

  private remember(record: AgentSessionRecord) {
    this.associations.delete(record.sessionId)
    this.associations.set(record.sessionId, metadataIdentity(record))
    if (this.associations.size > 5000) this.associations.delete(this.associations.keys().next().value!)
  }

  private isCurrent(record: AgentSessionRecord): boolean {
    const current = this.associations.get(record.sessionId)
    return !this.stopped && (current === undefined || current === metadataIdentity(record))
  }

  private cachedPrs(record: AgentSessionRecord) {
    const entry = this.cache.get(record.sessionId)
    return entry?.identity === metadataIdentity(record) ? entry.metadata.prs : []
  }

  private enqueue(record: AgentSessionRecord, fresh: boolean) {
    const running = this.current?.record
    if (!fresh && running?.sessionId === record.sessionId && metadataIdentity(running) === metadataIdentity(record) &&
        running.lastKnownLogSize === record.lastKnownLogSize && !this.pending.has(record.sessionId)) return
    const replaced = this.pending.get(record.sessionId)
    if (replaced && metadataIdentity(replaced) !== metadataIdentity(record)) {
      const identity = metadataIdentity(replaced)
      for (const waiter of this.waiters.get(identity) ?? []) waiter.reject(new MetadataScanSupersededError())
      this.waiters.delete(identity)
    }
    this.pending.set(record.sessionId, { ...record })
    this.schedule()
  }

  private schedule() {
    if (this.retryTimer || this.scheduled || this.current || this.stopped || !this.pending.size) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.pump() })
  }

  private pump() {
    if (this.retryTimer || this.current || this.stopped) return
    const records = [...this.pending.values()]
    const record = records.find(r => this.waiters.has(metadataIdentity(r))) ?? records.find(r => r.currentWindow !== null) ?? records[0]
    if (!record) return
    this.pending.delete(record.sessionId)
    this.current = { id: ++this.serial, record }
    try {
      if (!this.worker) this.spawn()
      this.worker!.postMessage({ kind: 'scan', ...this.current } satisfies MetadataRequest)
    } catch (error) { this.failed(String(error)) }
  }

  private spawn() {
    const worker = this.createWorker(resolveWorkerPath('sessionMetadataWorker'))
    this.worker = worker
    worker.onmessage = (event: MessageEvent<MetadataResponse>) => {
      if (this.worker !== worker || this.stopped) return
      const response = event.data, current = this.current
      if (!current || current.id !== response.id) return
      this.current = null
      this.retryDelayMs = 1000
      const { record } = current
      const result = 'error' in response ? null : { prs: response.metadata.prs, mediaSummary: this.media.get(record) }
      const waiting = this.waiters.get(metadataIdentity(record)) ?? []
      const later = waiting.filter(waiter => waiter.minimumId > response.id)
      if (later.length) this.waiters.set(metadataIdentity(record), later)
      else this.waiters.delete(metadataIdentity(record))
      for (const waiter of waiting) {
        if (waiter.minimumId > response.id) continue
        if (!this.isCurrent(record)) waiter.reject(new MetadataScanSupersededError())
        else if ('error' in response) waiter.reject(new Error(response.error))
        else waiter.resolve(result!)
      }
      if ('error' in response) logger.warn('session_metadata_scan_failed', { message: response.error })
      else if (this.isCurrent(record)) this.publish(record, result!)
      this.schedule()
    }
    worker.onerror = event => {
      if (this.worker === worker) this.failed(event instanceof ErrorEvent ? event.message : 'Metadata worker failed')
    }
    worker.onmessageerror = () => { if (this.worker === worker) this.failed('Metadata worker message error') }
    worker.postMessage({ kind: 'index', links: this.links } satisfies MetadataRequest)
  }

  private publish(record: AgentSessionRecord, metadata: SessionMetadata) {
    const cached = this.cache.get(record.sessionId)
    const previous = cached?.identity === metadataIdentity(record) ? cached.metadata : undefined
    this.cache.delete(record.sessionId)
    this.cache.set(record.sessionId, { identity: metadataIdentity(record), metadata })
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!)
    if (JSON.stringify(previous) !== JSON.stringify(metadata)) {
      try { this.changed(record, metadata) }
      catch (error) { logger.warn('session_metadata_publish_failed', { message: String(error) }) }
    }
  }

  private failed(message: string) {
    logger.warn('session_metadata_worker_failed', { message })
    const interrupted = this.current?.record
    if (interrupted && !this.pending.has(interrupted.sessionId)) this.pending.set(interrupted.sessionId, interrupted)
    this.current = null
    this.rejectWaiters(new Error(message))
    this.retire()
    if (!this.stopped && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.schedule() }, this.retryDelayMs)
      this.retryTimer.unref?.()
      this.retryDelayMs = Math.min(30000, this.retryDelayMs * 2)
    }
  }

  private rejectWaiters(error: Error) {
    for (const waiting of this.waiters.values()) for (const waiter of waiting) waiter.reject(error)
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
