import { afterEach, describe, expect, test } from 'bun:test'
import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { createPasteFileRoutes, uploadedFilename } from '../routes/pasteFile'
import { MAX_PASTE_FILE_BYTES } from '../../shared/pasteFiles'

const app = createPasteFileRoutes()
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('browser file upload', () => {
  test.each(['report.docx', 'data.xlsx', 'report with spaces.pdf', 'custom.unknown', 'LICENSE'])('preserves bytes and filename for %s', async (name) => {
    const bytes = new Uint8Array([0, 255, 80, 75, 3, 4])
    const form = new FormData()
    form.append('file', new File([bytes], name))
    const response = await app.request('/', { method: 'POST', body: form })
    expect(response.status).toBe(200)
    const { path } = await response.json() as { path: string }
    directories.push(dirname(path))
    expect(basename(path)).toBe(name)
    expect(new Uint8Array(await readFile(path))).toEqual(bytes)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('stores equal filenames in separate private directories', async () => {
    for (let i = 0; i < 2; i++) {
      const form = new FormData()
      form.append('file', new File([String(i)], 'same.txt'))
      const response = await app.request('/', { method: 'POST', body: form })
      const { path } = await response.json() as { path: string }
      directories.push(dirname(path))
      expect(await readFile(path, 'utf8')).toBe(String(i))
    }
    expect(directories[0]).not.toBe(directories[1])
  })

  test('removes path traversal and terminal control characters from filenames', () => {
    expect(uploadedFilename('../../report\n\x1b.docx')).toBe('report.docx')
    expect(uploadedFilename('C:\\folder\\report.docx')).toBe('report.docx')
    expect(uploadedFilename('..')).toBe('file')
  })

  test('rejects missing files and malformed multipart data', async () => {
    const form = new FormData()
    form.set('file', 'not a file')
    expect((await app.request('/', { method: 'POST', body: form })).status).toBe(400)
    expect((await app.request('/', { method: 'POST', body: 'bad' })).status).toBe(400)
  })

  test('rejects oversized bodies even without a content-length header', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) {
        if (emitted++ <= 41) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() { cancelled = true },
    })
    const response = await app.request('/', { method: 'POST', body: stream })
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
  })

  test('rejects an oversized file within the multipart overhead allowance', async () => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(MAX_PASTE_FILE_BYTES + 1)], 'large.bin'))
    expect((await app.request('/', { method: 'POST', body: form })).status).toBe(413)
  })
})
