/** Import a portable recovery export as a verified, staged database backup. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import {
  persistenceDirectory,
  publishFile,
  SessionBackups,
  verifyBackup,
} from './backups'

export async function importRecoveryExport(
  backups: SessionBackups,
  directory: string
) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')
  ) as {
    database: string
    conversations: { providerId: string; file: string; checksum: string }[]
  }
  if (
    manifest.database !== 'agentboard.db' ||
    !Array.isArray(manifest.conversations)
  )
    throw new Error('Invalid recovery export manifest')
  const source = path.join(directory, manifest.database)
  verifyBackup(source)
  fs.mkdirSync(backups.directory, { recursive: true, mode: 0o700 })
  const name = `${new Date().toISOString().replace(/:/g, '-')}-import-${randomUUID().slice(0, 8)}.db`
  const destination = path.join(backups.directory, name),
    temporary = `${destination}.partial`
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL)
  const staged = new Database(temporary)
  const created: string[] = []
  try {
    const archiveDirectory = path.join(
      persistenceDirectory(backups.dbPath),
      'conversations'
    )
    fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })
    const hasArchives = staged
      .query("SELECT 1 FROM sqlite_master WHERE name='session_archives'")
      .get()
    const count = hasArchives
      ? (
          staged.query('SELECT count(*) AS n FROM session_archives').get() as {
            n: number
          }
        ).n
      : 0
    if (
      count !== manifest.conversations.length ||
      new Set(manifest.conversations.map((c) => c.providerId)).size !== count
    )
      throw new Error('Export manifest is missing conversations')
    for (const entry of manifest.conversations) {
      if (
        typeof entry.file !== 'string' ||
        !/^[\w.-]+\.jsonl$/.test(entry.file) ||
        path.basename(entry.file) !== entry.file
      )
        throw new Error('Invalid exported archive path')
      const record = staged
        .query('SELECT checksum FROM session_archives WHERE provider_id=?')
        .get(entry.providerId) as { checksum: string } | null
      if (!record || record.checksum !== entry.checksum)
        throw new Error('Archive manifest does not match the exported database')
      const archived = path.join(directory, entry.file),
        hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(archived))
        hash.update(chunk)
      if (hash.digest('hex') !== entry.checksum)
        throw new Error('Exported conversation failed verification')
      const target = path.join(archiveDirectory, `${randomUUID()}.jsonl`),
        partial = `${target}.partial`
      created.push(partial, target)
      fs.copyFileSync(archived, partial, fs.constants.COPYFILE_EXCL)
      publishFile(partial, target)
      staged
        .query('UPDATE session_archives SET archive_path=? WHERE provider_id=?')
        .run(target, entry.providerId)
    }
    // Source project paths and provider auxiliary files may differ on a new
    // machine. Restoring an export always returns the user to manual reopening.
    const row = staged
      .query("SELECT value FROM app_settings WHERE key='persistence_settings'")
      .get() as { value: string } | null
    const settings = JSON.parse(row?.value || '{}')
    staged
      .query(
        "INSERT OR REPLACE INTO app_settings VALUES('persistence_settings',?)"
      )
      .run(JSON.stringify({ ...settings, autoResume: false }))
    staged.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    staged.close()
    verifyBackup(temporary)
    publishFile(temporary, destination)
    return backups.list().find((b) => b.name === name)!
  } catch (error) {
    try {
      staged.close()
    } catch {
      /* already closed */
    }
    for (const file of created) fs.rmSync(file, { force: true })
    throw error
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
