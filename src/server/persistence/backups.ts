/** Verified SQLite snapshots and restore requests applied before opening the database. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import type { BackupInfo, PersistenceSettings } from '../../shared/persistence'

export function persistenceDirectory(dbPath: string) {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath)}.recovery`)
}
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
function syncFile(file: string) {
  const fd = fs.openSync(file, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
export function publishFile(temporary: string, destination: string) {
  fs.chmodSync(temporary, 0o600)
  syncFile(temporary)
  fs.renameSync(temporary, destination)
  syncFile(path.dirname(destination))
}
export class SessionBackups {
  readonly directory: string
  error: string | null = null
  constructor(
    readonly db: Database,
    readonly dbPath: string
  ) {
    this.directory = path.join(persistenceDirectory(dbPath), 'backups')
  }
  list(): BackupInfo[] {
    if (!fs.existsSync(this.directory)) return []
    return fs
      .readdirSync(this.directory)
      .filter((n) => /^[\w.-]+\.db$/.test(n))
      .map((name) => {
        const stat = fs.statSync(path.join(this.directory, name))
        return { name, createdAt: stat.mtime.toISOString(), bytes: stat.size }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  resolve(name: string) {
    if (
      !/^[\w.-]+\.db$/.test(name) ||
      !this.list().some((b) => b.name === name)
    )
      throw new Error('Backup not found')
    return path.join(this.directory, name)
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
      this.error = null
      return this.list().find((b) => b.name === name)!
    } catch (error) {
      this.error = String(error)
      throw error
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
  rotate(settings: PersistenceSettings, now = Date.now()) {
    const keptHours = new Set<string>(),
      keptDays = new Set<string>(),
      keptMonths = new Set<string>()
    for (const backup of this.list()) {
      if (!backup.name.includes('-automatic-')) continue
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
  const ownerFile = path.join(persistenceDirectory(dbPath), 'owner.json')
  if (fs.existsSync(ownerFile)) {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    let alive = false
    try {
      process.kill(owner.pid, 0)
      alive = true
    } catch {
      /* old process exited */
    }
    if (alive && !(owner.pid === process.pid && ownerToken === owner.token))
      throw new Error(
        'Stop the running Agentboard before restoring its database'
      )
  }
  const { name } = JSON.parse(fs.readFileSync(request, 'utf8'))
  const current = new Database(dbPath)
  const backups = new SessionBackups(current, dbPath)
  let source: string
  try {
    source = backups.resolve(name)
    verifyBackup(source)
    backups.create('before-restore')
    const checkpoint = current
      .query('PRAGMA wal_checkpoint(TRUNCATE)')
      .get() as { busy: number }
    if (checkpoint.busy)
      throw new Error(
        'Database is still in use; stop Agentboard before restoring'
      )
  } finally {
    current.close()
  }
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
}
