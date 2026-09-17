/** Receive browser clipboard/selected files without consulting the host clipboard. */
import { Hono } from 'hono'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MAX_PASTE_FILE_BYTES, PASTE_FILE_LIMIT_LABEL } from '../../shared/pasteFiles'

// Reserve room for multipart headers while bounding the actual streamed body.
const MAX_BODY_BYTES = MAX_PASTE_FILE_BYTES + 64 * 1024

export function uploadedFilename(name: string): string {
  return basename(name.replace(/\\/g, '/'))
    // Filenames become terminal input; never retain control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '').slice(-180) || 'file'
}

const HEADER_DELIM = new TextEncoder().encode('\r\n\r\n')

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * Extract the `file` part from a multipart/form-data body.
 * Parses bytes directly because Request/Response.formData() is unreliable
 * under some Bun versions (returns Blobs missing name and contents).
 */
export function parseMultipartFile(
  data: Uint8Array,
  contentType: string
): { name: string; bytes: Uint8Array } | undefined {
  const boundary = /boundary=(?:("([^"]+)")|([^\s;]+))/.exec(contentType)
  const boundaryValue = boundary?.[2] ?? boundary?.[3]
  if (!boundaryValue) return undefined
  const encoder = new TextEncoder()
  const open = encoder.encode(`--${boundaryValue}\r\n`)
  const close = encoder.encode(`\r\n--${boundaryValue}`)

  let partStart = indexOfBytes(data, open)
  while (partStart !== -1) {
    const headersStart = partStart + open.length
    const headersEnd = indexOfBytes(data, HEADER_DELIM, headersStart)
    if (headersEnd === -1) return undefined
    const headers = Buffer.from(data.subarray(headersStart, headersEnd)).toString('latin1')
    const bodyStart = headersEnd + HEADER_DELIM.length
    const bodyEnd = indexOfBytes(data, close, bodyStart)
    if (bodyEnd === -1) return undefined
    partStart = bodyEnd + close.length

    const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? ''
    const nameMatch = /name="([^"]*)"/.exec(disposition)
    if (nameMatch?.[1] !== 'file') {
      partStart = indexOfBytes(data, open, partStart)
      continue
    }
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1]
    if (filename === undefined) return undefined
    return { name: filename, bytes: data.subarray(bodyStart, bodyEnd) }
  }
  return undefined
}

export function createPasteFileRoutes() {
  const app = new Hono()
  app.post('/', async (c) => {
    const tooLarge = () => c.json({ error: `File exceeds the ${PASTE_FILE_LIMIT_LABEL} limit` }, 413)
    if (Number(c.req.header('content-length')) > MAX_BODY_BYTES) return tooLarge()
    const reader = c.req.raw.body?.getReader()
    if (!reader) return c.json({ error: 'Choose a file to upload' }, 400)
    let directory: string | undefined
    try {
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel()
          return tooLarge()
        }
        chunks.push(value)
      }
      const data = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
      const file = parseMultipartFile(data, c.req.header('content-type') ?? '')
      if (!file) return c.json({ error: 'Choose a file to upload' }, 400)
      if (file.bytes.byteLength > MAX_PASTE_FILE_BYTES) return tooLarge()
      directory = await mkdtemp(join(tmpdir(), 'agentboard-upload-'))
      const path = join(directory, uploadedFilename(file.name))
      await writeFile(path, file.bytes, { mode: 0o600 })
      c.header('Cache-Control', 'no-store')
      return c.json({ path })
    } catch {
      if (directory) await rm(directory, { recursive: true, force: true })
      return c.json({ error: 'File upload failed. Try again.' }, 400)
    } finally {
      reader.releaseLock()
    }
  })
  return app
}
