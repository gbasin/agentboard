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
    sent: [] as { id: number }[], terminated: false,
    postMessage(message: { id: number }) { this.sent.push(message) },
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

test('deadline terminates stuck worker before dispatching queued work; late reply is ignored', async () => {
  const { client, workers } = fixture(20)
  const a = client.get(ref).catch(e => e.code)
  const stale = workers[0].onmessage!
  const b = client.get(ref)
  expect(await a).toBe('BUSY')
  expect(workers[0].terminated).toBe(true)
  expect(workers).toHaveLength(2)
  stale({ data: { id: 1, body: new Uint8Array([9]) } })
  workers[1].reply()
  expect(await b).toEqual(new Uint8Array([1]))
})

test('dispose rejects active and queued work and prohibits respawn', async () => {
  const { client, workers } = fixture()
  const a = client.get(ref).catch(e => e.code), b = client.get(ref).catch(e => e.code)
  client.dispose()
  expect(await a).toBe('STOPPED'); expect(await b).toBe('STOPPED')
  expect(workers[0].terminated).toBe(true)
  await expect(client.get(ref)).rejects.toHaveProperty('code', 'BUSY')
})
