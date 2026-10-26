import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import MediaLightbox, { type MediaLightboxProps } from '../components/MediaLightbox'
import type { SessionMedia } from '@shared/types'

const globalAny = globalThis as unknown as Record<string, unknown>
const originals = { document: globalAny.document, window: globalAny.window, fetch: globalThis.fetch }
const media = (over: Partial<SessionMedia> = {}): SessionMedia => ({
  kind: 'image', url: '/api/session-media/session?offset=1&digest=abc', label: 'Screenshot', mediaType: 'image/png', bytes: 2 * 1024 * 1024, ...over,
})
let renderer: TestRenderer.ReactTestRenderer | undefined
let win: EventTarget, calls: { url: string; signal: AbortSignal }[]
let respond: (signal: AbortSignal) => Promise<Response>
let previous: number, next: number, closed: number, retry: number
let props: MediaLightboxProps
const png = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
async function flush(fn: () => void = () => {}) {
  await act(async () => { fn(); for (let i = 0; i < 30; i++) await Promise.resolve() })
}
async function mount(over: Partial<MediaLightboxProps> = {}, createNodeMock?: TestRenderer.TestRendererOptions['createNodeMock']) {
  props = { media: media(), enabled: true, onClose: () => { closed++ }, onNext: () => { next++ },
    onPrevious: () => { previous++ }, canNext: true, canPrevious: true, navigating: false, ...over }
  await flush(() => { renderer = TestRenderer.create(createElement(MediaLightbox, props), createNodeMock ? { createNodeMock } : undefined) })
}
async function update(over: Partial<MediaLightboxProps>) {
  props = { ...props, ...over }
  await flush(() => renderer!.update(createElement(MediaLightbox, props)))
}
const find = (id: string) => renderer!.root.findAllByProps({ 'data-testid': id })
const button = (label: string) => renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === label || node.children.join('') === label)!
async function key(value: string) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key: value })
  await flush(() => win.dispatchEvent(event))
  return event
}
beforeEach(() => {
  win = new EventTarget(); globalAny.window = win
  globalAny.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  calls = []; previous = 0; next = 0; closed = 0; retry = 0
  respond = async () => png()
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const signal = init!.signal as AbortSignal
    calls.push({ url: String(url), signal }); return respond(signal)
  }) as typeof fetch
})
afterEach(async () => {
  await flush(() => renderer?.unmount()); renderer = undefined
  globalAny.window = originals.window; globalAny.document = originals.document; globalThis.fetch = originals.fetch
})

test('opening a large image loads its original while retaining the cached preview', async () => {
  await mount({ previewSrc: 'blob:tile-cache' })
  expect(calls.map(call => call.url)).toEqual(['blob:tile-cache'])
  expect(find('media-lightbox-preview')).toHaveLength(1)
  expect(find('media-lightbox-original')[0].props.src).toBe(props.media.url + '&delivery=2')
  await flush(() => find('media-lightbox-original')[0].props.onLoad())
  expect(find('media-lightbox-preview')).toHaveLength(0)
})

test('local and external images load only the selected original', async () => {
  await mount({ media: media({ bytes: 1000, width: 96, height: 48 }) })
  expect(find('media-lightbox-original')[0].props.src).toBe(props.media.url + '&delivery=2')
  expect(calls).toHaveLength(0)
  await update({ media: media({ url: 'https://example.com/image.png', bytes: 100 }) })
  expect(calls).toHaveLength(0)
  expect(find('media-lightbox-original')).toHaveLength(1)
  expect(find('media-lightbox-original')[0].props.src).toBe('https://example.com/image.png')
})

test('originals unmount while backgrounded and stale loads cannot complete a resumed selection', async () => {
  await mount()
  const staleLoad = find('media-lightbox-original')[0].props.onLoad
  await update({ enabled: false })
  expect(find('media-lightbox-original')).toHaveLength(0)
  await update({ enabled: true })
  await flush(staleLoad)
  expect(find('media-lightbox-original')[0].props.className).toContain('invisible')
  await update({ media: media({ url: '/api/session-media/session?offset=2&digest=def' }) })
  expect(find('media-lightbox-original')).toHaveLength(1)
  expect(find('media-lightbox-original')[0].props.src).toBe(props.media.url + '&delivery=2')
})

