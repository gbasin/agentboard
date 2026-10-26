import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createElement, useRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { fetchMediaThumbnail, useMediaThumbnail } from '../hooks/useMediaThumbnail'

const originalFetch = globalThis.fetch
const originalObserver = globalThis.IntersectionObserver
let intersect: (near: boolean) => void
let calls: { url: string; signal: AbortSignal }[]
let respond: (signal: AbortSignal) => Promise<Response>
let renderer: TestRenderer.ReactTestRenderer | undefined
let current: ReturnType<typeof useMediaThumbnail>
let rootOptions: IntersectionObserverInit | undefined
const url = '/api/session-media/s?path=log&offset=0&index=0&digest=abc'
const png = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
async function flush(fn: () => void = () => {}) {
  await act(async () => { fn(); for (let i = 0; i < 30; i++) await Promise.resolve() })
}
function View({ enabled = true, source = url }: { enabled?: boolean; source?: string }) {
  const root = useRef<HTMLDivElement>(null)
  current = useMediaThumbnail(source, enabled, root)
  return createElement('div', { ref: root }, createElement('button', { ref: current.target }))
}
async function mount(enabled = true) {
  await flush(() => { renderer = TestRenderer.create(createElement(View, { enabled }), { createNodeMock: () => ({}) }) })
}
beforeEach(() => {
  calls = []
  respond = async () => png()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init!.signal as AbortSignal })
    return respond(init!.signal as AbortSignal)
  }) as typeof fetch
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      rootOptions = options
      intersect = near => callback([{ isIntersecting: near } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
})
afterEach(async () => {
  await flush(() => renderer?.unmount())
  renderer = undefined
  globalThis.fetch = originalFetch
  globalThis.IntersectionObserver = originalObserver
})

describe('visible media thumbnails', () => {
  test('requests only near the horizontal viewport, never the original', async () => {
    await mount()
    expect(calls).toHaveLength(0)
    expect(rootOptions?.root).toBeDefined()
    expect(rootOptions?.rootMargin).toBe('0px 64px')
    await flush(() => intersect(true))
    expect(calls.map(call => call.url)).toEqual([`${url}&thumbnail=1`])
    expect(current.preview.status).toBe('ready')
    await flush(() => intersect(false))
    await flush(() => intersect(true))
    expect(calls).toHaveLength(1)
  })

  test('readiness loss aborts loading and ignores a late result; resume retries the thumbnail', async () => {
    let complete!: (response: Response) => void
    respond = () => new Promise(resolve => { complete = resolve })
    await mount()
    await flush(() => intersect(true))
    expect(current.preview.status).toBe('loading')
    await flush(() => renderer!.update(createElement(View, { enabled: false })))
    expect(calls[0].signal.aborted).toBe(true)
    await flush(() => complete(png()))
    expect(current.preview.status).toBe('idle')
    respond = async () => png()
    await flush(() => renderer!.update(createElement(View, { enabled: true })))
    expect(calls).toHaveLength(2)
    expect(current.preview.status).toBe('ready')
  })

  test('offscreen cancels pending work and cached thumbnails survive readiness changes', async () => {
    respond = signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    await mount(); await flush(() => intersect(true))
    await flush(() => intersect(false))
    expect(calls[0].signal.aborted).toBe(true)
    expect(current.preview.status).toBe('idle')
    respond = async () => png()
    await flush(() => intersect(true))
    const before = current.preview
    await flush(() => renderer!.update(createElement(View, { enabled: false })))
    await flush(() => renderer!.update(createElement(View, { enabled: true })))
    expect(current.preview).toEqual(before)
    expect(calls).toHaveLength(2)
  })

  test('unsupported or failed previews stop with a stable error, not an original request or retry loop', async () => {
    respond = async () => new Response('', { status: 422 })
    await mount(); await flush(() => intersect(true))
    expect(current.preview.status).toBe('error')
    await flush(() => intersect(false)); await flush(() => intersect(true))
    await flush(() => renderer!.update(createElement(View, { enabled: false })))
    await flush(() => renderer!.update(createElement(View, { enabled: true })))
    expect(calls).toHaveLength(1)
  })

  test('unmount aborts and image decode failures become explicit unavailable state', async () => {
    await mount(); await flush(() => intersect(true))
    await flush(() => current.fail())
    expect(current.preview.status).toBe('error')
    await flush(() => renderer!.unmount())
    expect(calls[0].signal.aborted).toBe(true)
  })

  test('changing the source after success or failure requests the new thumbnail', async () => {
    await mount(); await flush(() => intersect(true))
    expect(current.preview.status).toBe('ready')
    respond = async () => new Response('', { status: 422 })
    await flush(() => renderer!.update(createElement(View, { source: `${url}2` })))
    expect(current.preview.status).toBe('error')
    respond = async () => png()
    await flush(() => renderer!.update(createElement(View, { source: `${url}3` })))
    expect(current.preview.status).toBe('ready')
    expect(calls.map(call => call.url)).toEqual([`${url}&thumbnail=1`, `${url}2&thumbnail=1`, `${url}3&thumbnail=1`])
  })

  test('an already aborted request never reaches fetch', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchMediaThumbnail(url, controller.signal)).rejects.toThrow('Aborted')
    expect(calls).toHaveLength(0)
  })

  test('caps response bytes even when no content length is supplied', async () => {
    respond = async () => new Response(new Uint8Array(128 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } })
    await expect(fetchMediaThumbnail(url, new AbortController().signal)).rejects.toThrow('Preview too large')
  })

  test('limits concurrent fetches and removes aborted queued requests', async () => {
    const completes: (() => void)[] = []
    respond = () => new Promise(resolve => completes.push(() => resolve(png())))
    const controllers = Array.from({ length: 5 }, () => new AbortController())
    const jobs = controllers.map(controller => fetchMediaThumbnail(url, controller.signal).catch(error => error))
    await flush()
    expect(calls).toHaveLength(3)
    controllers[3].abort()
    await flush(() => completes[0]())
    expect(calls).toHaveLength(4)
    await flush(() => completes.slice(1).forEach(done => done()))
    await Promise.all(jobs)
    expect(calls.some(call => call.signal === controllers[3].signal)).toBe(false)
  })
})
