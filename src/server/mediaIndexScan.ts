/** Incremental line reader for the disk index. Only the current JSONL record is buffered. */
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
  /** Nondecreasing media timestamp preserves source order across appends. */
  orderTime?: number
}

function boundary(fd: number, offset: number): string {
  const length = Math.min(256, offset)
  const first = Buffer.alloc(length), last = Buffer.alloc(length)
  fs.readSync(fd, first, 0, length, 0)
  fs.readSync(fd, last, 0, length, offset - length)
  return createHash('sha256').update(first).update(last).digest('hex')
}

export function scanMediaFile(
  filePath: string,
  previous: MediaFileState | undefined,
  reset: () => void,
  emit: (entry: ScannedMedia, key: string, digest: string, time: number) => void,
): MediaFileState | null {
  let fd: number
  try { fd = fs.openSync(filePath, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (previous) reset(); return null }
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (previous && (previous.orderTime === undefined || previous.version !== 2)) { reset(); previous = undefined }
    if (previous && stat.size === previous.size && stat.mtimeMs === previous.mtime && stat.ino === previous.inode) return previous
    if (previous && (stat.ino !== previous.inode || stat.size < previous.size ||
        (stat.size === previous.size && stat.mtimeMs !== previous.mtime) ||
        boundary(fd, previous.offset) !== previous.boundary)) {
      reset(); previous = undefined
    }
    let offset = previous?.offset ?? 0
    let position = offset
    let pieces: Buffer[] = []
    let pieceBytes = 0
    let discarding = previous?.discarding ?? false
    let omittedRecords = previous?.omittedRecords ?? 0
    const maxRecordBytes = 64 * 1024 * 1024
    let orderTime = previous?.orderTime ?? 0
    const scanner = createMediaLineScanner((entry, key, digest, time) => {
      orderTime = Math.max(orderTime, time)
      emit(entry, key, digest, orderTime)
    }, previous ? JSON.parse(previous.labels) : [])
    const buffer = Buffer.allocUnsafe(128 * 1024)
    while (position < stat.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position)
      if (!count) break
      let start = 0
      for (let i = 0; i < count; i++) {
        if (buffer[i] !== 10) continue
        const part = buffer.subarray(start, i)
        if (!discarding && pieceBytes + part.length <= maxRecordBytes) {
          const line = pieces.length ? Buffer.concat([...pieces, part]).toString('utf8') : part.toString('utf8')
          scanner.line(line, offset)
        } else if (!discarding) omittedRecords++
        offset = position + i + 1
        pieces = []
        pieceBytes = 0
        discarding = false
        start = i + 1
      }
      if (start < count) {
        const length = count - start
        if (!discarding && pieceBytes + length > maxRecordBytes) {
          omittedRecords++
          discarding = true
          pieces = []
          pieceBytes = 0
        }
        if (discarding) offset = position + count
        else { pieces.push(Buffer.from(buffer.subarray(start, count))); pieceBytes += length }
      }
      position += count
    }
    // Incomplete trailing records are retried from their start after the next append.
    return { version: 2, path: filePath, offset, size: stat.size, mtime: stat.mtimeMs, inode: stat.ino,
      boundary: boundary(fd, offset), labels: JSON.stringify(scanner.labels()), discarding, omittedRecords, orderTime }
  } finally { fs.closeSync(fd) }
}