test('previous/next buttons and arrow keys respect boundaries, loading and readiness', async () => {
  await mount()
  await flush(() => button('Previous image').props.onClick())
  await flush(() => button('Next image').props.onClick())
  expect(previous).toBe(1); expect(next).toBe(1)
  let leaked = 0
  win.addEventListener('keydown', () => { leaked++ })
  expect((await key('ArrowLeft')).defaultPrevented).toBe(true)
  await key('ArrowRight')
  expect(previous).toBe(2); expect(next).toBe(2); expect(leaked).toBe(0)
  await update({ navigating: true })
  expect(button('Next image').props.disabled).toBe(true)
  await key('ArrowRight'); expect(next).toBe(2)
  await update({ navigating: false, canPrevious: false, enabled: false })
  expect(button('Previous image').props.disabled).toBe(true)
  await key('ArrowLeft'); expect(previous).toBe(2)
  await key('Escape'); expect(closed).toBe(1); expect(leaked).toBe(0)
})

test('typing is stopped at the dialog boundary and navigation errors offer manual retry', async () => {
  await mount({ navigationError: 'Could not load image', onRetryNavigation: () => { retry++ } })
  let stopped = 0
  find('media-lightbox')[0].props.onKeyDown({ key: 'a', stopPropagation: () => { stopped++ } })
  expect(stopped).toBe(1)
  await flush(() => button('Retry navigation').props.onClick()); expect(retry).toBe(1)
})

test('backgrounding aborts optional thumbnails and ignores late responses', async () => {
  let complete!: (response: Response) => void
  respond = () => new Promise(resolve => { complete = resolve })
  await mount({ previewSrc: 'blob:tile-cache' })
  expect(calls).toHaveLength(1)
  await update({ enabled: false })
  expect(calls[0].signal.aborted).toBe(true)
  await flush(() => complete(png()))
  expect(find('media-lightbox-preview')[0].props.src).toBe('blob:tile-cache')
  respond = async () => png()
  await update({ enabled: true })
  expect(calls).toHaveLength(2)
  expect(find('media-lightbox-preview')).toHaveLength(1)
})

test('a failed preview does not block originals; failed originals offer explicit retry', async () => {
  respond = async () => new Response('', { status: 422 })
  await mount({ previewSrc: 'blob:tile-cache' })
  expect(find('media-lightbox-preview')).toHaveLength(0)
  expect(find('media-lightbox-original')).toHaveLength(1)
  expect(renderer!.root.findByType('a').props.href).toBe(props.media.url + '&delivery=2')
  await update({ enabled: false }); await update({ enabled: true })
  expect(calls).toHaveLength(2)
  await flush(() => find('media-lightbox-original')[0].props.onError())
  expect(button('Retry full image')).toBeDefined()
})


test('navigation moves focus before disabling buttons and fences body-targeted keyboard events', async () => {
  const doc = globalAny.document as { activeElement: unknown }
  let focused = 0
  const first = { tabIndex: 0, getAttribute: () => null, focus: () => { doc.activeElement = first } }
  const panel = { focus: () => { focused++; doc.activeElement = panel },
    contains: (target: unknown) => {
      if (target === win) throw new Error('Window is not a Node')
      return target === panel || target === first
    }, querySelectorAll: () => [first] }
  await mount({ onNext: () => { expect(doc.activeElement).toBe(panel); next++ } },
    element => element.props['data-testid'] === 'media-lightbox' ? panel : null)
  await flush(() => button('Next image').props.onClick())
  expect(next).toBe(1)
  expect(focused).toBe(1)
  doc.activeElement = {}
  await update({ navigating: true })
  expect(doc.activeElement).toBe(panel)
  let leaked = 0
  win.addEventListener('keydown', () => { leaked++ })
  expect((await key('a')).defaultPrevented).toBe(true)
  expect(leaked).toBe(0)
  await key('Tab')
  expect(doc.activeElement).toBe(first)
})


test('initial navigation loading does not steal focus before the opener is captured', async () => {
  let focused = 0
  const panel = { focus: () => { focused++ }, contains: () => false }
  await mount({ navigating: true }, element => element.props['data-testid'] === 'media-lightbox' ? panel : null)
  expect(focused).toBe(0)
  await update({ navigating: false })
  await update({ navigating: true })
  expect(focused).toBe(1)
})
