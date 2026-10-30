import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session, SessionMedia } from '@shared/types'
import type { MediaPage, MediaSummary } from '@shared/media'
import MediaRail from '../components/MediaRail'

const imageMedia = (over: Partial<SessionMedia> = {}): SessionMedia => ({
  kind: 'image', url: '/api/session-media/s?path=x&offset=1&index=0',
  mediaType: 'image/png', bytes: 268, label: 'shot.png', width: 96, height: 48, ...over,
})
const summary = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  identity: 'identity-s', revision: 'r1', total: 1, images: 1, documents: 0, links: 0, additions: 1, ...over,
})
const session = (over: Partial<Session> = {}): Session => ({
  id: 'window', agentSessionId: 's', logFilePath: '/log', mediaSummary: summary(), ...over,
}) as Session
const page = (over: Partial<MediaPage> = {}): MediaPage => ({
  identity: 'identity-s', revision: 'r1', total: 1, items: [imageMedia()], nextCursor: null, ...over,
})
const many = (start: number, count = 40) => Array.from({ length: count }, (_, i) => imageMedia({ url: `/api/session-media/s?offset=${start + i}`, label: `item-${start + i}` }))
const globalAny = globalThis as unknown as Record<string, unknown>
const originals = { window: globalAny.window, document: globalAny.document, fetch: globalThis.fetch }
let win: EventTarget & { open: (url: string) => void }
let doc: EventTarget & { visibilityState: string }
let opened: string[], requests: { url: string; signal?: AbortSignal | null }[]
let respond: (url: string, init?: RequestInit) => Promise<Response>
let renderers: TestRenderer.ReactTestRenderer[]
const find = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAllByProps({ 'data-testid': id })
const button = (r: TestRenderer.ReactTestRenderer, text: string) => r.root.findAllByType('button').find(b => b.props['aria-label'] === text || b.children.join('') === text)!
async function flush(fn: () => void = () => {}) { await act(async () => { fn(); for (let i = 0; i < 20; i++) await Promise.resolve() }) }
function render(value = session(), ready = true) {
  let r!: TestRenderer.ReactTestRenderer
  act(() => { r = TestRenderer.create(createElement(MediaRail, { session: value, ready })) })
  renderers.push(r)
  return r
}
const open = (r: TestRenderer.ReactTestRenderer) => flush(() => find(r, 'media-rail-pill')[0].props.onClick())
const update = (r: TestRenderer.ReactTestRenderer, value: Session, ready = true) => flush(() => r.update(createElement(MediaRail, { session: value, ready })))
const response = (value: MediaPage) => Promise.resolve(Response.json(value))
function scroll(r: TestRenderer.ReactTestRenderer, left = 2000) {
  return flush(() => find(r, 'media-scroll')[0].props.onScroll({ currentTarget: { scrollLeft: left, clientWidth: 320, scrollWidth: left + 400 } }))
}

beforeEach(() => {
  opened = []; requests = []; renderers = []
  win = Object.assign(new EventTarget(), { open: (url: string) => { opened.push(url) } })
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalAny.window = win; globalAny.document = doc
  respond = async () => Response.json(page())
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), signal: init?.signal })
    return respond(String(input), init)
  }) as typeof fetch
})
afterEach(() => {
  act(() => renderers.forEach(r => r.unmount()))
  globalAny.window = originals.window; globalAny.document = originals.document; globalThis.fetch = originals.fetch
  jest.useRealTimers()
})

