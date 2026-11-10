/// <reference lib="webworker" />
/** On-demand finite transcript scan, off the terminal server thread. Exits after one job. */
import fs from 'node:fs'
import { collectFileEvidence } from './outputs/fileEvidence'
export interface OutputPathScan { files: string[]; cwd: string }
const ctx = self as DedicatedWorkerGlobalScope
ctx.onmessage = (event: MessageEvent<OutputPathScan>) => {
  try {
    const paths = new Set<string>()
    let remaining = 512 * 1024 * 1024
    const deadline = performance.now() + 30_000
    for (const file of event.data.files) {
      let fd: number
      try { fd = fs.openSync(file, 'r') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      try {
        const size = fs.fstatSync(fd).size
        if (size > remaining) throw Error('This session is too large to resolve filenames automatically. Share the full file path.')
        remaining -= size
        let cwd = event.data.cwd, position = 0, pendingBytes = 0
        let pieces: Buffer[] = []
        const buffer = Buffer.allocUnsafe(256 * 1024)
        const line = (bytes: Buffer) => {
          let raw: unknown
          try {
            const text = bytes.toString('utf8')
            if (!/\.html?|"cwd"/i.test(text)) return
            raw = JSON.parse(text)
          } catch { return }
          const result = collectFileEvidence(raw, cwd)
          cwd = result.cwd
          for (const candidate of result.paths) paths.add(candidate)
          if (paths.size > 4096) throw Error('Too many file references to resolve automatically. Share the full file path.')
        }
        while (position < size) {
          if (performance.now() > deadline) throw Error('File lookup took too long. Ask the agent to share the full path.')
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
          if (!count) break
          position += count
          let start = 0
          for (let i = 0; i < count; i++) if (buffer[i] === 10) {
            if (pendingBytes + i - start > 64 * 1024 * 1024) throw Error('A transcript record is too large to resolve filenames automatically. Share the full file path.')
            line(pieces.length ? Buffer.concat([...pieces, buffer.subarray(start, i)]) : buffer.subarray(start, i))
            pieces = []; pendingBytes = 0; start = i + 1
          }
          if (start < count) { pieces.push(Buffer.from(buffer.subarray(start, count))); pendingBytes += count - start }
          if (pendingBytes > 64 * 1024 * 1024) throw Error('A transcript record is too large to resolve filenames automatically. Share the full file path.')
        }
        if (pieces.length) line(Buffer.concat(pieces))
      } finally { fs.closeSync(fd) }
    }
    ctx.postMessage({ paths: [...paths] })
  } catch (error) { ctx.postMessage({ error: error instanceof Error ? error.message : 'Unable to read session file references' }) }
  ctx.close()
}
