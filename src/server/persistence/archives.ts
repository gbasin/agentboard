/** Bounded, verified conversation copies, published only at complete JSONL records. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Database } from 'bun:sqlite'
import type { SessionDatabase, AgentSessionRecord } from '../db'
import type { ArchiveInfo } from '../../shared/persistence'
import { persistenceDirectory, publishFile, SessionBackups } from './backups'

interface ArchiveRow {
  provider_id: string
  source_path: string
  archive_path: string
  bytes: number
  source_size: number
  updated_at: string
  checksum: string
  complete: number
}
export class ConversationArchives {
  readonly directory: string
  error: string | null = null
  private backups: SessionBackups
  private backupSignature = ''
  private backupReferences = new Set<string>()
  constructor(
    private db: SessionDatabase,
    dbPath: string
  ) {
    this.directory = path.join(persistenceDirectory(dbPath), 'conversations')
    this.backups = new SessionBackups(db.db, dbPath)
  }
  get bytes() {
    if (!fs.existsSync(this.directory)) return 0
    return fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith('.jsonl'))
      .reduce(
        (sum, name) => sum + fs.statSync(path.join(this.directory, name)).size,
        0
      )
  }
  /** Retained database snapshots continue to reference their exact log versions. */
  private protectedFiles() {
    const backups = this.backups.list(),
      signature = backups.map((b) => b.name).join('|')
    if (signature === this.backupSignature) return this.backupReferences
    const references = new Set<string>()
    for (const backup of backups) {
      const snapshot = new Database(this.backups.resolve(backup.name), {
        readonly: true,
      })
      try {
        if (
          !snapshot
            .query("SELECT 1 FROM sqlite_master WHERE name='session_archives'")
            .get()
        )
          continue
        for (const row of snapshot
          .query('SELECT archive_path AS file FROM session_archives')
          .all() as { file: string }[])
          references.add(row.file)
      } finally {
        snapshot.close()
      }
    }
    this.backupSignature = signature
    this.backupReferences = references
    return references
  }
  prune() {
    if (!fs.existsSync(this.directory)) return
    const keep = new Set(this.protectedFiles())
    for (const row of this.db.db
      .query('SELECT archive_path AS file FROM session_archives')
      .all() as { file: string }[])
      keep.add(row.file)
    for (const name of fs.readdirSync(this.directory)) {
      const file = path.join(this.directory, name)
      if (
        !keep.has(file) &&
        (name.endsWith('.jsonl') || name.endsWith('.partial')) &&
        Date.now() - fs.statSync(file).mtimeMs > 3600000
      )
        fs.unlinkSync(file)
    }
  }
  row(id: string) {
    return this.db.db
      .query('SELECT * FROM session_archives WHERE provider_id=?')
      .get(id) as ArchiveRow | null
  }
  info(id: string): ArchiveInfo | null {
    const row = this.row(id)
    return row
      ? {
          providerId: id,
          bytes: row.bytes,
          updatedAt: row.updated_at,
          complete: Boolean(row.complete),
          sourceMissing: !fs.existsSync(row.source_path),
        }
      : null
  }
  pathFor(id: string) {
    const row = this.row(id)
    return row && fs.existsSync(row.archive_path) ? row.archive_path : null
  }
  async archive(record: AgentSessionRecord, maxBytes: number) {
    const source = await fsp.stat(record.logFilePath).catch(() => null)
    if (!source?.isFile() || !source.size) return
    const previous = this.row(record.sessionId)
    if (
      previous &&
      previous.source_size === source.size &&
      new Date(previous.updated_at).getTime() >= source.mtimeMs &&
      fs.existsSync(previous.archive_path)
    )
      return
    // A truncated source must not replace a more complete recovery copy.
    if (previous && source.size < previous.bytes)
      throw new Error(
        'Source conversation was truncated; the previous archive has been preserved'
      )
    this.prune()
    const replaceable =
      previous && !this.protectedFiles().has(previous.archive_path)
        ? previous.bytes
        : 0
    if (this.bytes - replaceable + source.size > maxBytes)
      throw new Error(
        'Conversation archive storage budget reached; increase the budget in History settings'
      )
    await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const safeName = createHash('sha256').update(record.sessionId).digest('hex')
    const destination = path.join(
        this.directory,
        `${safeName}-${randomUUID()}.jsonl`
      ),
      temporary = `${destination}.partial`
    try {
      let offset = 0
      // Validate the prefix before reusing a copy: rotation can replace a log
      // at the same path. Clone the old snapshot and append only new records.
      if (
        previous &&
        source.size >= previous.bytes &&
        fs.existsSync(previous.archive_path) &&
        (await checksumFile(previous.archive_path)) === previous.checksum &&
        (await checksumFile(record.logFilePath, previous.bytes)) ===
          previous.checksum
      ) {
        await fsp.copyFile(
          previous.archive_path,
          temporary,
          fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL
        )
        offset = previous.bytes
      }
      if (source.size > offset)
        await pipeline(
          fs.createReadStream(record.logFilePath, {
            start: offset,
            end: source.size - 1,
          }),
          fs.createWriteStream(temporary, {
            mode: 0o600,
            flags: offset ? 'a' : 'wx',
          })
        )
      const handle = await fsp.open(temporary, 'r+')
      let completeBytes = (await handle.stat()).size
      try {
        // Search backwards for a complete record without retaining the file in memory.
        let end = completeBytes,
          found = false
        while (end > 0) {
          const start = Math.max(0, end - 65536),
            buffer = Buffer.alloc(end - start)
          await handle.read(buffer, 0, buffer.length, start)
          const newline = buffer.lastIndexOf(10)
          if (newline >= 0) {
            completeBytes = start + newline + 1
            found = true
            break
          }
          end = start
        }
        if (!found)
          throw new Error(
            'Conversation does not yet contain a complete JSONL record'
          )
        await handle.truncate(completeBytes)
      } finally {
        await handle.close()
      }
      const checksum = await checksumFile(temporary)
      publishFile(temporary, destination)
      this.db.db
        .query(
          `INSERT INTO session_archives VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET
        source_path=excluded.source_path,archive_path=excluded.archive_path,bytes=excluded.bytes,source_size=excluded.source_size,
        updated_at=excluded.updated_at,checksum=excluded.checksum,complete=excluded.complete`
        )
        .run(
          record.sessionId,
          record.logFilePath,
          destination,
          completeBytes,
          source.size,
          new Date().toISOString(),
          checksum,
          Number(completeBytes === source.size)
        )
      if (previous && !this.protectedFiles().has(previous.archive_path))
        await fsp.rm(previous.archive_path, { force: true })
    } finally {
      await fsp.rm(temporary, { force: true })
    }
  }
  async verify(id: string) {
    const row = this.row(id)
    if (!row || (await checksumFile(row.archive_path)) !== row.checksum)
      throw new Error('Conversation archive is missing or failed verification')
    return row
  }
  async restoreSource(id: string) {
    const row = await this.verify(id)
    if (fs.existsSync(row.source_path)) return
    if (!row.complete)
      throw new Error(
        'This archive is a partial preview; it cannot replace the provider log'
      )
    await fsp.mkdir(path.dirname(row.source_path), {
      recursive: true,
      mode: 0o700,
    })
    const temporary = `${row.source_path}.${randomUUID()}.restore`
    try {
      await fsp.copyFile(
        row.archive_path,
        temporary,
        fs.constants.COPYFILE_EXCL
      )
      await fsp.chmod(temporary, 0o600)
      const handle = await fsp.open(temporary, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A hard link publishes the complete file atomically and never replaces
      // a provider log that reappeared during restoration.
      await fsp.link(temporary, row.source_path)
      const directory = await fsp.open(path.dirname(row.source_path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await fsp.rm(temporary, { force: true })
    }
  }
}
async function checksumFile(file: string, bytes?: number) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(
    file,
    bytes ? { start: 0, end: bytes - 1 } : undefined
  ))
    hash.update(chunk)
  return hash.digest('hex')
}
