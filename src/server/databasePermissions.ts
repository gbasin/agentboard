import fs from 'node:fs'

/**
 * Session data (prompts, paths) is private to the user. The WAL and shared
 * memory files hold the same data, so they get the same mode; they exist only
 * after the WAL switch, and are best-effort since SQLite may recreate them.
 */
export function restrictDatabaseFiles(dbPath: string) {
  if (dbPath === ':memory:') return
  fs.chmodSync(dbPath, 0o600)
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.chmodSync(`${dbPath}${suffix}`, 0o600)
    } catch {
      // Not created yet, or already gone after a checkpoint.
    }
  }
}