describe('scroll-driven MediaRail', () => {
  test('closed, empty, remote, and legacy embedded media never fetch', () => {
    render()
    expect(find(render(session({ mediaSummary: undefined, media: [imageMedia()] })), 'media-rail-pill')).toHaveLength(1)
    expect(find(render(session({ mediaSummary: summary({ total: 0 }) })), 'media-rail-pill')).toHaveLength(1)
    expect(render(session({ remote: true })).toJSON()).toBeNull()
    expect(requests).toHaveLength(0)
  })

  test('reports skipped transcript records while allowing discovery on open', async () => {
    const incomplete = summary({ total: 0, images: 0, additions: 0, omittedRecords: 2 })
    const r = render(session({ mediaSummary: incomplete }))
    expect(find(r, 'media-incomplete')).toHaveLength(0)
    respond = () => response(page({ total: 0, items: [] }))
    await open(r)
    expect(find(r, 'media-incomplete')[0].children.join('')).toContain('2 oversized transcript entries were skipped')
    expect(requests).toHaveLength(1)
    expect(find(r, 'media-thumb')).toHaveLength(0)
    const complete = render()
    await open(complete)
    expect(find(complete, 'media-incomplete')).toHaveLength(0)
  })

  test('summary counts render without downloading descriptors; only opening fetches', async () => {
    const r = render(session({ mediaSummary: summary({ total: 3, images: 2, links: 1 }) }))
    const text = find(r, 'media-rail-pill')[0].findAllByType('span').map(s => s.children.join('')).join('')
    expect(text).toBe('Media21')
    expect(requests).toHaveLength(0)
    await open(r)
    expect(requests.map(r => r.url)).toEqual(['/api/session-media/s/items?stream=1&kind=media'])
    expect(find(r, 'media-thumb')).toHaveLength(1)
    await flush(() => button(r, 'Collapse media rail').props.onClick())
    await open(r)
    expect(requests).toHaveLength(1)
  })

  test('waits for terminal readiness, then loads exactly one page', async () => {
    const r = render(session(), false)
    await open(r)
    expect(requests).toHaveLength(0)
    await update(r, session(), true)
    expect(requests).toHaveLength(1)
  })

  test('next page loads on forward scroll, never merely because nextCursor exists', async () => {
    respond = url => response(url.includes('cursor=next') ? page({ items: many(40), total: 80 }) : page({ items: many(0), total: 80, nextCursor: 'next' }))
    const r = render(session({ mediaSummary: summary({ total: 80, images: 80 }) }))
    await open(r); await flush()
    expect(requests).toHaveLength(1)
    expect(find(r, 'media-thumb')).toHaveLength(40)
    await scroll(r)
    expect(requests).toHaveLength(2)
    expect(find(r, 'media-thumb')).toHaveLength(80)
  })

  test('caps mounted pages and can browse back to an evicted earlier page', async () => {
    respond = url => {
      const cursor = new URL(url, 'http://localhost').searchParams.get('cursor')
      const n = cursor ? Number(cursor) : 0
      return response(page({ items: many(n * 40), total: 240, nextCursor: String(n + 1) }))
    }
    const r = render(session({ mediaSummary: summary({ total: 240, images: 240 }) }))
    await open(r)
    for (let i = 0; i < 4; i++) await flush(() => button(r, 'Load older media').props.onClick())
    expect(find(r, 'media-thumb')).toHaveLength(120)
    expect(find(r, 'media-thumb')[0].props.title).toContain('item-80')
    await flush(() => button(r, 'Newer media').props.onClick())
    expect(find(r, 'media-thumb')).toHaveLength(120)
    expect(find(r, 'media-thumb')[0].props.title).toContain('item-40')
  })

  test('append changes summary but never replaces or fetches pages until Refresh', async () => {
    const r = render()
    await open(r)
    await update(r, session({ mediaSummary: summary({ revision: 'r2', total: 2, additions: 2 }) }))
    expect(requests).toHaveLength(1)
    expect(find(r, 'media-thumb')).toHaveLength(1)
    respond = () => response(page({ revision: 'r2', total: 2, items: many(0, 2) }))
    await flush(() => button(r, 'Refresh media').props.onClick())
    expect(requests).toHaveLength(2)
    expect(find(r, 'media-thumb')).toHaveLength(2)
  })

  test('a first page overtaken by a same-count rewrite stays visibly stale without fetching again', async () => {
    let complete!: (r: Response) => void
    respond = () => new Promise(resolve => { complete = resolve })
    const r = render()
    await open(r)
    await update(r, session({ mediaSummary: summary({ revision: 'r2' }) }))
    await flush(() => complete(Response.json(page({ revision: 'r1' }))))
    expect(find(r, 'media-thumb')).toHaveLength(1)
    expect(button(r, 'Refresh media')).toBeDefined()
    expect(requests).toHaveLength(1)
    await scroll(r)
    expect(requests).toHaveLength(1)
  })

  test('first page ahead of the summary is accepted without a spurious refresh', async () => {
    respond = () => response(page({ revision: 'r2' }))
    const r = render()
    await open(r)
    expect(find(r, 'media-thumb')).toHaveLength(1)
    expect(button(r, 'Refresh media')).toBeUndefined()
    await update(r, session({ mediaSummary: summary({ revision: 'r2' }) }))
    expect(button(r, 'Refresh media')).toBeUndefined()
    expect(requests).toHaveLength(1)
  })

  test('stale cursor stops automatic scrolling retries and preserves current items', async () => {
    respond = url => url.includes('cursor=') ? Promise.resolve(new Response('', { status: 409 })) : response(page({ nextCursor: 'next' }))
    const r = render()
    await open(r); await scroll(r)
    expect(requests).toHaveLength(2)
    expect(find(r, 'media-thumb')).toHaveLength(1)
    expect(r.root.findByProps({ role: 'alert' }).children.join('')).toContain('Media changed')
    await scroll(r, 2500)
    expect(requests).toHaveLength(2)
  })

  test('late response after transcript rematch cannot populate the new view', async () => {
    let complete!: (r: Response) => void
    respond = () => new Promise(resolve => { complete = resolve })
    const r = render()
    await open(r)
    const oldSignal = requests[0].signal
    await update(r, session({ agentSessionId: 'other', mediaSummary: summary({ identity: 'identity-other' }) }))
    expect(oldSignal?.aborted).toBe(true)
    await flush(() => complete(Response.json(page())))
    expect(find(r, 'media-rail')).toHaveLength(0)
    expect(find(r, 'media-thumb')).toHaveLength(0)
    expect(requests).toHaveLength(1)
  })

  test('hide aborts pending work; resume does not refetch unchanged cached pages', async () => {
    const r = render()
    await open(r)
    await flush(() => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')) })
    await flush(() => { doc.visibilityState = 'visible'; win.dispatchEvent(new Event('pageshow')) })
    expect(requests).toHaveLength(1)
    let complete!: (r: Response) => void
    respond = () => new Promise(resolve => { complete = resolve })
    await flush(() => button(r, 'Collapse media rail').props.onClick())
    await update(r, session({ mediaSummary: summary({ revision: 'r2' }) }))
    await open(r)
    await flush(() => button(r, 'Refresh media').props.onClick())
    await flush(() => win.dispatchEvent(new Event('pagehide')))
    expect(requests[1].signal?.aborted).toBe(true)
    await flush(() => complete(Response.json(page({ revision: 'r2', items: many(2, 2) }))))
    expect(find(r, 'media-thumb')).toHaveLength(1)
    expect(find(r, 'media-thumb')[0].props['data-preview-state']).toBe('idle')
    await flush(() => win.dispatchEvent(new Event('pageshow')))
    expect(find(r, 'media-thumb')).toHaveLength(1)
    expect(requests).toHaveLength(2)
  })

  test('aborted first page resumes only after foreground and terminal readiness', async () => {
    let complete!: (r: Response) => void
    respond = () => new Promise(resolve => { complete = resolve })
    const r = render()
    await open(r)
    await flush(() => win.dispatchEvent(new Event('pagehide')))
    expect(requests[0].signal?.aborted).toBe(true)
    await update(r, session(), false)
    await flush(() => win.dispatchEvent(new Event('pageshow')))
    expect(requests).toHaveLength(1)
    await flush(() => complete(Response.json(page())))
    respond = () => response(page())
    await update(r, session(), true)
    expect(requests).toHaveLength(2)
    expect(find(r, 'media-thumb')).toHaveLength(1)
  })

  test('local images use thumbnail tiles regardless of original size; external images require a gesture', async () => {
    const data = [imageMedia(), imageMedia({ bytes: 65537 }), imageMedia({ bytes: undefined }),
      imageMedia({ url: 'https://example.com/image.png' }), imageMedia({ width: 10000, height: 10000 })]
    respond = () => response(page({ items: data, total: data.length }))
    const r = render(); await open(r)
    expect(find(r, 'media-thumb')).toHaveLength(4)
    expect(find(r, 'media-chip')).toHaveLength(1)
    expect(r.root.findAllByType('img')).toHaveLength(0)
    await flush(() => find(r, 'media-chip')[0].props.onClick({ currentTarget: { focus() {} } }))
    expect(opened).toEqual([])
    expect(find(r, 'media-lightbox')).toHaveLength(1)
    expect(find(r, 'media-lightbox-original')).toHaveLength(1)
  })

  test('all local images load the selected full-size original when opened', async () => {
    const data = [imageMedia({ url: '/api/session-media/s?index=0', bytes: 65537 }),
      imageMedia({ url: '/api/session-media/s?index=1', bytes: undefined }),
      imageMedia({ url: '/api/session-media/s?index=2', width: 10000, height: 10000 })]
    respond = () => response(page({ items: data, total: data.length }))
    const r = render(); await open(r)
    expect(find(r, 'media-thumb')).toHaveLength(3)
    for (const tile of find(r, 'media-thumb')) {
      expect(tile.props['aria-label']).toContain('Open image')
      await flush(() => tile.props.onClick({ currentTarget: { focus() {} } }))
      expect(find(r, 'media-lightbox')).toHaveLength(1)
      expect(find(r, 'media-lightbox-original')).toHaveLength(1)
      await flush(() => button(r, 'Close image viewer').props.onClick())
    }
    expect(opened).toEqual([])
    expect(r.root.findAllByType('img')).toHaveLength(0)
  })

  test('lightbox opens only by gesture and Escape closes before terminal handling', async () => {
    const r = render(); await open(r)
    expect(find(r, 'media-lightbox')).toHaveLength(0)
    await flush(() => find(r, 'media-thumb')[0].props.onClick({ currentTarget: { focus() {} } }))
    expect(find(r, 'media-lightbox')).toHaveLength(1)
    await flush(() => { const event = new Event('keydown'); Object.assign(event, { key: 'Escape' }); win.dispatchEvent(event) })
    expect(find(r, 'media-lightbox')).toHaveLength(0)
  })

  test('removing all images closes the viewer and later additions do not reopen it', async () => {
    const r = render(); await open(r)
    await flush(() => find(r, 'media-thumb')[0].props.onClick({ currentTarget: { focus() {} } }))
    expect(find(r, 'media-lightbox')).toHaveLength(1)
    await update(r, session({ mediaSummary: summary({ total: 0, images: 0, revision: 'r2' }) }))
    expect(find(r, 'media-lightbox')).toHaveLength(0)
    await update(r, session({ mediaSummary: summary({ revision: 'r3', additions: 2 }) }))
    expect(find(r, 'media-lightbox')).toHaveLength(0)
  })

  test('summary hydration is quiet; additions pulse even without a count change', async () => {
    jest.useFakeTimers()
    const r = render(session({ mediaSummary: undefined }))
    await update(r, session())
    expect(find(r, 'media-rail-new-dot')).toHaveLength(0)
    await update(r, session({ mediaSummary: summary({ revision: 'r2', additions: 2 }) }))
    expect(find(r, 'media-rail-new-dot')).toHaveLength(1)
    expect(find(r, 'media-rail-pill')[0].props.className).toContain('media-attention')
    act(() => { jest.advanceTimersByTime(1600) })
    expect(find(r, 'media-rail-pill')[0].props.className).not.toContain('media-attention')
    await update(r, session({ mediaSummary: summary({ revision: 'r3', additions: 2 }) }))
    expect(find(r, 'media-rail-pill')[0].props.className).not.toContain('media-attention')
    expect(requests).toHaveLength(0)
  })

  test('oversized responses and wrong identities fail closed without retrying', async () => {
    respond = async () => new Response('x'.repeat(65537))
    const r = render(); await open(r); await flush()
    expect(requests).toHaveLength(1)
    expect(find(r, 'media-thumb')).toHaveLength(0)
    respond = () => response(page({ identity: 'wrong' }))
    await flush(() => button(r, 'Refresh media').props.onClick())
    expect(requests).toHaveLength(2)
    expect(find(r, 'media-thumb')).toHaveLength(0)
  })
})

function discoveryStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  return {
    response: new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    send(value: unknown) { controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n')) },
    end() { controller.enqueue(new TextEncoder().encode('{"type":"done"}\n')); controller.close() },
  }
}
const indexing = { status: 'indexing' as const, bytesRead: 10, bytesTotal: 100, filesDone: 0, filesTotal: 2 }
const snapshot = (over: Partial<MediaPage> = {}) => ({ type: 'snapshot', page: page({ discovery: indexing, ...over }) })
const progress = (over: Partial<MediaSummary> = {}) => ({ type: 'progress', summary: summary({ discovery: indexing, ...over }) })

describe('progressive discovery', () => {
  test('unknown opens, partial empty becomes visible, hydration preserves the panel and first nonempty page freezes', async () => {
    const stream = discoveryStream(); respond = async () => stream.response
    const r = render(session({ mediaSummary: undefined }))
    await open(r)
    expect(requests).toHaveLength(1)
    await flush(() => stream.send(snapshot({ total: 0, items: [] })))
    expect(JSON.stringify(r.toJSON())).toContain('Finding ')
    expect(JSON.stringify(r.toJSON())).not.toContain('No media in this session')
    await flush(() => stream.send(snapshot()))
    expect(find(r, 'media-thumb')).toHaveLength(1)
    await update(r, session({ mediaSummary: summary({ discovery: indexing }) }))
    expect(find(r, 'media-rail')).toHaveLength(1)
    expect(requests).toHaveLength(1)
    await flush(() => stream.send(progress({ revision: 'r2', total: 2, images: 2, additions: 2 })))
    await flush(() => stream.send(snapshot({ revision: 'r2', items: many(10, 2) })))
    expect(find(r, 'media-thumb')).toHaveLength(1)
    expect(button(r, 'Refresh media')).toBeDefined()
    await flush(() => { stream.send(progress({ revision: 'r2', discovery: { status: 'ready' } })); stream.end() })
    expect(JSON.stringify(r.toJSON())).not.toContain('Finding ')
    expect(find(r, 'media-thumb')).toHaveLength(1)
  })

  test('failed discovery preserves visible items and permits explicit retry', async () => {
    const stream = discoveryStream(); respond = async () => stream.response
    const r = render(); await open(r)
    await flush(() => stream.send(snapshot()))
    await flush(() => stream.send({ type: 'error', message: 'Index unavailable. Retry.' }))
    expect(find(r, 'media-thumb')).toHaveLength(1)
    expect(JSON.stringify(r.toJSON())).toContain('Index unavailable')
    respond = () => response(page({ items: many(2, 2) }))
    await flush(() => button(r, 'Refresh media').props.onClick())
    expect(find(r, 'media-thumb')).toHaveLength(2)
  })

  test('closing aborts discovery and late frames cannot replace cached rows', async () => {
    const stream = discoveryStream(); respond = async () => stream.response
    const r = render(); await open(r)
    await flush(() => stream.send(snapshot()))
    await flush(() => button(r, 'Collapse media rail').props.onClick())
    expect(requests[0].signal?.aborted).toBe(true)
    await flush(() => { stream.send(snapshot({ items: many(4, 2) })); stream.end() })
    expect(find(r, 'media-rail')).toHaveLength(0)
    expect(requests).toHaveLength(1)
  })

  test('completed empty is distinct from partial empty and remains accessible', async () => {
    respond = () => response(page({ total: 0, items: [] }))
    const r = render(session({ mediaSummary: summary({ total: 0, images: 0 }) }))
    await open(r)
    expect(JSON.stringify(r.toJSON())).toContain('No media in this session yet.')
    await flush(() => button(r, 'Collapse media rail').props.onClick())
    expect(find(r, 'media-rail-pill')).toHaveLength(1)
  })
})

test('foreground resumes partial discovery after terminal readiness without replacing visible rows', async () => {
  const first = discoveryStream(), second = discoveryStream()
  respond = async () => first.response
  const r = render(); await open(r)
  await flush(() => first.send(snapshot()))
  await flush(() => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')) })
  expect(requests[0].signal?.aborted).toBe(true)
  await update(r, session(), false)
  respond = async () => second.response
  await flush(() => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')) })
  expect(requests).toHaveLength(1)
  await update(r, session(), true)
  expect(requests).toHaveLength(2)
  await flush(() => second.send(snapshot({ revision: 'r2', items: many(4, 2) })))
  expect(find(r, 'media-thumb')).toHaveLength(1)
  await flush(() => {
    second.send(progress({ revision: 'r2', discovery: { status: 'ready' } }))
    second.end(); first.end()
  })
  expect(button(r, 'Refresh media')).toBeDefined()
  expect(find(r, 'media-thumb')).toHaveLength(1)
})

test('catalog hydration preserves the image selection discovered through an unknown summary', async () => {
  const stream = discoveryStream()
  respond = async url => url.includes('/neighbors?')
    ? Response.json({ identity: 'identity-s', revision: 'r1', current: imageMedia(), previous: null, next: null })
    : stream.response
  const r = render(session({ mediaSummary: undefined })); await open(r)
  await flush(() => stream.send(snapshot()))
  await flush(() => find(r, 'media-thumb')[0].props.onClick({ currentTarget: { focus() {} } }))
  expect(find(r, 'media-lightbox')).toHaveLength(1)
  await update(r, session({ mediaSummary: summary({ discovery: indexing }) }))
  expect(find(r, 'media-lightbox')).toHaveLength(1)
  await flush(() => { stream.send(progress({ discovery: { status: 'ready' } })); stream.end() })
})

test('finite incomplete discovery continues three times retaining rows, then offers retry without looping', async () => {
  jest.useFakeTimers()
  const streams = Array.from({ length: 4 }, () => discoveryStream())
  let index = 0
  respond = async () => streams[index++].response
  const r = render(); await open(r)
  await flush(() => { streams[0].send(snapshot()); streams[0].end() })
  for (let i = 1; i <= 3; i++) {
    expect(requests).toHaveLength(i)
    await flush(() => jest.advanceTimersByTime(250 * i))
    expect(requests).toHaveLength(i + 1)
    await flush(() => { streams[i].send(snapshot({ items: many(i, 2) })); streams[i].end() })
    expect(find(r, 'media-thumb')).toHaveLength(1)
  }
  expect(JSON.stringify(r.toJSON())).toContain('Discovery is still incomplete. Retry to continue.')
  await flush(() => jest.advanceTimersByTime(10_000))
  expect(requests).toHaveLength(4)
  expect(button(r, 'Refresh media')).toBeDefined()
})

test('synthetic pending zero counts show an unknown count and remain open through hydration', async () => {
  const stream = discoveryStream(); respond = async () => stream.response
  const r = render(session({ mediaSummary: summary({ total: 0, images: 0, additions: 0, discovery: { status: 'pending' } }) }))
  const pill = find(r, 'media-rail-pill')[0]
  expect(pill.props['aria-label']).toBe('Open media')
  expect(pill.findAllByType('span').map(s => s.children.join('')).join('')).toContain('…')
  await open(r)
  await flush(() => { stream.send(snapshot()); stream.send(progress({ discovery: { status: 'ready' } })); stream.end() })
  await update(r, session())
  expect(find(r, 'media-rail')).toHaveLength(1)
  expect(find(r, 'media-thumb')).toHaveLength(1)
})

test('real route lifetime renews an indexing view and retains its rows until completion', async () => {
  const { mediaStreamResponse } = await import('../../server/mediaStreamResponse')
  jest.useFakeTimers()
  let attempt = 0
  respond = async (_url, init) => mediaStreamResponse({
    signal: init!.signal!, isCurrent: () => true, lifetimeMs: 100,
    watch: async function* (abort) {
      const current = ++attempt
      yield { type: 'snapshot', page: { ...page({ items: many(current, 1) }), discovery: indexing } }
      if (current === 1) await new Promise<void>(resolve => abort.addEventListener('abort', () => resolve(), { once: true }))
      else yield { type: 'progress', summary: { ...summary(), discovery: { status: 'ready' } } }
      yield { type: 'done' }
    },
  })
  const r = render(); await open(r)
  expect(find(r, 'media-thumb')).toHaveLength(1)
  await flush(() => jest.advanceTimersByTime(100))
  await flush(() => jest.advanceTimersByTime(250))
  expect(attempt).toBe(2)
  expect(find(r, 'media-thumb')).toHaveLength(1)
  expect(find(r, 'media-thumb')[0].props.title).toBe('item-1 · image/png · 268 B')
  expect(JSON.stringify(r.toJSON())).not.toContain('timed out')
  expect(JSON.stringify(r.toJSON())).not.toContain('Finding ')
})
