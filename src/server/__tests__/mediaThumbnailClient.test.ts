import { afterEach, expect, test } from 'bun:test'
import { MediaThumbnailClient } from '../mediaThumbnailClient'
import type { ThumbnailRef } from '../mediaThumbnailTypes'

const clients: MediaThumbnailClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.dispose() })
const ref: ThumbnailRef = { path: '/test', offset: 0, index: 0, digest: 'a'.repeat(64) }
function fixture(timeout = 1000, capacity = 3) {
  const workers: ReturnType<typeof mockWorker>[] = []
  const client = new MediaThumbnailClient(() => {
    const worker = mockWorker(); workers.push(worker); return worker as unknown as Worker
  }, timeout, capacity)
  clients.push(client)
  return { client, workers }
}
function mockWorker() {
  return { onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as (() => void) | null, onmessageerror: null,
    sent: [] as { id: number }[], terminated: false, shutdown: false,
    postMessage(message: { id: number; kind?: string }) { if (message.kind === 'shutdown') this.shutdown = true; else this.sent.push(message) },
    terminate() { this.terminated = true },
    reply() { this.onmessage?.({ data: { id: this.sent.at(-1)!.id, body: new Uint8Array([1]) } }) },
  }
}

test('starts lazily and serializes bounded requests', async () => {
  const { client, workers } = fixture()
  expect(workers).toHaveLength(0)
  const a = client.get(ref), b = client.get(ref), c = client.get(ref)
  await expect(client.get(ref)).rejects.toHaveProperty('code', 'BUSY')
  expect(workers[0].sent).toHaveLength(1)
  workers[0].reply(); await a
  expect(workers[0].sent).toHaveLength(2)
  workers[0].reply(); await b
  workers[0].reply(); await c
})

test('aborted active work retains admission; queued cancellation frees its slot', async () => {
  const { client, workers } = fixture(1000, 2)
  const active = new AbortController(), queued = new AbortController()
  const a = client.get(ref, active.signal).catch(e => e.code)
  const b = client.get(ref, queued.signal).catch(e => e.code)
  active.abort(); expect(await a).toBe('ABORTED')
  await expect(client.get(ref)).rejects.toHaveProperty('code', 'BUSY')
  queued.abort(); expect(await b).toBe('ABORTED')
  const c = client.get(ref)
  expect(workers[0].sent).toHaveLength(1)
  workers[0].reply()
  expect(workers[0].sent).toHaveLength(2)
  workers[0].reply(); await c
})

test('deadline rejects callers but retains the worker slot until its late response', async () => {
  const { client, workers } = fixture(20)
  const a = client.get(ref).catch(e => e.code)
  const b = client.get(ref).catch(e => e.code)
  expect(await a).toBe('BUSY'); expect(await b).toBe('BUSY')
  expect(workers[0].terminated).toBe(false)
  expect(workers).toHaveLength(1)
  await expect(client.get(ref)).rejects.toHaveProperty('code', 'BUSY')
  workers[0].reply()
  const next = client.get(ref)
  workers[0].reply()
  expect(await next).toEqual(new Uint8Array([1]))
  expect(workers).toHaveLength(1)
})

test('dispose rejects active and queued work and prohibits respawn', async () => {
  const { client, workers } = fixture()
  const a = client.get(ref).catch(e => e.code), b = client.get(ref).catch(e => e.code)
  client.dispose()
  expect(await a).toBe('STOPPED'); expect(await b).toBe('STOPPED')
  expect(workers[0].shutdown).toBe(true)
  expect(workers[0].terminated).toBe(false)
  await expect(client.get(ref)).rejects.toHaveProperty('code', 'BUSY')
})

test('worker failure disables previews without spawning replacement workers', async () => {
  const { client, workers } = fixture()
  const first = client.get(ref).catch(error => error.code)
  const queued = client.get(ref).catch(error => error.code)
  workers[0].onerror!()
  expect(await first).toBe('STOPPED'); expect(await queued).toBe('STOPPED')
  await expect(client.get(ref)).rejects.toHaveProperty('code', 'BUSY')
  expect(workers).toHaveLength(1)
  expect(workers[0].terminated).toBe(false)
  expect(workers[0].shutdown).toBe(true)
})
