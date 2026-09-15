/** Verified SQLite snapshots and restore requests applied before opening the database. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { persistenceDirectory, publishFile } from './files'
import { acquireDatabaseOwner, assertRestoreOwnership } from './ownership'
import type { BackupInfo, PersistenceSettings } from '../../shared/persistence'

export function verifyBackup(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    const result = db.query('PRAGMA integrity_check').values()
    if (result.length !== 1 || result[0][0] !== 'ok')
      throw new Error('Backup integrity check failed')
    if (
      !db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_sessions'"
        )
        .get()
    )
      throw new Error('Not an Agentboard database')
  } finally {
    db.close()
  }
}
export class SessionBackups {
  readonly directory: string
  error: string | null = null
  private inventory: BackupInfo[] = []
  private directoryTime = -1
  private scannedAt = 0
  constructor(
    readonly db: Database,
    readonly dbPath: string
  ) {
    this.directory = path.join(persistenceDirectory(dbPath), 'backups')
  }
  list(): BackupInfo[] {
    const directoryTime =
      fs.statSync(this.directory, { throwIfNoEntry: false })?.mtimeMs ?? -1
    // Published backups are immutable; avoid scanning all snapshots on each
    // health poll and each conversation copy. Refresh external changes too.
    if (
      directoryTime === this.directoryTime &&
      Date.now() - this.scannedAt < 60000
    )
      return this.inventory
    this.inventory =
      directoryTime === -1
        ? []
        : fs
            .readdirSync(this.directory)
            .filter((n) => /^[\w.-]+\.db$/.test(n))
            .map((name) => this.describe(name))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    this.directoryTime = directoryTime
    this.scannedAt = Date.now()
    return this.inventory
  }
  private describe(name: string): BackupInfo {
    const stat = fs.statSync(this.resolve(name))
    return { name, createdAt: stat.mtime.toISOString(), bytes: stat.size }
  }
  resolve(name: string) {
    const file = path.join(this.directory, name)
    if (
      !/^[\w.-]+\.db$/.test(name) ||
      !fs.statSync(file, { throwIfNoEntry: false })?.isFile()
    )
      throw new Error('Backup not found')
    return file
  }
  create(label = 'manual') {
    if (!/^[a-z0-9-]{1,60}$/.test(label))
      throw new Error('Invalid backup label')
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const name = `${new Date().toISOString().replace(/[:]/g, '-')}-${label}-${randomUUID().slice(0, 8)}.db`
    const destination = path.join(this.directory, name),
      temporary = `${destination}.partial`
    try {
      this.db.query('VACUUM INTO ?').run(temporary)
      verifyBackup(temporary)
      publishFile(temporary, destination)
      this.scannedAt = 0
      this.error = null
      return this.describe(name)
    } catch (error) {
      this.error = String(error)
      throw error
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
  rotate(settings: PersistenceSettings, now = Date.now()) {
    const pending = this.pendingRestore()
    const keptHours = new Set<string>(),
      keptDays = new Set<string>(),
      keptMonths = new Set<string>()
    for (const backup of this.list()) {
      if (backup.name === pending || !backup.name.includes('-automatic-'))
        continue
      const time = new Date(backup.createdAt),
        age = now - time.getTime(),
        hour = backup.createdAt.slice(0, 13),
        day = backup.createdAt.slice(0, 10),
        month = backup.createdAt.slice(0, 7)
      let keep = false
      if (age < settings.backupHourly * 3600000 && !keptHours.has(hour)) {
        keptHours.add(hour)
        keep = true
      }
      if (age < settings.backupDaily * 86400000 && !keptDays.has(day)) {
        keptDays.add(day)
        keep = true
      }
      if (
        age < settings.backupMonthly * 31 * 86400000 &&
        !keptMonths.has(month)
      ) {
        keptMonths.add(month)
        keep = true
      }
      if (!keep) fs.unlinkSync(this.resolve(backup.name))
    }
    this.scannedAt = 0
  }
  pendingRestore(): string | null {
    const request = path.join(
      persistenceDirectory(this.dbPath),
      'restore-request.json'
    )
    return fs.existsSync(request)
      ? JSON.parse(fs.readFileSync(request, 'utf8')).name
      : null
  }
  scheduleRestore(name: string) {
    const file = this.resolve(name)
    verifyBackup(file)
    const destination = path.join(
      persistenceDirectory(this.dbPath),
      'restore-request.json'
    )
    const temporary = `${destination}.partial`
    fs.writeFileSync(temporary, JSON.stringify({ name }), { mode: 0o600 })
    publishFile(temporary, destination)
  }
}
export function applyPendingRestore(dbPath: string, ownerToken?: string) {
  if (dbPath === ':memory:') return
  const request = path.join(
    persistenceDirectory(dbPath),
    'restore-request.json'
  )
  if (!fs.existsSync(request)) return
  const acquired =
    ownerToken === undefined ? acquireDatabaseOwner(dbPath) : null
  try {
    assertRestoreOwnership(dbPath, ownerToken ?? acquired!.token)
    const { name } = JSON.parse(fs.readFileSync(request, 'utf8'))
    const directory = path.join(persistenceDirectory(dbPath), 'backups')
    if (typeof name !== 'string' || !/^[\w.-]+\.db$/.test(name))
      throw new Error('Invalid backup name')
    const source = path.join(directory, name)
    verifyBackup(source)
    preserveCurrentDatabase(dbPath)
    const temporary = `${dbPath}.restore-${randomUUID()}`
    try {
      fs.copyFileSync(source, temporary)
      verifyBackup(temporary)
      // No connection has opened this database in the new server process yet.
      for (const suffix of ['-wal', '-shm'])
        if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix)
      publishFile(temporary, dbPath)
      fs.unlinkSync(request)
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  } finally {
    acquired?.release()
  }
}

/** Keep a rollback copy even when SQLite cannot read the current database. */
function preserveCurrentDatabase(dbPath: string) {
  if (!fs.existsSync(dbPath)) return
  let current: Database | undefined
  let corrupt = false
  try {
    current = new Database(dbPath)
    new SessionBackups(current, dbPath).create('before-restore')
    const checkpoint = current
      .query('PRAGMA wal_checkpoint(TRUNCATE)')
      .get() as { busy: number }
    if (checkpoint.busy)
      throw new Error(
        'Database is still in use; stop Agentboard before restoring'
      )
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'SQLITE_CORRUPT' && code !== 'SQLITE_NOTADB') throw error
    corrupt = true
  } finally {
    current?.close()
  }
  if (!corrupt) return
  const directory = path.join(
    persistenceDirectory(dbPath),
    `unreadable-before-restore-${randomUUID()}`
  )
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const suffix of ['', '-wal', '-shm']) {
    if (!fs.existsSync(dbPath + suffix)) continue
    const destination = path.join(directory, path.basename(dbPath) + suffix)
    const temporary = `${destination}.partial`
    fs.copyFileSync(dbPath + suffix, temporary)
    publishFile(temporary, destination)
  }
}
