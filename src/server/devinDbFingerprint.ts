// devinDbFingerprint.ts - Cheap change detector for Devin's sessions.db.
//
// Lets devinSync skip opening SQLite on idle cycles by fingerprinting the
// db, WAL, and WAL-index (-shm) files with plain stat + small header reads.

import fs from 'node:fs'

const ABSENT = 'absent'

/**
 * One file's fingerprint component. A missing file is a legitimate state
 * ('absent': no WAL/shm between connections). Any other error, or reading
 * fewer header bytes than the file's size says exist, returns null: an
 * uncertain read must never be reused as an "unchanged" verdict.
 * A file shorter than the header (e.g. a WAL truncated to 0 bytes by
 * wal_checkpoint(TRUNCATE)) is certain and is represented by its size.
 */
function fileComponent(
  filePath: string,
  headerOffset: number,
  headerBytes: number,
  includeStat: boolean
): string | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT : null
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    const want = headerOffset + headerBytes
    const expected = stat.size >= BigInt(want) ? want : Number(stat.size)
    const buf = Buffer.alloc(want)
    const read = fs.readSync(fd, buf, 0, want, 0)
    if (read < expected) return null
    const header = buf.subarray(Math.min(headerOffset, read), read).toString('hex')
    // shm omits mtime: readers write read-marks elsewhere in the file.
    return includeStat
      ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${header}`
      : `${stat.size}:${header}`
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Cheap change detector for sessions.db without opening it through SQLite.
 * Returns null when any component read is uncertain (error or short read);
 * callers must treat null as "changed". The -shm header is read without the
 * wal-index lock, so a torn read is possible; it can only produce a value
 * no stored fingerprint matches (an extra sync), never a false match.
 * Components (a change is missed only if a commit changes none of them):
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
export function devinDbFingerprint(dbPath: string): string | null {
  const db = fileComponent(dbPath, 24, 4, true)
  const wal = fileComponent(`${dbPath}-wal`, 0, 32, true)
  const shm = fileComponent(`${dbPath}-shm`, 0, 48, false)
  if (db === null || wal === null || shm === null) return null
  return `db=${db}|wal=${wal}|shm=${shm}`
}
