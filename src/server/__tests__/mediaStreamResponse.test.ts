import { expect, test } from 'bun:test'
import { mediaStreamResponse } from '../mediaStreamResponse'
import { MEDIA_PAGE_BYTES, type MediaPage, type MediaStreamEvent } from '../../shared/media'

const page: MediaPage & { discovery: { status: 'ready' } } = {
  identity: 'one', revision: '1', total: 0, items: [], nextCursor: null, discovery: { status: 'ready' },
}
const snapshot = (): MediaStreamEvent => ({ type: 'snapshot', page })
const decode = (body: string): MediaStreamEvent[] => body.trim().split('\n').map(line => JSON.parse(line))
const signal = () => new AbortController().signal

test('stream emits cached snapshot, bounded progress and exactly one completion frame', async () => {
  let stopped = false
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true,
    watch: async function* (abort) {
      abort.addEventListener('abort', () => { stopped = true })
      yield snapshot()
      yield { type: 'progress', summary: { identity: 'one', revision: '2', total: 1, images: 1, documents: 0,
        links: 0, additions: 1, discovery: { status: 'ready' } } }
      yield { type: 'done' }
    },
  })
  expect(response.headers.get('content-type')).toContain('application/x-ndjson')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(decode(await response.text()).map(event => event.type)).toEqual(['snapshot', 'progress', 'done'])
  expect(stopped).toBe(true)
})

test('body cancellation aborts discovery without waiting for an uncooperative next', async () => {
  let observed: AbortSignal | undefined
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true,
    watch: async function* (abort) { observed = abort; yield snapshot(); await new Promise(() => {}) },
  })
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel()
  expect(observed?.aborted).toBe(true)
})

test('request abort terminates pending discovery and releases the response', async () => {
  const request = new AbortController()
  let observed: AbortSignal | undefined
  const response = mediaStreamResponse({ signal: request.signal, isCurrent: () => true,
    watch: async function* (abort) { observed = abort; await new Promise(() => {}); yield snapshot() },
  })
  const reading = response.text()
  await Promise.resolve()
  request.abort()
  expect(await reading).toBe('')
  expect(observed?.aborted).toBe(true)
})

test('deadline finishes even if producer ignores abort and next never settles', async () => {
  let observed: AbortSignal | undefined
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true, lifetimeMs: 5,
    watch: async function* (abort) { observed = abort; await new Promise(() => {}); yield snapshot() },
  })
  const events = decode(await response.text())
  expect(events.map(event => event.type)).toEqual(['error', 'done'])
  expect(events[0]).toMatchObject({ message: expect.stringContaining('timed out') })
  expect(observed?.aborted).toBe(true)
})

test('slow consumers cannot make the route pull an unbounded producer queue', async () => {
  let pulled = 0
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true,
    watch: async function* () { while (true) { pulled++; yield snapshot() } },
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(pulled).toBe(1)
  await response.body!.cancel()
})

test('total stream budget leaves room for a valid final done frame', async () => {
  let pulled = 0
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true, byteLimit: 1024,
    watch: async function* () { while (true) { pulled++; yield snapshot() } },
  })
  const body = await response.text()
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024)
  expect(decode(body).at(-1)?.type).toBe('done')
  expect(pulled).toBeLessThan(10)
})

test('an oversized snapshot is replaced by a small safe error and completion', async () => {
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true,
    watch: async function* () {
      yield { type: 'snapshot', page: { ...page, items: [{ kind: 'link', url: 'x'.repeat(MEDIA_PAGE_BYTES) }] } }
    },
  })
  const body = await response.text()
  expect(Buffer.byteLength(body)).toBeLessThan(256)
  expect(decode(body).map(event => event.type)).toEqual(['error', 'done'])
})

test('reassociation rejects the frame after the asynchronous boundary', async () => {
  let current = true
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => current,
    watch: async function* () { yield snapshot(); current = false; yield snapshot() },
  })
  const events = decode(await response.text())
  expect(events.map(event => event.type)).toEqual(['snapshot', 'error', 'done'])
  expect(events[1]).toMatchObject({ code: 'STALE_CURSOR' })
})

test('worker failure and error frames cannot expose paths or arbitrary exception text', async () => {
  for (const emitted of [false, true]) {
    const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true,
      watch: async function* () {
        if (emitted) yield { type: 'error', message: '/private/transcript/secret', code: 'SQLITE_PRIVATE' }
        else throw Error('/private/transcript/secret')
      },
    })
    const body = await response.text()
    expect(body).not.toContain('/private')
    expect(body).not.toContain('SQLITE_PRIVATE')
    expect(decode(body).map(event => event.type)).toEqual(['error', 'done'])
  }
})

test('subscription expiry after a snapshot completes cleanly so the client can renew', async () => {
  let aborted = false
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => true, lifetimeMs: 5,
    watch: async function* (abort) {
      abort.addEventListener('abort', () => { aborted = true })
      yield { type: 'snapshot', page: { ...page, discovery: { status: 'pending' } } }
      await new Promise(() => {})
    },
  })
  expect(decode(await response.text()).map(event => event.type)).toEqual(['snapshot', 'done'])
  expect(aborted).toBe(true)
})

test('subscription expiry does not renew an obsolete session identity', async () => {
  let current = true
  const response = mediaStreamResponse({ signal: signal(), isCurrent: () => current, lifetimeMs: 5,
    watch: async function* () { yield snapshot(); current = false; await new Promise(() => {}) },
  })
  expect(decode(await response.text())[1]).toMatchObject({ type: 'error', code: 'STALE_CURSOR' })
})
