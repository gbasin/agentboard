/** Cached discovery state, independent snapshot reads, and fair checkpoint scheduling. */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config } from './config'
import { DiscoveryRpc } from './mediaDiscoveryRpc'
import type { AgentSessionRecord } from './db'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import { MEDIA_STREAM_MS, MEDIA_STREAM_BYTES, type MediaSummary, type MediaPage, type MediaNeighbors, type MediaQuery, type MediaStreamEvent } from '../shared/media'
import { logger } from './logger'
const identity = (r: AgentSessionRecord) => createHash('sha256').update(JSON.stringify([r.sessionId, r.logFilePath, r.agentType])).digest('hex')
type Job = { record: AgentSessionRecord; force?: boolean; started?: boolean; again?: boolean }
export type MediaDiscoveryRpc = Pick<DiscoveryRpc, 'request' | 'whenIdle' | 'dispose' | 'exited'>
type RpcFactory = (name: string, timeout: number, failed: (message: string) => void) => MediaDiscoveryRpc
export class MediaDiscoveryClient {
  private writer?: MediaDiscoveryRpc
  private reader?: MediaDiscoveryRpc
  private createRpc: RpcFactory
  private opening?: Promise<void>
  private writerReady = false
  private readerReady = false
  private sentLinks: CodexSubagentLink[] | undefined
  private foregroundSlices = 0
  private stopped = false
  private busy = false
  private cache = new Map<string, MediaSummary>()
  private announced = new Map<string, MediaSummary>()
  private hydration = new Map<string, AgentSessionRecord>()
  private hydrated = new Set<string>()
  private hydrating = false
  private jobs = new Map<string, Job>()
  private listeners = new Map<string, Set<() => void>>()
  private links: CodexSubagentLink[] = []
  private indexGeneration = 0
  private completed = new Map<string, { size: number | null; generation: number; at: number }>()
  private publications = new Map<string, { record: AgentSessionRecord; summary: MediaSummary; timer: ReturnType<typeof setTimeout> }>()
  private timeout: number
  private indexPath: string
  constructor(private changed: (record: AgentSessionRecord, summary: MediaSummary) => void,
    options: { indexPath?: string; requestTimeoutMs?: number; createRpc?: RpcFactory } = {}) {
    this.createRpc = options.createRpc ?? ((name, timeout, failed) => new DiscoveryRpc(name, timeout, failed))
    this.timeout = options.requestTimeoutMs ?? 30_000
    this.indexPath = options.indexPath ?? path.join(config.dataDir, 'media-index.sqlite')
  }
  get(record: AgentSessionRecord): MediaSummary {
    const key = identity(record)
    return this.cache.get(key) ?? { identity: key, revision: 'pending', total: 0, images: 0, documents: 0, links: 0, additions: 0, discovery: { status: 'pending' } }
  }
  queue(record: AgentSessionRecord) {
    if (this.stopped) return
    const key = identity(record)
    if (!this.hydrated.has(key) && this.hydration.size < 5000) { this.hydration.set(key, record); void this.hydrate() }
    const completed = this.completed.get(key)
    const stale = !completed || completed.size !== record.lastKnownLogSize || completed.generation !== this.indexGeneration || performance.now() - completed.at >= 30_000
    if (this.jobs.has(key) || (record.currentWindow !== null && stale)) this.enqueue(record)
  }
  private async open() {
    if (this.stopped) throw Error('Media discovery disposed')
    if (!this.opening) this.opening = (async () => {
      if (!this.writer || this.writer.exited) {
        this.writerReady = false; this.sentLinks = undefined
        for (const job of this.jobs.values()) job.started = false
        this.writer = this.createRpc('mediaDiscoveryWriterWorker', this.timeout, message => this.workerFailed(message))
      }
      if (!this.writerReady) {
        if (this.stopped) throw Error('Media discovery disposed')
        await this.writer.request({ kind: 'open', path: this.indexPath })
        this.writerReady = true
      }
      if (this.stopped) throw Error('Media discovery disposed')
      if (!this.reader || this.reader.exited) {
        this.readerReady = false
        this.reader = this.createRpc('mediaDiscoveryReaderWorker', this.timeout, message => this.workerFailed(message))
      }
      if (!this.readerReady) {
        if (this.stopped) throw Error('Media discovery disposed')
        await this.reader.request({ kind: 'open', path: this.indexPath })
        this.readerReady = true
      }
    })().finally(() => { this.opening = undefined })
    await this.opening
  }
  private async hydrate() {
    if (this.hydrating || this.stopped) return
    this.hydrating = true
    try {
      await this.open()
      while (this.hydration.size && !this.stopped) {
        const [key, record] = this.hydration.entries().next().value!
        this.hydration.delete(key)
        const response = await this.reader!.request({ kind: 'summary', record })
        // A writer notification may have overtaken this read.
        if (!this.cache.has(key)) {
          const summary = response.value as MediaSummary
          this.publish(record, summary.discovery?.status === 'indexing' ? { ...summary, discovery: { status: 'pending' } } : summary)
        }
        this.hydrated.add(key)
        if (this.hydrated.size > 5000) this.hydrated.delete(this.hydrated.values().next().value!)
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    } catch (error) { logger.warn('media_hydration_failed', { message: String(error) }) }
    finally { this.hydrating = false }
  }
  async page(record: AgentSessionRecord, cursor?: string, query?: MediaQuery): Promise<MediaPage> {
    await this.open()
    const response = await this.reader!.request({ kind: 'page', record, cursor, query })
    return response.value as MediaPage
  }
  async neighbors(record: AgentSessionRecord, anchor: string): Promise<MediaNeighbors> {
    await this.open()
    return (await this.reader!.request({ kind: 'neighbors', record, anchor })).value as MediaNeighbors
  }
  private enqueue(record: AgentSessionRecord, force = false) {
    if (this.stopped) return
    const key = identity(record), previous = this.jobs.get(key)
    if (previous) {
      if (force) previous.force = true
      if (previous.record.lastKnownLogSize !== record.lastKnownLogSize) previous.again = true
      previous.record = { ...record }
      void this.pump()
      return
    }
    if (this.jobs.size >= 5000) return
    this.jobs.set(key, { record: { ...record }, force })
    void this.pump()
  }
  private async pump() {
    if (this.busy || this.stopped || !this.jobs.size) return
    this.busy = true
    try {
      await this.open()
      while (this.jobs.size && !this.stopped) {
        const entries = [...this.jobs.entries()]
        // At most 32 retained scanner jobs; start new work only as slots free.
        const running = entries.filter(([, job]) => job.started).length
        const waitingView = entries.find(([key, job]) => !job.started && this.listeners.has(key))
        if (running >= 32 && waitingView) {
          const background = entries.find(([key, job]) => job.started && !this.listeners.has(key))
          if (background) {
            const [, job] = background
            const response = await this.writer!.request({ kind: 'cancel', record: job.record })
            job.started = false
            this.publish(job.record, response.value as MediaSummary)
            continue
          }
        }
        const eligible = entries.filter(([, job]) => job.started || running < 32)
        const foreground = eligible.find(([key]) => this.listeners.has(key))
        const background = eligible.find(([key]) => !this.listeners.has(key))
        const selected = foreground && (this.foregroundSlices < 4 || !background) ? foreground : background ?? foreground
        if (selected === foreground) this.foregroundSlices++
        else this.foregroundSlices = 0
        if (!selected) break
        const [key, job] = selected
        this.jobs.delete(key); this.jobs.set(key, job)
        if (job.record.currentWindow === null && !this.listeners.has(key)) {
          if (job.started) {
            const response = await this.writer!.request({ kind: 'cancel', record: job.record })
            this.publish(job.record, response.value as MediaSummary)
          }
          this.jobs.delete(key); continue
        }
        const force = job.force; job.force = false; job.started = true
        const began = performance.now()
        try {
          const links = this.sentLinks === this.links ? undefined : this.links
          const response = await this.writer!.request({ kind: 'step', record: job.record, force, links })
          if (links) this.sentLinks = links
          const rerun = response.done && (job.again || job.force)
          this.publish(job.record, rerun ? { ...(response.value as MediaSummary), discovery: { status: 'pending' } } : response.value as MediaSummary)
          if (response.done) {
            if (rerun) { job.started = false; job.again = false }
            else {
              this.jobs.delete(key)
              this.completed.delete(key)
              this.completed.set(key, { size: job.record.lastKnownLogSize, generation: this.indexGeneration, at: performance.now() })
              if (this.completed.size > 5000) this.completed.delete(this.completed.keys().next().value!)
            }
          }
          if (performance.now() - began > 1000) logger.info('media_discovery_slow_step', { elapsedMs: Math.round(performance.now() - began) })
        } catch (error) {
          const timedOut = (error as { code?: string }).code === 'MEDIA_TIMEOUT'
          if (!timedOut) this.jobs.delete(key)
          this.publish(job.record, { ...this.get(job.record), discovery: { status: 'failed', message: 'Media discovery failed. Retry to continue.' } })
          logger.warn('media_discovery_failed', { message: String(error) })
          if (timedOut) await this.writer!.whenIdle()
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    } catch (error) {
      this.workerFailed(String(error))
      if ((error as { code?: string }).code === 'MEDIA_TIMEOUT') {
        await this.writer?.whenIdle()
        this.busy = false
        if (!this.stopped) setTimeout(() => void this.pump(), 0)
      }
    }
    finally { this.busy = false }
  }
  private publish(record: AgentSessionRecord, summary: MediaSummary) {
    if (this.stopped) return
    const key = identity(record)
    this.cache.delete(key); this.cache.set(key, summary)
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!)
    const queued = this.publications.get(key)
    const announced = queued?.summary ?? this.announced.get(key)
    // Progress belongs to the open panel stream, not full history broadcasts.
    const useful = summary.discovery?.status !== 'indexing' || !announced || (!announced.total && summary.total > 0)
    if (useful && JSON.stringify(announced) !== JSON.stringify(summary)) {
      if (queued) { queued.record = record; queued.summary = summary }
      else {
        const timer = setTimeout(() => {
          const entry = this.publications.get(key)
          this.publications.delete(key)
          if (entry && !this.stopped) {
            this.announced.delete(key); this.announced.set(key, entry.summary)
            if (this.announced.size > 5000) this.announced.delete(this.announced.keys().next().value!)
            try { this.changed(entry.record, entry.summary) }
            catch (error) { logger.warn('media_publish_failed', { message: String(error) }) }
          }
        }, 250)
        this.publications.set(key, { record, summary, timer })
      }
    }
    // Completion must wake a view even if a warm scan found no changes.
    for (const listener of this.listeners.get(key) ?? []) listener()
  }
  private workerFailed(message: string) {
    for (const job of this.jobs.values()) this.publish(job.record, { ...this.get(job.record), discovery: { status: 'failed', message } })
  }
  invalidate(record: AgentSessionRecord) { this.enqueue(record, true) }
  setIndex(links: CodexSubagentLink[]) {
    if (JSON.stringify(links) === JSON.stringify(this.links)) return
    this.links = links; this.indexGeneration++
    for (const job of this.jobs.values()) job.again = true
  }
  dispose() { this.stopped = true; for (const entry of this.publications.values()) clearTimeout(entry.timer); this.publications.clear(); this.writer?.dispose(); this.reader?.dispose(); this.jobs.clear(); this.hydration.clear(); for (const set of this.listeners.values()) for (const wake of set) wake(); this.listeners.clear() }

  async *watch(record: AgentSessionRecord, cursor?: string, query?: MediaQuery, signal?: AbortSignal): AsyncIterable<MediaStreamEvent> {
    if (this.stopped || signal?.aborted) return
    const key = identity(record)
    if ([...this.listeners.values()].reduce((total, set) => total + set.size, 0) >= 32) throw Error('Too many media views')
    let wake: (() => void) | undefined, dirty = false
    const notify = () => { dirty = true; wake?.() }
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    listeners.add(notify); this.listeners.set(key, listeners)
    signal?.addEventListener('abort', notify)
    const deadline = performance.now() + MEDIA_STREAM_MS
    let bytes = 0
    try {
      let page = await this.page(record, cursor, query)
      let visible = page.items.length > 0
      const snapshot = { type: 'snapshot' as const, page: { ...page, discovery: page.discovery ?? { status: 'pending' as const } } }
      if (signal?.aborted) return
      bytes += Buffer.byteLength(JSON.stringify(snapshot)); yield snapshot
      if (signal?.aborted) return
      // Notifications received while reading/yielding the cached snapshot belong
      // to earlier work. An explicit view must observe a fresh filesystem check.
      dirty = false
      const existing = this.jobs.get(key)
      if (existing?.started) existing.again = true
      this.enqueue(record)
      while (!this.stopped && !signal?.aborted && performance.now() < deadline) {
        if (!dirty) await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(250, Math.max(1, deadline - performance.now())))
          wake = () => { clearTimeout(timer); resolve() }
        })
        wake = undefined
        if (this.stopped || signal?.aborted) break
        if (!dirty) continue
        dirty = false
        const summary = this.get(record)
        if (!visible) {
          page = await this.page(record, cursor, query)
          if (this.stopped || signal?.aborted) break
          if (page.items.length) {
            const event = { type: 'snapshot' as const, page: { ...page, discovery: page.discovery ?? summary.discovery! } }
            bytes += Buffer.byteLength(JSON.stringify(event)); if (bytes > MEDIA_STREAM_BYTES - 64) break
            yield event; visible = true
          }
        }
        if (this.stopped || signal?.aborted) break
        const progress = { type: 'progress' as const, summary: { ...summary, discovery: summary.discovery ?? { status: 'pending' as const } } }
        bytes += Buffer.byteLength(JSON.stringify(progress)); if (bytes > MEDIA_STREAM_BYTES - 64) break
        yield progress
        if (summary.discovery?.status === 'ready' || summary.discovery?.status === 'failed') break
        // Coalesce commits without retaining per-commit payloads.
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!this.stopped && !signal?.aborted) yield { type: 'done' }
    } finally {
      listeners.delete(notify)
      if (!listeners.size) this.listeners.delete(key)
      signal?.removeEventListener('abort', notify)
    }
  }
}
