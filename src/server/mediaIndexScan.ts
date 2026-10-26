/** Resumable forward JSONL reader. Checkpoints contain no partial record buffers. */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createMediaLineScanner, type ScannedMedia } from './mediaExtractor'

export interface MediaFileState {
  version?: number
  path: string
  offset: number
  size: number
  mtime: number
  inode: number
  boundary: string
  labels: string
  discarding?: boolean
  omittedRecords?: number
  omittedItems?: number
  orderTime?: number
  complete?: boolean
}
export interface MediaScanBudget { maxBytes?: number; maxMs?: number }
export interface MediaFileSnapshot { path: string; size: number; mtime: number; inode: number }
export function mediaFileSnapshot(path: string): MediaFileSnapshot {
  try { const s = fs.statSync(path); return { path, size: s.size, mtime: s.mtimeMs, inode: s.ino } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, size: 0, mtime: 0, inode: 0 }; throw error }
}
function boundary(fd: number, offset: number): string {
  const length = Math.min(256, offset)
  const first = Buffer.alloc(length), last = Buffer.alloc(length)
  fs.readSync(fd, first, 0, length, 0)
  fs.readSync(fd, last, 0, length, offset - length)
  return createHash('sha256').update(first).update(last).digest('hex')
}

export function scanMediaFileStep(
  snapshot: MediaFileSnapshot,
  previous: MediaFileState | undefined,
  reset: () => void,
  emit: (entry: ScannedMedia, key: string, digest: string, time: number) => void,
  budget: MediaScanBudget = {},
): { state: MediaFileState | null; done: boolean; bytesRead: number } {
  const filePath = snapshot.path
  let fd: number
  try { fd = fs.openSync(filePath, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (previous) reset(); return { state: null, done: true, bytesRead: 0 } }
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    // A changed source is a new finite snapshot. An append keeps this job's EOF.
    if (stat.ino !== snapshot.inode || stat.size < snapshot.size ||
        (stat.size === snapshot.size && stat.mtimeMs !== snapshot.mtime)) {
      snapshot.size = stat.size; snapshot.mtime = stat.mtimeMs; snapshot.inode = stat.ino
    }
    const end = Math.min(snapshot.size, stat.size)
    if (previous && (previous.orderTime === undefined || previous.version !== 3)) { reset(); previous = undefined }
    if (previous && previous.complete !== false && end === previous.size && snapshot.mtime === previous.mtime && stat.ino === previous.inode) {
      return { state: previous, done: true, bytesRead: 0 }
    }
    if (previous && (stat.ino !== previous.inode || end < previous.size ||
        (end === previous.size && snapshot.mtime !== previous.mtime) || boundary(fd, previous.offset) !== previous.boundary)) {
      reset(); previous = undefined
    }
    let offset = previous?.offset ?? 0, position = offset
    const startOffset = offset, started = performance.now()
    let pieces: Buffer[] = [], pieceBytes = 0
    let discarding = previous?.discarding ?? false
    let omittedRecords = previous?.omittedRecords ?? 0
    const maxRecordBytes = 64 * 1024 * 1024
    let orderTime = previous?.orderTime ?? 0
    const scanner = createMediaLineScanner((entry, key, digest, time) => {
      orderTime = Math.max(orderTime, time); emit(entry, key, digest, orderTime)
    }, previous ? JSON.parse(previous.labels) : [])
    const buffer = Buffer.allocUnsafe(128 * 1024)
    const exhausted = () => position - startOffset >= (budget.maxBytes ?? Infinity) || performance.now() - started >= (budget.maxMs ?? Infinity)
    let stopped = false
    while (position < end && !stopped) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position)
      if (!count) break
      const chunkStart = position
      let start = 0
      for (let i = 0; i < count; i++) {
        if (buffer[i] !== 10) continue
        const part = buffer.subarray(start, i)
        if (!discarding && pieceBytes + part.length <= maxRecordBytes) {
          scanner.line(pieces.length ? Buffer.concat([...pieces, part]).toString('utf8') : part.toString('utf8'), offset)
        } else if (!discarding) omittedRecords++
        offset = chunkStart + i + 1; position = offset
        pieces = []; pieceBytes = 0; discarding = false; start = i + 1
        if (exhausted()) { stopped = true; break }
      }
      if (stopped) break
      if (start < count) {
        const length = count - start
        if (!discarding && pieceBytes + length > maxRecordBytes) {
          omittedRecords++; discarding = true; pieces = []; pieceBytes = 0
        }
        if (discarding) offset = chunkStart + count
        else { pieces.push(Buffer.from(buffer.subarray(start, count))); pieceBytes += length }
      }
      position = chunkStart + count
      // Oversized records can yield mid-discard; ordinary records only at newline.
      if (discarding && exhausted()) stopped = true
    }
    const done = position >= end
    return { state: { version: 3, path: filePath, offset, size: end, mtime: snapshot.mtime, inode: stat.ino,
      boundary: boundary(fd, offset), labels: JSON.stringify(scanner.labels()), discarding, omittedRecords,
      omittedItems: previous?.omittedItems ?? 0, orderTime, complete: done }, done, bytesRead: position - startOffset }
  } finally { fs.closeSync(fd) }
}

/** Compatibility helper: one complete finite file snapshot. */
export function scanMediaFile(filePath: string, previous: MediaFileState | undefined, reset: () => void,
  emit: (entry: ScannedMedia, key: string, digest: string, time: number) => void): MediaFileState | null {
  return scanMediaFileStep(mediaFileSnapshot(filePath), previous, reset, emit).state
}
