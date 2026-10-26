/** Single writer's finite, resumable scan jobs; each step commits a bounded batch. */
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { AgentSessionRecord } from './db'
import type { SessionMedia } from '../shared/types'
import { MEDIA_PAGE_BYTES, type MediaDiscovery } from '../shared/media'
import { mediaFileSnapshot, scanMediaFileStep, type MediaFileSnapshot, type MediaFileState, type MediaScanBudget } from './mediaIndexScan'

export interface MediaScanJob {
  record: AgentSessionRecord
  identity: string
  sources: MediaFileSnapshot[]
  fileIndex: number
  bytesDone: number
  done: boolean
  /** In-process ownership fence; persisted checkpoints survive a new job/worker. */
  token: number
}
const DESCRIPTOR_BYTES = Math.floor(MEDIA_PAGE_BYTES / 4)
export class MediaIndexWriter {
  private serial = 0
  private jobs = new Map<string, number>()
  constructor(private db: Database) {}

  setDiscovery(identity: string, discovery: MediaDiscovery) {
    this.db.query('INSERT OR IGNORE INTO media_sessions(identity,generation) VALUES(?,?)').run(identity, randomUUID())
    this.db.query('UPDATE media_sessions SET discovery=? WHERE identity=?').run(JSON.stringify(discovery), identity)
  }
  invalidate(identity: string) {
    this.jobs.delete(identity)
    this.db.transaction(() => {
      this.db.query('DELETE FROM media_files WHERE identity=?').run(identity)
      this.db.query('DELETE FROM media_items WHERE identity=?').run(identity)
      this.db.query(`UPDATE media_sessions SET generation=?,version=version+1,total=0,images=0,documents=0,
        links=0,omittedRecords=0,omittedItems=0,discovery=? WHERE identity=?`)
        .run(randomUUID(), JSON.stringify({ status: 'pending' }), identity)
    })()
  }
  start(record: AgentSessionRecord, identity: string, paths: string[], force = false): MediaScanJob {
    const sources = [...new Set(paths)].map(mediaFileSnapshot).sort((a, b) =>
      a.path === record.logFilePath ? -1 : b.path === record.logFilePath ? 1 : b.mtime - a.mtime || a.path.localeCompare(b.path))
    if (force) this.invalidate(identity)
    const job: MediaScanJob = { record: { ...record }, identity, sources, fileIndex: 0, bytesDone: 0, done: false, token: ++this.serial }
    this.jobs.set(identity, job.token)
    this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO media_sessions(identity,generation) VALUES(?,?)').run(identity, randomUUID())
      const known = this.db.query('SELECT path FROM media_files WHERE identity=?').all(identity) as { path: string }[]
      let removed = false
      for (const { path } of known) if (!sources.some(source => source.path === path)) { this.deletePath(identity, path); removed = true }
      if (removed) this.recount(identity, 0, true)
      this.progress(job)
    })()
    return job
  }
  cancel(job: MediaScanJob) {
    if (this.jobs.get(job.identity) !== job.token) return
    this.jobs.delete(job.identity)
    this.setDiscovery(job.identity, { status: 'pending' })
  }
  step(job: MediaScanJob, budget: MediaScanBudget = {}): boolean {
    if (job.done) return true
    if (this.jobs.get(job.identity) !== job.token) throw Error('Media scan superseded')
    const maxBytes = Math.max(1, budget.maxBytes ?? 1024 * 1024), maxMs = Math.max(1, budget.maxMs ?? 12)
    const started = performance.now()
    let read = 0, additions = 0, changed = false, destructive = false
    // Keep the in-memory cursor unchanged if SQLite rolls this batch back.
    const next = { ...job }
    this.db.transaction(() => {
      do {
        const source = next.sources[next.fileIndex]
        if (!source) break
        const row = this.db.query('SELECT state FROM media_files WHERE identity=? AND path=?').get(job.identity, source.path) as { state: string } | null
        const previous: MediaFileState | undefined = row ? JSON.parse(row.state) : undefined
        let omitted = 0
        const result = scanMediaFileStep(source, previous, () => {
          this.deletePath(job.identity, source.path); changed = true; destructive = true
        }, (entry, key, digest, time) => {
          const descriptor: SessionMedia = {
            kind: entry.kind, ...(entry.url ? { externalUrl: entry.url } : {}),
            ...(entry.sourceText ? { sourceText: entry.sourceText } : {}),
            url: `/api/session-media/${encodeURIComponent(job.record.sessionId)}?path=${encodeURIComponent(source.path)}&offset=${entry.offset}&index=${entry.index}&digest=${digest}`,
            ...(entry.mediaType ? { mediaType: entry.mediaType.slice(0, 128) } : {}),
            ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
            ...(entry.label ? { label: entry.label.slice(0, 512) } : {}),
            ...(entry.width ? { width: entry.width, height: entry.height } : {}),
          }
          const json = JSON.stringify(descriptor)
          // Explicit omission beats a page that can never advance. Three image
          // descriptors and response/cursor overhead must fit the shared budget.
          if (Buffer.byteLength(json) > DESCRIPTOR_BYTES) { omitted++; return }
          const inserted = this.db.query(`INSERT OR IGNORE INTO media_items
            (identity,path,offset,item,time,content_key,kind,descriptor,descriptor_version) VALUES(?,?,?,?,?,?,?,?,1)`)
            .run(job.identity, source.path, entry.offset, entry.index, time, key, entry.kind, json)
          if (inserted.changes) {
            changed = true
            additions += this.db.query('INSERT OR IGNORE INTO media_seen VALUES(?,?,?)').run(job.identity, source.path, key).changes
          }
        }, { maxBytes: maxBytes - read, maxMs: Math.max(1, maxMs - (performance.now() - started)) })
        read += result.bytesRead
        if (result.state) {
          result.state.omittedItems = (result.state.omittedItems ?? 0) + omitted
          if (omitted || (result.state.omittedRecords ?? 0) !== (previous?.omittedRecords ?? 0)) changed = true
          this.db.query('INSERT OR REPLACE INTO media_files VALUES(?,?,?)').run(job.identity, source.path, JSON.stringify(result.state))
        }
        if (!result.done) break
        next.bytesDone += source.size; next.fileIndex++
      } while (read < maxBytes && performance.now() - started < maxMs)
      next.done = next.fileIndex >= next.sources.length
      if (changed) this.recount(job.identity, additions, destructive)
      this.progress(next)
    })()
    Object.assign(job, next)
    if (job.done) this.jobs.delete(job.identity)
    return job.done
  }
  private deletePath(identity: string, file: string) {
    this.db.query('DELETE FROM media_items WHERE identity=? AND path=?').run(identity, file)
    this.db.query('DELETE FROM media_files WHERE identity=? AND path=?').run(identity, file)
  }
  private recount(identity: string, additions: number, destructive: boolean) {
    const counts = this.db.query(`SELECT count(*) AS total, coalesce(sum(kind='image'),0) AS images,
      coalesce(sum(kind='document'),0) AS documents, coalesce(sum(kind='link'),0) AS links
      FROM media_items WHERE identity=?`).get(identity) as { total: number; images: number; documents: number; links: number }
    const omissions = this.db.query(`SELECT coalesce(sum(json_extract(state,'$.omittedRecords')),0) AS records,
      coalesce(sum(json_extract(state,'$.omittedItems')),0) AS items FROM media_files WHERE identity=?`).get(identity) as { records: number; items: number }
    this.db.query(`UPDATE media_sessions SET version=version+1,total=?,images=?,documents=?,links=?,
      additions=additions+?,omittedRecords=?,omittedItems=?,generation=CASE WHEN ? THEN ? ELSE generation END WHERE identity=?`)
      .run(counts.total, counts.images, counts.documents, counts.links, additions, omissions.records, omissions.items, destructive ? 1 : 0, randomUUID(), identity)
  }
  private progress(job: MediaScanJob) {
    if (job.done) { this.setDiscovery(job.identity, { status: 'ready' }); return }
    const file = job.sources[job.fileIndex]
    const state = file ? this.db.query('SELECT state FROM media_files WHERE identity=? AND path=?').get(job.identity, file.path) as { state: string } | null : null
    const offset = state ? (JSON.parse(state.state) as MediaFileState).offset : 0
    this.setDiscovery(job.identity, { status: 'indexing', bytesRead: job.bytesDone + offset,
      bytesTotal: job.sources.reduce((n, source) => n + source.size, 0), filesDone: job.fileIndex, filesTotal: job.sources.length })
  }
}
