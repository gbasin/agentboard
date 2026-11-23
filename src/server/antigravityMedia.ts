// Bind separately stored CLI images to their canonical transcript and record digest.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { antigravityHome, antigravitySessionId } from './antigravityLogs'

const MAX_BYTES = 16 * 1024 * 1024
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const extensions = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']])

function* materialize(log: string, line: string): Generator<{ file: string; limit: number }, string, Buffer | null> {
  if (!line.includes('"media"') || !antigravitySessionId(log)) return line
  let step
  try { step = JSON.parse(line) } catch { return line }
  if (!Number.isSafeInteger(step?.step_index) || step.step_index < 0 || !Array.isArray(step.media)) return line
  const blocks = []
  let limit = MAX_BYTES
  for (const [index, media] of step.media.slice(0, 32).entries()) {
    const ext = extensions.get(media?.mime_type)
    if (!ext || typeof media.uri !== 'string') continue
    const file = path.join(path.dirname(log), 'media', `step_${step.step_index}_media_${index}.${ext}`)
    try { if (fileURLToPath(media.uri) !== file) continue } catch { continue }
    const data = yield { file, limit }
    if (data) {
      blocks.push({ type: 'image', source: { media_type: media.mime_type, data: data.toString('base64') } })
      limit -= data.length
    }
  }
  return blocks.length ? JSON.stringify({ ...step, attachmentBlocks: blocks }) : line
}

function expectedDir(root: string, file: string) {
  return path.join(root, path.relative(antigravityHome(), path.dirname(file)))
}

export function materializeMediaSync(log: string, line: string): string {
  const steps = materialize(log, line)
  let step = steps.next()
  while (!step.done) {
    const { file, limit } = step.value
    let fd, data = null
    try {
      if (fs.realpathSync(path.dirname(file)) === expectedDir(fs.realpathSync(antigravityHome()), file)) {
        fd = fs.openSync(file, OPEN_FLAGS)
        const stat = fs.fstatSync(fd)
        if (stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit) {
          const buf = Buffer.alloc(stat.size)
          if (fs.readSync(fd, buf) === buf.length) data = buf
        }
      }
    } catch { /* Missing or replaced sidecar. */ } finally { if (fd !== undefined) fs.closeSync(fd) }
    step = steps.next(data)
  }
  return step.value
}

export async function materializeMedia(log: string, line: string): Promise<string> {
  const steps = materialize(log, line)
  let step = steps.next()
  while (!step.done) {
    const { file, limit } = step.value
    let handle, data = null
    try {
      if (await fs.promises.realpath(path.dirname(file)) === expectedDir(await fs.promises.realpath(antigravityHome()), file)) {
        handle = await fs.promises.open(file, OPEN_FLAGS)
        const stat = await handle.stat()
        if (stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit) {
          const buf = Buffer.alloc(stat.size)
          if ((await handle.read(buf)).bytesRead === buf.length) data = buf
        }
      }
    } catch { /* Missing or replaced sidecar. */ } finally { await handle?.close() }
    step = steps.next(data)
  }
  return step.value
}
