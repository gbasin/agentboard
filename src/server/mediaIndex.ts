/** Worker-owned disk index. Live metadata never contains descriptor collections. */
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSessionRecord } from './db'
import type { SessionMedia } from '../shared/types'
import { MEDIA_PAGE_BYTES, MEDIA_PAGE_ITEMS, type MediaPage, type MediaSummary, type MediaNeighbors, type MediaQuery } from '../shared/media'
import { scanMediaFile } from './mediaIndexScan'
import { parseMediaAnchor, MediaNeighborError } from './mediaAnchor'

export class MediaCursorError extends Error {
  constructor(readonly code: 'INVALID_CURSOR' | 'STALE_CURSOR') {
    super(code === 'STALE_CURSOR' ? 'Media changed. Refresh to continue browsing.' : 'Invalid media cursor')
    this.name = 'MediaCursorError'
  }
}

type SessionRow = MediaSummary & { generation: string; version: number; omittedRecords: number }
type ItemRow = { id: number; time: number; path: string; offset: number; item: number; descriptor: string }
type Cursor = { query?: string; identity: string; generation: string; watermark: number; revision: string; total: number; after: [number, string, number, number] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const mediaIdentity = (record: Pick<AgentSessionRecord, 'sessionId' | 'logFilePath' | 'agentType'>) =>
  hash(JSON.stringify([record.sessionId, record.logFilePath, record.agentType]))

export class MediaIndex {
  private db: Database
  private incarnation: string

  constructor(filename: string) {
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
    this.db.query('INSERT OR IGNORE INTO media_meta VALUES(1,?)').run(randomUUID())
    this.incarnation = (this.db.query('SELECT incarnation FROM media_meta WHERE id=1').get() as { incarnation: string }).incarnation
  }

  close() { this.db.close() }

  /** Payload digest mismatch proved the append checkpoints missed a rewrite. */
  invalidate(record: AgentSessionRecord) {
    const identity = mediaIdentity(record)
    this.db.transaction(() => {
      this.db.query('DELETE FROM media_files WHERE identity=?').run(identity)
      this.db.query('DELETE FROM media_items WHERE identity=?').run(identity)
      this.db.query(`UPDATE media_sessions SET generation=?,version=version+1,
        total=0,images=0,documents=0,links=0,omittedRecords=0 WHERE identity=?`).run(randomUUID(), identity)
    })()
  }

  scan(record: AgentSessionRecord, paths: string[]): MediaSummary {
    const identity = mediaIdentity(record)
    this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO media_sessions(identity,generation) VALUES(?,?)').run(identity, randomUUID())
      let changed = false, destructive = false, additions = 0, omittedRecords = 0
      const known = this.db.query('SELECT path,state FROM media_files WHERE identity=?').all(identity) as { path: string; state: string }[]
      const sources = [...new Set(paths)].sort()
      const deletePath = (file: string) => {
        this.db.query('DELETE FROM media_items WHERE identity=? AND path=?').run(identity, file)
        this.db.query('DELETE FROM media_files WHERE identity=? AND path=?').run(identity, file)
        changed = true; destructive = true
      }
      for (const file of known) if (!sources.includes(file.path)) deletePath(file.path)
      for (const file of sources) {
        const previous = known.find(row => row.path === file)
        const state = scanMediaFile(file, previous ? JSON.parse(previous.state) : undefined, () => deletePath(file),
          (entry, key, digest, time) => {
            const descriptor: SessionMedia = {
              kind: entry.kind,
              ...(entry.url ? { externalUrl: entry.url.slice(0, 2048) } : {}),
              ...(entry.sourceText ? { sourceText: entry.sourceText } : {}),
              url: `/api/session-media/${encodeURIComponent(record.sessionId)}?path=${encodeURIComponent(file)}&offset=${entry.offset}&index=${entry.index}&digest=${digest}`,
              ...(entry.mediaType ? { mediaType: entry.mediaType.slice(0, 128) } : {}),
              ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
              ...(entry.label ? { label: entry.label.slice(0, 512) } : {}),
              ...(entry.width ? { width: entry.width, height: entry.height } : {}),
            }
            const inserted = this.db.query(`INSERT OR IGNORE INTO media_items
              (identity,path,offset,item,time,content_key,kind,descriptor) VALUES(?,?,?,?,?,?,?,?)`)
              .run(identity, file, entry.offset, entry.index, time, key, entry.kind, JSON.stringify(descriptor))
            if (inserted.changes) {
              changed = true
              additions += this.db.query('INSERT OR IGNORE INTO media_seen VALUES(?,?,?)').run(identity, file, key).changes
            }
          })
        if (state) {
          omittedRecords += state.omittedRecords ?? 0
          this.db.query('INSERT OR REPLACE INTO media_files VALUES(?,?,?)').run(identity, file, JSON.stringify(state))
        }
      }
      if (omittedRecords !== this.row(identity).omittedRecords) changed = true
      if (changed) {
        const counts = this.db.query(`SELECT count(*) AS total, coalesce(sum(kind='image'),0) AS images,
          coalesce(sum(kind='document'),0) AS documents, coalesce(sum(kind='link'),0) AS links
          FROM media_items WHERE identity=?`).get(identity) as Pick<MediaSummary, 'total' | 'images' | 'documents' | 'links'>
        this.db.query(`UPDATE media_sessions SET version=version+1,total=?,images=?,documents=?,links=?,
          additions=additions+?,omittedRecords=?,generation=CASE WHEN ? THEN ? ELSE generation END WHERE identity=?`)
          .run(counts.total, counts.images, counts.documents, counts.links, additions, omittedRecords, destructive ? 1 : 0, randomUUID(), identity)
      }
    })()
    return this.summary(identity)
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
      ...(row.omittedRecords ? { omittedRecords: row.omittedRecords } : {}) }
  }

  /** Two indexed seeks skip any number of nonimages without loading intervening pages. */
  neighbors(record: AgentSessionRecord, anchor: string): MediaNeighbors {
    const ref = parseMediaAnchor(record.sessionId, anchor)
    const identity = mediaIdentity(record)
    const current = this.db.query(`SELECT id,time,path,offset,item,descriptor FROM media_items
      WHERE identity=? AND path=? AND offset=? AND item=? LIMIT 1`)
      .get(identity, ref.path, ref.offset, ref.index) as ItemRow | null
    if (!current) throw new MediaNeighborError('STALE_ANCHOR')
    const descriptor = JSON.parse(current.descriptor) as SessionMedia
    if (descriptor.url !== anchor) throw new MediaNeighborError('STALE_ANCHOR')
    if (descriptor.kind !== 'image') throw new MediaNeighborError('INVALID_ANCHOR')
    const adjacent = (direction: 'previous' | 'next'): SessionMedia | null => {
      const operator = direction === 'previous' ? '<' : '>'
      const order = direction === 'previous' ? 'DESC' : 'ASC'
      const row = this.db.query(`SELECT descriptor FROM media_items
        WHERE identity=? AND kind='image' AND (time,path,offset,item)${operator}(?,?,?,?)
        ORDER BY time ${order},path ${order},offset ${order},item ${order} LIMIT 1`)
        .get(identity, current.time, current.path, current.offset, current.item) as { descriptor: string } | null
      return row ? JSON.parse(row.descriptor) as SessionMedia : null
    }
    const summary = this.summary(identity)
    const result: MediaNeighbors = { identity, revision: summary.revision, current: descriptor,
      previous: adjacent('previous'), next: adjacent('next') }
    if (Buffer.byteLength(JSON.stringify(result)) > MEDIA_PAGE_BYTES) throw Error('Image navigation exceeded byte budget')
    return result
  }

  page(record: AgentSessionRecord, rawCursor?: string, query: MediaQuery = {}): MediaPage {
    const queryKey = JSON.stringify([query.kind ?? '', query.search ?? ''])
    const filter = query.kind === 'links' ? " AND kind='link'" : query.kind === 'media' ? " AND kind!='link'" : ''
    const search = (query.search ?? '').toLowerCase()
    const where = filter + " AND (?='' OR instr(lower(coalesce(json_extract(descriptor,'$.label'),'') || ' ' || coalesce(json_extract(descriptor,'$.externalUrl'),'') || ' ' || coalesce(json_extract(descriptor,'$.sourceText'),'')),?)>0)"

    const identity = mediaIdentity(record)
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
      if ((cursor.query ?? JSON.stringify(['', ''])) !== queryKey) throw new MediaCursorError('INVALID_CURSOR')
      if (cursor.identity !== identity || cursor.generation !== row.generation ||
          !cursor.revision.startsWith(this.incarnation + ':')) throw new MediaCursorError('STALE_CURSOR')
    } else {
      const watermark = (this.db.query('SELECT coalesce(max(id),0) AS id FROM media_items WHERE identity=?').get(identity) as { id: number }).id
      const total = (this.db.query(`SELECT count(*) AS total FROM media_items WHERE identity=? AND id<=? ${where}`)
        .get(identity, watermark, search, search) as { total: number }).total
      cursor = { query: queryKey, identity, generation: row.generation, watermark, revision: summary.revision, total,
        after: [-Number.MAX_SAFE_INTEGER, '', -1, -1] }
    }
    const rows = this.db.query(`SELECT id,time,path,offset,item,descriptor FROM media_items
      WHERE identity=? AND id<=? AND (time,path,offset,item)>(?,?,?,?) ${where}
      ORDER BY time,path,offset,item LIMIT ?`).all(identity, cursor.watermark, ...cursor.after, search, search, MEDIA_PAGE_ITEMS + 1) as ItemRow[]
    const result: MediaPage = { identity, revision: cursor.revision, total: cursor.total, items: [], nextCursor: null }
    const encode = (after: Cursor['after']) => Buffer.from(JSON.stringify({ ...cursor, after })).toString('base64url')
    for (let i = 0; i < rows.length && i < MEDIA_PAGE_ITEMS; i++) {
      const item = rows[i]
      const after: Cursor['after'] = [item.time, item.path, item.offset, item.item]
      const next = i + 1 < rows.length ? encode(after) : null
      const descriptor = JSON.parse(item.descriptor) as SessionMedia
      const candidate = { ...result, items: [...result.items, descriptor], nextCursor: next }
      if (Buffer.byteLength(JSON.stringify(candidate)) > MEDIA_PAGE_BYTES) {
        if (!result.items.length) throw Error('Media descriptor exceeds page byte budget')
        break
      }
      result.items.push(descriptor)
      result.nextCursor = next
    }
    return result
  }
}
