import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useMediaLightboxNavigation } from '../hooks/useMediaLightboxNavigation'
import type { SessionMedia } from '@shared/types'

const image = (n: number): SessionMedia => ({ kind: 'image', url: `/api/session-media/s?offset=${n}`, label: `image-${n}` })
const originalFetch = globalThis.fetch
let view: TestRenderer.ReactTestRenderer
let current: ReturnType<typeof useMediaLightboxNavigation>
let calls: { url: string; signal: AbortSignal }[]
let respond: (url: string) => Promise<Response>
const neighbors = (n: number) => Response.json({ identity: 'identity', revision: 'r1', current: image(n),
  previous: n > 0 ? image(n - 1) : null, next: n < 3 ? image(n + 1) : null })
function View({ enabled = true, id = 's' }: { enabled?: boolean; id?: string }) {
  current = useMediaLightboxNavigation(id, 'identity', enabled)
  return null
}
async function flush(fn: () => void = () => {}) { await act(async () => { fn(); for (let i = 0; i < 30; i++) await Promise.resolve() }) }
beforeEach(async () => {
  calls = []
  respond = async url => {
    const anchor = new URL(url, 'http://local').searchParams.get('anchor')!
    return neighbors(Number(new URL(anchor, 'http://local').searchParams.get('offset')))
  }
  globalThis.fetch = ((url: string, init: RequestInit) => { calls.push({ url, signal: init.signal as AbortSignal }); return respond(url) }) as typeof fetch
  await flush(() => { view = TestRenderer.create(createElement(View)) })
})
afterEach(async () => { await flush(() => view.unmount()); globalThis.fetch = originalFetch })

test('closed viewer makes no requests; direct neighbors support both directions without page scanning', async () => {
  expect(calls).toHaveLength(0)
  await flush(() => current.open(image(0), 'blob:cached'))
  expect(current.selection?.previewSrc).toBe('blob:cached')
  expect(current.canPrevious).toBe(false); expect(current.canNext).toBe(true)
  await flush(() => current.next())
  expect(current.selection?.media.url).toBe(image(1).url)
  expect(current.selection?.previewSrc).toBeUndefined()
  await flush(() => current.previous())
  expect(current.selection?.media.url).toBe(image(0).url)
  expect(calls).toHaveLength(3)
  expect(calls.every(call => call.url.includes('/neighbors?anchor='))).toBe(true)
  await flush(() => current.previous())
  expect(calls).toHaveLength(3)
})

test('late lookup cannot replace navigation for a different selected image', async () => {
  let release!: (response: Response) => void
  respond = () => new Promise(resolve => { release = resolve })
  await flush(() => current.open(image(0)))
  respond = async () => neighbors(3)
  await flush(() => current.open(image(3)))
  expect(calls[0].signal.aborted).toBe(true)
  await flush(() => release(neighbors(0)))
  expect(current.selection?.media.url).toBe(image(3).url)
  expect(current.canNext).toBe(false); expect(current.canPrevious).toBe(true)
})

test('background/recovery aborts pending lookup and resume never advances selection again', async () => {
  await flush(() => current.open(image(0)))
  let release!: (response: Response) => void
  respond = () => new Promise(resolve => { release = resolve })
  await flush(() => current.next())
  expect(current.selection?.media.url).toBe(image(1).url)
  await flush(() => view.update(createElement(View, { enabled: false })))
  expect(calls[1].signal.aborted).toBe(true)
  await flush(() => release(neighbors(1)))
  expect(current.canNext).toBe(false)
  respond = async () => neighbors(1)
  await flush(() => view.update(createElement(View)))
  expect(current.selection?.media.url).toBe(image(1).url)
  expect(current.canNext).toBe(true)
  expect(calls).toHaveLength(3)
})

test('close aborts and session changes reset selection', async () => {
  respond = () => new Promise(() => {})
  await flush(() => current.open(image(0)))
  await flush(() => current.close())
  expect(calls[0].signal.aborted).toBe(true)
  expect(current.selection).toBeNull()
  await flush(() => current.open(image(2)))
  await flush(() => view.update(createElement(View, { id: 'other' })))
  expect(calls[1].signal.aborted).toBe(true)
  expect(current.selection).toBeNull()
})

test('failures stay explicit until manual retry, which preserves selection', async () => {
  respond = async () => new Response('', { status: 503 })
  await flush(() => current.open(image(2)))
  expect(current.navigationError).toContain('Could not load')
  expect(current.canNext).toBe(false)
  expect(calls).toHaveLength(1)
  respond = async () => neighbors(2)
  await flush(() => current.retry())
  expect(current.navigationError).toBeUndefined()
  expect(current.canNext).toBe(true)
  expect(current.selection?.media.url).toBe(image(2).url)
})

test('wrong identity, wrong anchor and oversized responses cannot populate neighbors', async () => {
  for (const response of [
    Response.json({ identity: 'other', revision: 'r1', current: image(0), previous: null, next: image(1) }),
    neighbors(2),
    new Response(' '.repeat(64 * 1024 + 1)),
  ]) {
    respond = async () => response
    await flush(() => current.open(image(0)))
    expect(current.navigationError).toBeDefined()
    expect(current.canNext).toBe(false)
    await flush(() => current.close())
  }
})


test('opening the same image again refreshes navigation instead of leaving controls loading', async () => {
  await flush(() => current.open(image(0)))
  await flush(() => current.open(image(0), 'blob:replacement'))
  expect(current.navigating).toBe(false)
  expect(current.canNext).toBe(true)
  expect(calls).toHaveLength(2)
})


test('external images do not make impossible local navigation requests', async () => {
  await flush(() => current.open({ kind: 'image', url: 'https://example.com/picture.png' }))
  expect(calls).toHaveLength(0)
  expect(current.navigating).toBe(false)
  expect(current.navigationError).toBeUndefined()
  expect(current.canPrevious).toBe(false)
  expect(current.canNext).toBe(false)
})
