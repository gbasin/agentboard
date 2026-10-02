// devinMirrorWriter.ts - Streams a devin session's mirrored JSONL to a temp
// file and renames it into place (the full-rewrite path of devinSync).
import fs from 'node:fs'

const MIRROR_WRITE_CHUNK_CHARS = 1024 * 1024

/**
 * Write a full mirror (meta line + one line per kept row) to a temp file and
 * rename it into place. Rows stream from the statement and lines are flushed
 * in ~1MB chunks, so a rewrite holds one chunk instead of the session's whole
 * message history (a large session has tens of MB of chat_message JSON).
 */
export function writeMirrorAtomic<Row extends { row_id: number }>(
  filePath: string,
  firstLine: string,
  rows: Iterable<Row>,
  toLine: (row: Row) => string | null
): { lastRowId: number; rowCount: number; fileSize: number } {
  const tmpPath = `${filePath}.tmp-${process.pid}`
  const fd = fs.openSync(tmpPath, 'w')
  let lastRowId = 0
  let rowCount = 0
  let fileSize = 0
  let pending: string[] = [firstLine]
  let pendingChars = firstLine.length
  const flush = () => {
    const bytes = Buffer.from(pending.join('\n') + '\n')
    let offset = 0
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
    }
    fileSize += bytes.length
    pending = []
    pendingChars = 0
  }
  let failure: { error: unknown } | null = null
  try {
    for (const row of rows) {
      const line = toLine(row)
      if (line !== null) {
        pending.push(line)
        pendingChars += line.length
        if (pendingChars >= MIRROR_WRITE_CHUNK_CHARS) flush()
      }
      lastRowId = row.row_id
      rowCount += 1
    }
    if (pending.length > 0) flush()
  } catch (error) {
    failure = { error }
  }
  try {
    fs.closeSync(fd)
    if (!failure) fs.renameSync(tmpPath, filePath)
  } catch (error) {
    failure ??= { error }
  }
  if (failure) {
    // Never leave the temp file behind, and surface the first error rather
    // than a later close or cleanup failure.
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      // ignore
    }
    throw failure.error
  }
  return { lastRowId, rowCount, fileSize }
}
