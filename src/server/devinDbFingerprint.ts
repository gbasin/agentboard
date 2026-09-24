// devinDbFingerprint.ts - Cheap change detector for Devin's sessions.db.
//
// Lets devinSync skip opening SQLite on idle cycles by fingerprinting the
// db, WAL, and WAL-index (-shm) files with plain stat + small header reads.

import fs from 'node:fs'

/** Reads the first `length` bytes of a file as hex; '' when unreadable. */
function readHeaderHex(filePath: string, length: number): string {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(length)
    const read = fs.readSync(fd, buf, 0, length, 0)
    return buf.subarray(0, read).toString('hex')
  } catch {
    return ''
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function fileFingerprint(filePath: string, headerBytes: number, headerOffset = 0): string {
  try {
    const stat = fs.statSync(filePath, { bigint: true })
    const header = readHeaderHex(filePath, headerOffset + headerBytes).slice(headerOffset * 2)
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${header}`
  } catch {
    return 'missing'
  }
}

/**
 * Cheap change detector for sessions.db without opening it through SQLite.
 * A torn or racy read only causes an extra sync, never a missed one, as long
 * as every commit changes at least one component:
 * - db: inode/size/mtime + file change counter (header bytes 24-27, bumped
 *   per commit in rollback-journal mode).
 * - wal: inode/size/mtime + WAL header (checkpoint seq + salts; change on
 *   WAL reset).
 * - shm: bytes 0-47, the first copy of the WAL-index header. iChange (offset
 *   8) and mxFrame (offset 16) move on every WAL commit. This is what catches
 *   commits after a WAL reset that overwrite frames inside the old WAL size,
 *   where size and header stay equal and mtime only moves per kernel tick on
 *   Linux. Readers do not write this range.
 * syncDevinSessions() (devinSync.ts) additionally bypasses the fingerprint
 * every FULL_CHECK_INTERVAL_MS as a safety net.
 */
export function devinDbFingerprint(dbPath: string): string {
  const db = fileFingerprint(dbPath, 4, 24)
  const wal = fileFingerprint(`${dbPath}-wal`, 32)
  const shm = readHeaderHex(`${dbPath}-shm`, 48) || 'missing'
  return `db=${db}|wal=${wal}|shm=${shm}`
}
