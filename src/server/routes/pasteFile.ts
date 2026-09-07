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
      const form = await new Response(data, { headers: { 'Content-Type': c.req.header('content-type') ?? '' } }).formData()
      const file = form.get('file')
      if (!(file instanceof File)) return c.json({ error: 'Choose a file to upload' }, 400)
      if (file.size > MAX_PASTE_FILE_BYTES) return tooLarge()
      directory = await mkdtemp(join(tmpdir(), 'agentboard-upload-'))
      const path = join(directory, uploadedFilename(file.name))
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 })
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
