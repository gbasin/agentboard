import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MediaThumbnails } from '../mediaThumbnails'
import { MediaThumbnailClient } from '../mediaThumbnailClient'
const roots: string[] = []
const clients: MediaThumbnailClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture(data: Buffer = Buffer.from('one'), mediaType = 'image/png') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-test-')); roots.push(root)
  const file = path.join(root, 'log.jsonl')
  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } }] } })
  fs.writeFileSync(file, line + '\n')
  return { file, line, ref: { path: file, offset: 0, index: 0, digest: createHash('sha256').update(line).digest('hex') } }
}
test('cache avoids decode on repeats and transcript appends, but validates rewrites', async () => {
  const f = fixture(); let decodes = 0
  const engine = new MediaThumbnails(() => { decodes++; return new Uint8Array([1, 2]) })
  await engine.get(f.ref); await engine.get(f.ref)
  fs.appendFileSync(f.file, '{"new":"event"}\n')
  await engine.get(f.ref)
  expect(decodes).toBe(1)
  fs.writeFileSync(f.file, f.line.replace('b25l', 'dHdv') + '\n')
  await expect(engine.get(f.ref)).rejects.toHaveProperty('code', 'STALE')
  expect(decodes).toBe(1)
})
test('bounded LRU evicts decoded bytes; oversized entries are not retained', async () => {
  const a = fixture(Buffer.from('a')), b = fixture(Buffer.from('b')); let decodes = 0
  const engine = new MediaThumbnails(() => { decodes++; return new Uint8Array([1, 2]) }, 2)
  await engine.get(a.ref); await engine.get(b.ref); await engine.get(a.ref)
  expect(decodes).toBe(3)
  const tiny = new MediaThumbnails(() => { decodes++; return new Uint8Array([1, 2]) }, 1)
  await tiny.get(a.ref); await tiny.get(a.ref)
  expect(decodes).toBe(5)
})
test('wrong byte count is stale and never invokes codec; corrupt image falls back', async () => {
  const f = fixture(); let decodes = 0
  const engine = new MediaThumbnails(() => { decodes++; throw new Error('corrupt') })
  await expect(engine.get({ ...f.ref, expectedBytes: 4 })).rejects.toHaveProperty('code', 'STALE')
  expect(decodes).toBe(0)
  await expect(engine.get(f.ref)).rejects.toHaveProperty('code', 'UNSUPPORTED')
})
test('real worker roundtrip returns a PNG and rejects a remote media item without fetching it', async () => {
  const { PNG } = await import('pngjs')
  const png = new PNG({ width: 256, height: 64 }); png.data.fill(255)
  const f = fixture(PNG.sync.write(png))
  const client = new MediaThumbnailClient(); clients.push(client)
  const result = await client.get(f.ref)
  const decoded = PNG.sync.read(Buffer.from(result))
  expect(decoded.width).toBe(128); expect(decoded.height).toBe(32)
  const line = JSON.stringify({ type: 'frame-link', frameUrl: 'http://127.0.0.1:1/private', title: 'external' })
  fs.writeFileSync(f.file, line + '\n')
  const error = await client.get({ ...f.ref, digest: createHash('sha256').update(line).digest('hex') }).catch(error => error)
  expect(error).toHaveProperty('code', 'UNSUPPORTED')
})

test('deadline retires a real blocked worker and the next request decodes successfully', async () => {
  const { PNG } = await import('pngjs')
  const png = new PNG({ width: 2, height: 2 }); png.data.fill(255)
  const f = fixture(PNG.sync.write(png))
  const blockedPath = path.join(path.dirname(f.file), 'blocked.ts')
  // Atomics.wait emulates a synchronous decoder that never returns without burning CPU.
  fs.writeFileSync(blockedPath, 'self.onmessage = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }')
  let starts = 0
  const client = new MediaThumbnailClient((url) => new Worker(++starts === 1 ? blockedPath : url, {
    type: 'module', env: {},
  }), 500)
  clients.push(client)
  const first = client.get(f.ref).catch(error => error.code)
  const second = client.get(f.ref)
  expect(await first).toBe('BUSY')
  expect((await second).byteLength).toBeGreaterThan(0)
  expect(starts).toBe(2)
})
