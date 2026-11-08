/** Compiled regression: codec, deadline recovery, HTTP abort, and safe worker disposal. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { withPngExif } from '../tests/fixtures/pngExif'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-thumbnail-compiled-'))
// Set before importing config/logger; this probe never uses the user's data or log.
process.env.AGENTBOARD_DATA_DIR = path.join(root, 'data')
process.env.LOG_FILE = ''
const { MediaThumbnailClient } = await import('../src/server/mediaThumbnailClient')
const { createMediaRoutes } = await import('../src/server/mediaRoutes')
const { sanitizedTmuxEnv } = await import('../src/server/tmuxEnv')
const file = path.join(root, 'log.jsonl')
const png = new PNG({ width: 256, height: 128 }); png.data.fill(255)
const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: withPngExif(PNG.sync.write(png)).toString('base64') } }]
const line = JSON.stringify({ type: 'user', message: { content } })
fs.writeFileSync(file, line + '\n')
const ref = { path: file, offset: 0, index: 0, digest: createHash('sha256').update(line).digest('hex') }
const compiled = import.meta.url.includes('$bunfs')
const delayedUrl = compiled ? '/$bunfs/root/scripts/fixtures/mediaThumbnailDelayedWorker.js'
  : new URL('./fixtures/mediaThumbnailDelayedWorker.ts', import.meta.url).href
let starts = 0, abortObserved = false, heartbeats = 0
let entered!: () => void
const started = new Promise<void>(resolve => { entered = resolve })
const dispatched: number[] = []
const client = new MediaThumbnailClient(() => {
  starts++
  const worker = new Worker(delayedUrl, { type: 'module', env: sanitizedTmuxEnv() })
  const send = worker.postMessage.bind(worker)
  worker.postMessage = ((message: { ref?: { expectedBytes?: number } }) => {
    if (message.ref) dispatched.push(message.ref.expectedBytes ?? 0)
    send(message)
  }) as typeof worker.postMessage
  return worker
}, 300)
const clients = [client]
const heartbeat = setInterval(() => { heartbeats++ }, 10)
const record = { sessionId: 'session-12345678-abcdef', logFilePath: file, agentType: 'claude' } as import('../src/server/db').AgentSessionRecord
const app = createMediaRoutes({ getRecord: () => record, page: async () => { throw new Error('unused') }, thumbnail: {
  get: (ref, signal) => {
    if (ref.expectedBytes === 123) {
      signal?.addEventListener('abort', () => { abortObserved = true }, { once: true })
      entered()
    }
    return client.get(ref, signal)
  },
} })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request =>
  new URL(request.url).pathname === '/health' ? new Response('alive') : app.fetch(request),
})
async function healthy() {
  assert.equal(await (await fetch(`http://127.0.0.1:${server.port}/health`)).text(), 'alive')
}
try {
  const first = client.get(ref).catch(error => error.code)
  const controller = new AbortController()
  const request = fetch(`http://127.0.0.1:${server.port}/${record.sessionId}?path=${encodeURIComponent(file)}&offset=0&index=0&digest=${ref.digest}&thumbnail=1&bytes=123`, { signal: controller.signal }).catch(() => null)
  await started
  controller.abort(); await request
  assert.equal(await first, 'BUSY')
  assert.equal(await client.get(ref).catch(error => error.code), 'BUSY')
  let image: Uint8Array | null = null
  const deadline = Date.now() + 5000
  while (!image && Date.now() < deadline) {
    await Bun.sleep(25)
    image = await client.get(ref).catch(() => null)
  }
  assert(image, 'Worker did not recover')
  assert.equal(PNG.sync.read(Buffer.from(image)).width, 128)
  const cached = await client.get(ref)
  fs.appendFileSync(file, '{"append":true}\n')
  assert.deepEqual(await client.get(ref), cached)
  assert.equal(starts, 1)
  assert.equal(abortObserved, true)
  assert(!dispatched.includes(123), 'Cancelled request reached worker')
  assert(heartbeats > 5, 'Main event loop stalled')
  client.dispose(); await Bun.sleep(50); await healthy()

  // Sample disposal at startup and during reads of a large bounded record.
  const largeLine = JSON.stringify({ type: 'user', message: { content, padding: 'x'.repeat(32 * 1024 * 1024) } })
  fs.writeFileSync(file, largeLine + '\n')
  const largeRef = { ...ref, digest: createHash('sha256').update(largeLine).digest('hex') }
  for (const delay of [0, 1, 25, 50]) {
    const active = new MediaThumbnailClient(); clients.push(active)
    const request = active.get(largeRef).catch(error => error.code)
    if (delay) await Bun.sleep(delay)
    active.dispose()
    assert.equal(await request, 'STOPPED')
    await Bun.sleep(75); await healthy()
  }
  console.log(JSON.stringify({ compiled, starts, abortObserved, heartbeats, activeDisposals: 4, status: 'passed' }))
} finally {
  clearInterval(heartbeat)
  for (const client of clients) client.dispose()
  server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
}
