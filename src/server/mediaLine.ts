/** Bounded JSONL payload reads shared by explicit originals and thumbnail workers. */
import fs from 'node:fs/promises'

export async function readMediaLine(logPath: string, offset: number): Promise<string | null> {
  const handle = await fs.open(logPath, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total < 64 * 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, 64 * 1024 * 1024 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset + total)
      if (!bytesRead) return chunks.length ? Buffer.concat(chunks).toString('utf8') : null
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(buffer.subarray(0, newline))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    // A truncated JSONL record is never a valid payload.
    return null
  } finally { await handle.close() }
}

