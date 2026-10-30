/** Worker-owned disk index. Live metadata never contains descriptor collections. */
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSessionRecord } from './db'
import type { SessionMedia } from '../shared/types'
import { MEDIA_PAGE_BYTES, MEDIA_PAGE_ITEMS, type MediaPage, type MediaSummary, type MediaNeighbors, type MediaQuery } from '../shared/media'
import type { MediaScanBudget } from './mediaIndexScan'
import { MediaIndexWriter, type MediaScanJob } from './mediaIndexWriter'
export type { MediaScanJob } from './mediaIndexWriter'
import { parseMediaAnchor, MediaNeighborError } from './mediaAnchor'

export class MediaCursorError extends Error {
  constructor(readonly code: 'INVALID_CURSOR' | 'STALE_CURSOR') {
    super(code === 'STALE_CURSOR' ? 'Media changed. Refresh to continue browsing.' : 'Invalid media cursor')
    this.name = 'MediaCursorError'
  }
}

type SessionRow = Omit<MediaSummary, 'discovery'> & { generation: string; version: number; omittedRecords: number; omittedItems: number; discovery: string }
type ItemRow = { id: number; time: number; path: string; offset: number; item: number; descriptor: string; descriptor_version: number }
type Cursor = { query?: string; identity: string; generation: string; watermark: number; revision: string; total: number; after: [number, string, number, number] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const mediaIdentity = (record: Pick<AgentSessionRecord, 'sessionId' | 'logFilePath' | 'agentType'>) =>
  hash(JSON.stringify([record.sessionId, record.logFilePath, record.agentType]))

export class MediaIndex {
  private db: Database
  private incarnation: string
  private writer?: MediaIndexWriter

  constructor(filename: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(filename, { readonly: true })
      this.incarnation = (this.db.query('SELECT incarnation FROM media_meta WHERE id=1').get() as { incarnation: string }).incarnation
      return
    }
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true })
    this.db = new Database(filename, { create: true })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS media_meta (id INTEGER PRIMARY KEY, incarnation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_sessions (
        identity TEXT PRIMARY KEY, generation TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0,
        documents INTEGER NOT NULL DEFAULT 0, links INTEGER NOT NULL DEFAULT 0,
        additions INTEGER NOT NULL DEFAULT 0, omittedRecords INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS media_files (identity TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(identity,path));
      CREATE TABLE IF NOT EXISTS media_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, path TEXT NOT NULL,
        offset INTEGER NOT NULL, item INTEGER NOT NULL, time INTEGER NOT NULL, content_key TEXT NOT NULL,
        kind TEXT NOT NULL, descriptor TEXT NOT NULL, UNIQUE(identity,path,content_key));
      CREATE INDEX IF NOT EXISTS media_order ON media_items(identity,time,path,offset,item);
      CREATE INDEX IF NOT EXISTS media_image_order ON media_items(identity,kind,time,path,offset,item);
      CREATE INDEX IF NOT EXISTS media_anchor ON media_items(identity,path,offset,item);
      CREATE TABLE IF NOT EXISTS media_seen (identity TEXT NOT NULL, path TEXT NOT NULL, content_key TEXT NOT NULL,
        PRIMARY KEY(identity,path,content_key));`)
    if (!(this.db.query('PRAGMA table_info(media_sessions)').all() as { name: string }[]).some(row => row.name === 'omittedRecords')) {
      this.db.exec('ALTER TABLE media_sessions ADD COLUMN omittedRecords INTEGER NOT NULL DEFAULT 0')
    }
    for (const [column, type] of [['discovery', "TEXT NOT NULL DEFAULT '{\"status\":\"pending\"}'"], ['omittedItems', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!(this.db.query('PRAGMA table_info(media_sessions)').all() as { name: string }[]).some(row => row.name === column)) {
        this.db.exec(`ALTER TABLE media_sessions ADD COLUMN ${column} ${type}`)
      }
    }
    if (!(this.db.query('PRAGMA table_info(media_items)').all() as { name: string }[]).some(row => row.name === 'descriptor_version')) {
      this.db.exec('ALTER TABLE media_items ADD COLUMN descriptor_version INTEGER NOT NULL DEFAULT 0')
    }
    this.writer = new MediaIndexWriter(this.db)
    this.db.query('INSERT OR IGNORE INTO media_meta VALUES(1,?)').run(randomUUID())
    this.incarnation = (this.db.query('SELECT incarnation FROM media_meta WHERE id=1').get() as { incarnation: string }).incarnation
  }

  close() { this.db.close() }

  private writable(): MediaIndexWriter {
    if (!this.writer) throw Error('Media index is read-only')
    return this.writer
  }
  invalidate(record: AgentSessionRecord) { this.writable().invalidate(mediaIdentity(record)) }
  startScan(record: AgentSessionRecord, paths: string[], options: { force?: boolean } = {}): MediaScanJob {
    return this.writable().start(record, mediaIdentity(record), paths, options.force)
  }
  stepScan(job: MediaScanJob, budget: MediaScanBudget = {}): { summary: MediaSummary; done: boolean } {
    const done = this.writable().step(job, budget)
    return { summary: this.summary(job.identity), done }
  }
  cancelScan(job: MediaScanJob) { this.writable().cancel(job) }
  markFailed(record: AgentSessionRecord, message: string) {
    this.writable().setDiscovery(mediaIdentity(record), { status: 'failed', message: message.slice(0, 512) })
  }
  markPending(record: AgentSessionRecord) {
    this.writable().setDiscovery(mediaIdentity(record), { status: 'pending' })
  }
  scan(record: AgentSessionRecord, paths: string[]): MediaSummary {
    const job = this.startScan(record, paths)
    let result: ReturnType<MediaIndex['stepScan']>
    do { result = this.stepScan(job) } while (!result.done)
    return result.summary
  }
  getSummary(record: AgentSessionRecord): MediaSummary | undefined {
    const identity = mediaIdentity(record)
    return this.db.transaction(() => this.db.query('SELECT 1 FROM media_sessions WHERE identity=?').get(identity)
      ? this.summary(identity) : undefined)()
  }
  pendingSummary(record: AgentSessionRecord): MediaSummary {
    return { identity: mediaIdentity(record), revision: `${this.incarnation}:0`, total: 0, images: 0,
      documents: 0, links: 0, additions: 0, discovery: { status: 'pending' } }
  }

  private descriptor(row: { descriptor: string; descriptor_version: number }): SessionMedia {
    const descriptor = JSON.parse(row.descriptor) as SessionMedia
    // Legacy rows may contain a truncated URL. Never offer it as a copy target.
    if (!row.descriptor_version && (descriptor.externalUrl?.length ?? 0) >= 2048) delete descriptor.externalUrl
    return descriptor
  }

  private row(identity: string): SessionRow {
    const row = this.db.query('SELECT * FROM media_sessions WHERE identity=?').get(identity) as SessionRow | null
    if (!row) throw new MediaCursorError('STALE_CURSOR')
    return row
  }

  private summary(identity: string): MediaSummary {
    const row = this.row(identity)
    return { identity, revision: `${this.incarnation}:${row.version}`, total: row.total, images: row.images,
      documents: row.documents, links: row.links, additions: row.additions,
      discovery: JSON.parse(row.discovery),
      ...(row.omittedItems ? { omittedItems: row.omittedItems } : {}),
      ...(row.omittedRecords ? { omittedRecords: row.omittedRecords } : {}) }
  }

  /** Follow newest-first gallery order with two indexed seeks over nonimage gaps. */
  neighbors(record: AgentSessionRecord, anchor: string): MediaNeighbors {
    return this.db.transaction(() => this.readNeighbors(record, anchor))()
  }
  private readNeighbors(record: AgentSessionRecord, anchor: string): MediaNeighbors {
    const ref = parseMediaAnchor(record.sessionId, anchor)
    const identity = mediaIdentity(record)
    const current = this.db.query(`SELECT id,time,path,offset,item,descriptor,descriptor_version FROM media_items
      WHERE identity=? AND path=? AND offset=? AND item=? LIMIT 1`)
      .get(identity, ref.path, ref.offset, ref.index) as ItemRow | null
    if (!current) throw new MediaNeighborError('STALE_ANCHOR')
    const descriptor = this.descriptor(current)
    if (descriptor.url !== anchor) throw new MediaNeighborError('STALE_ANCHOR')
    if (descriptor.kind !== 'image') throw new MediaNeighborError('INVALID_ANCHOR')
    const adjacent = (direction: 'previous' | 'next'): SessionMedia | null => {
      const operator = direction === 'previous' ? '>' : '<'
      const order = direction === 'previous' ? 'ASC' : 'DESC'
      const row = this.db.query(`SELECT descriptor,descriptor_version FROM media_items
        WHERE identity=? AND kind='image' AND (time,path,offset,item)${operator}(?,?,?,?)
        ORDER BY time ${order},path ${order},offset ${order},item ${order} LIMIT 1`)
        .get(identity, current.time, current.path, current.offset, current.item) as { descriptor: string; descriptor_version: number } | null
      return row ? this.descriptor(row) : null
    }
    const summary = this.summary(identity)
    const result: MediaNeighbors = { identity, revision: summary.revision, current: descriptor,
      previous: adjacent('previous'), next: adjacent('next') }
    if (Buffer.byteLength(JSON.stringify(result)) > MEDIA_PAGE_BYTES) throw Error('Image navigation exceeded byte budget')
    return result
  }

  page(record: AgentSessionRecord, rawCursor?: string, query: MediaQuery = {}): MediaPage {
    return this.db.transaction(() => this.readPage(record, rawCursor, query))()
  }
  private readPage(record: AgentSessionRecord, rawCursor?: string, query: MediaQuery = {}): MediaPage {
    const queryKey = JSON.stringify(['newest', query.kind ?? '', query.search ?? ''])
    const filter = query.kind === 'links' ? " AND kind='link'" : query.kind === 'media' ? " AND kind!='link'" : ''
    const search = (query.search ?? '').toLowerCase()
    const where = filter + " AND (?='' OR instr(lower(coalesce(json_extract(descriptor,'$.label'),'') || ' ' || coalesce(json_extract(descriptor,'$.externalUrl'),'') || ' ' || coalesce(json_extract(descriptor,'$.sourceText'),'')),?)>0)"

    const identity = mediaIdentity(record)
    if (!this.db.query('SELECT 1 FROM media_sessions WHERE identity=?').get(identity)) {
      if (rawCursor) throw new MediaCursorError('STALE_CURSOR')
      const pending = this.pendingSummary(record)
      return { identity, revision: pending.revision, total: 0, discovery: pending.discovery, items: [], nextCursor: null }
    }
    const row = this.row(identity)
    const summary = this.summary(identity)
    let cursor: Cursor
    if (rawCursor) {
      try {
        if (rawCursor.length > 12000) throw Error()
        cursor = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'))
        if (!cursor || typeof cursor.identity !== 'string' || typeof cursor.generation !== 'string' ||
            typeof cursor.revision !== 'string' || !Number.isSafeInteger(cursor.watermark) || cursor.watermark < 0 ||
            !Number.isSafeInteger(cursor.total) || cursor.total < 0 || !Array.isArray(cursor.after) || cursor.after.length !== 4 ||
            !Number.isFinite(cursor.after[0]) || typeof cursor.after[1] !== 'string' || cursor.after[1].length > 4096 ||
            !Number.isSafeInteger(cursor.after[2]) || !Number.isSafeInteger(cursor.after[3])) throw Error()
      } catch { throw new MediaCursorError('INVALID_CURSOR') }
      if (cursor.query !== queryKey) throw new MediaCursorError('INVALID_CURSOR')
      if (cursor.identity !== identity || cursor.generation !== row.generation ||
          !cursor.revision.startsWith(this.incarnation + ':')) throw new MediaCursorError('STALE_CURSOR')
    } else {
      const watermark = (this.db.query('SELECT coalesce(max(id),0) AS id FROM media_items WHERE identity=?').get(identity) as { id: number }).id
      const total = (this.db.query(`SELECT count(*) AS total FROM media_items WHERE identity=? AND id<=? ${where}`)
        .get(identity, watermark, search, search) as { total: number }).total
      cursor = { query: queryKey, identity, generation: row.generation, watermark, revision: summary.revision, total,
        after: [Number.MAX_SAFE_INTEGER, '', -1, -1] }
    }
    const rows = this.db.query(`SELECT id,time,path,offset,item,descriptor,descriptor_version FROM media_items
      WHERE identity=? AND id<=? AND (time,path,offset,item)<(?,?,?,?) ${where}
      ORDER BY time DESC,path DESC,offset DESC,item DESC LIMIT ?`).all(identity, cursor.watermark, ...cursor.after, search, search, MEDIA_PAGE_ITEMS + 1) as ItemRow[]
    const result: MediaPage = { identity, revision: cursor.revision, total: cursor.total, discovery: summary.discovery, ...(summary.omittedItems ? { omittedItems: summary.omittedItems } : {}), items: [], nextCursor: null }
    const encode = (after: Cursor['after']) => Buffer.from(JSON.stringify({ ...cursor, after })).toString('base64url')
    for (let i = 0; i < rows.length && i < MEDIA_PAGE_ITEMS; i++) {
      const item = rows[i]
      const after: Cursor['after'] = [item.time, item.path, item.offset, item.item]
      const next = i + 1 < rows.length ? encode(after) : null
      const descriptor = this.descriptor(item)
      const candidate = { ...result, items: [...result.items, descriptor], nextCursor: next }
      if (Buffer.byteLength(JSON.stringify(candidate)) > MEDIA_PAGE_BYTES - 512) {
        if (!result.items.length) {
          result.omittedItems = (result.omittedItems ?? 0) + 1
          result.nextCursor = next
          continue
        }
        break
      }
      result.items.push(descriptor)
      result.nextCursor = next
    }
    return result
  }
}
