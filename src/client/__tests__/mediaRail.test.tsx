import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session, SessionMedia } from '@shared/types'
import MediaRail from '../components/MediaRail'

const imageMedia = (over: Partial<SessionMedia> = {}): SessionMedia => ({
  kind: 'image',
  url: '/api/session-media/s?path=x&offset=1&index=0',
  mediaType: 'image/png',
  bytes: 268,
  label: 'Read · shot.png',
  width: 96,
  height: 48,
  ...over,
})

const sessionWith = (
  media: SessionMedia[] | undefined,
  remote = false
): Session => ({ media, remote }) as unknown as Session

type KeydownListener = (e: { key: string; stopPropagation: () => void }) => void
let keydownListeners: KeydownListener[] = []
let openedUrls: string[] = []
const globalAny = globalThis as unknown as Record<string, unknown>
const originalWindow = globalAny.window

function render(session: Session) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(MediaRail, { session }))
  })
  return renderer
}

const findByTestId = (root: TestRenderer.ReactTestRenderer, id: string) =>
  root.root.findAllByProps({ 'data-testid': id })

beforeEach(() => {
  keydownListeners = []
  openedUrls = []
  globalAny.window = {
    addEventListener: (_t: string, fn: KeydownListener) => {
      keydownListeners.push(fn)
    },
    removeEventListener: (_t: string, fn: KeydownListener) => {
      keydownListeners = keydownListeners.filter((f) => f !== fn)
    },
    open: (url: string) => {
      openedUrls.push(url)
      return null
    },
  }
})
afterEach(() => {
  globalAny.window = originalWindow
  jest.useRealTimers()
})

describe('MediaRail', () => {
  test('renders nothing without media or for remote sessions', () => {
    expect(render(sessionWith(undefined)).toJSON()).toBeNull()
    expect(render(sessionWith([])).toJSON()).toBeNull()
    expect(render(sessionWith([imageMedia()], true)).toJSON()).toBeNull()
  })

  test('pill counts images and others separately', () => {
    const r = render(
      sessionWith([
        imageMedia(),
        imageMedia({ url: '/api/session-media/s?path=x&offset=9&index=1' }),
        { kind: 'link', url: 'https://claude.ai/artifact/1', label: 'Board' },
      ])
    )
    const pill = findByTestId(r, 'media-rail-pill')
    expect(pill).toHaveLength(1)
    const text = pill[0]
      .findAllByType('span')
      .map((s) => (s.children as string[]).join(''))
      .join('')
    expect(text).toBe('Media2+1')
  })

  test('expand shows thumbs and chips; collapse returns to pill', () => {
    const r = render(
      sessionWith([
        imageMedia(),
        { kind: 'document', url: '/api/session-media/s?p=d', mediaType: 'application/pdf', bytes: 12 },
        { kind: 'link', url: 'https://x.test', label: 'L' },
      ])
    )
    act(() => findByTestId(r, 'media-rail-pill')[0].props.onClick())
    expect(findByTestId(r, 'media-rail')).toHaveLength(1)
    expect(findByTestId(r, 'media-thumb')).toHaveLength(1)
    expect(findByTestId(r, 'media-chip')).toHaveLength(1) // the document
    expect(r.root.findAllByType('a')).toHaveLength(1) // the link chip

    act(() =>
      r.root.findByProps({ 'aria-label': 'Collapse media rail' }).props.onClick()
    )
    expect(findByTestId(r, 'media-rail')).toHaveLength(0)
    expect(findByTestId(r, 'media-rail-pill')).toHaveLength(1)
  })

  test('oversized images and documents open in a new tab, not the lightbox', () => {
    const big = imageMedia({ bytes: 13 * 1024 * 1024, label: 'big.png' })
    const doc: SessionMedia = {
      kind: 'document',
      url: '/api/session-media/s?p=pdf',
      mediaType: 'application/pdf',
      bytes: 9000,
    }
    const r = render(sessionWith([big, doc]))
    act(() => findByTestId(r, 'media-rail-pill')[0].props.onClick())

    expect(findByTestId(r, 'media-thumb')).toHaveLength(0)
    const chips = findByTestId(r, 'media-chip')
    expect(chips).toHaveLength(2)

    act(() => chips[0].props.onClick())
    act(() => chips[1].props.onClick())
    expect(openedUrls).toEqual([big.url, doc.url])
    expect(findByTestId(r, 'media-lightbox')).toHaveLength(0)
  })

  test('thumbnail opens the lightbox; Escape and backdrop close it', () => {
    const r = render(sessionWith([imageMedia()]))
    act(() => findByTestId(r, 'media-rail-pill')[0].props.onClick())
    act(() => findByTestId(r, 'media-thumb')[0].props.onClick())

    const lightbox = findByTestId(r, 'media-lightbox')
    expect(lightbox).toHaveLength(1)
    const img = lightbox[0].findByType('img')
    expect(img.props.src).toBe(imageMedia().url)

    act(() => {
      keydownListeners.forEach((fn) =>
        fn({ key: 'Escape', stopPropagation: () => {} })
      )
    })
    expect(findByTestId(r, 'media-lightbox')).toHaveLength(0)

    // Reopen; backdrop click closes too.
    act(() => findByTestId(r, 'media-thumb')[0].props.onClick())
    act(() => findByTestId(r, 'media-lightbox')[0].props.onClick())
    expect(findByTestId(r, 'media-lightbox')).toHaveLength(0)
  })

  test('new media appearing on the session surfaces without remount tricks', () => {
    const r = render(sessionWith(undefined))
    expect(r.toJSON()).toBeNull()
    act(() => {
      r.update(createElement(MediaRail, { session: sessionWith([imageMedia()]) }))
    })
    expect(findByTestId(r, 'media-rail-pill')).toHaveLength(1)
  })

  test('existing media is quiet; first live addition pulses and stays unread until opened', () => {
    jest.useFakeTimers()
    const existing = render(sessionWith([imageMedia()]))
    expect(findByTestId(existing, 'media-rail-new-dot')).toHaveLength(0)
    const r = render(sessionWith([]))
    act(() => r.update(createElement(MediaRail, { session: sessionWith([imageMedia()]) })))
    expect(findByTestId(r, 'media-rail-pill')[0].props.className).toContain('media-attention')
    expect(findByTestId(r, 'media-rail-new-dot')).toHaveLength(1)
    act(() => { jest.advanceTimersByTime(1600) })
    expect(findByTestId(r, 'media-rail-pill')[0].props.className).not.toContain('media-attention')
    expect(findByTestId(r, 'media-rail-new-dot')).toHaveLength(1)
    act(() => findByTestId(r, 'media-rail-pill')[0].props.onClick())
    act(() => r.root.findByProps({ 'aria-label': 'Collapse media rail' }).props.onClick())
    expect(findByTestId(r, 'media-rail-new-dot')).toHaveLength(0)
    act(() => r.unmount())
    act(() => existing.unmount())
  })

  test('compares URL identities, groups additions during a pulse, and restarts for later batches', () => {
    jest.useFakeTimers()
    const r = render(sessionWith([imageMedia()]))
    const update = (urls: string[]) => act(() => r.update(createElement(MediaRail, {
      session: sessionWith(urls.map((url) => imageMedia({ url }))),
    })))
    // Same count, new URL is still a new addition.
    update(['new'])
    act(() => { jest.advanceTimersByTime(800) })
    update(['new', 'another'])
    act(() => { jest.advanceTimersByTime(800) })
    expect(findByTestId(r, 'media-rail-pill')[0].props.className).not.toContain('media-attention')
    update(['another', 'new']) // reorder does not restart the animation
    expect(findByTestId(r, 'media-rail-pill')[0].props.className).not.toContain('media-attention')
    update(['another']) // deletion does not restart it either
    expect(findByTestId(r, 'media-rail-pill')[0].props.className).not.toContain('media-attention')
    update(['another', 'new']) // a known URL reappearing is not new
    expect(findByTestId(r, 'media-rail-pill')[0].props.className).not.toContain('media-attention')
    update(['another', 'later'])
    expect(findByTestId(r, 'media-rail-pill')[0].props.className).toContain('media-attention')
    act(() => r.unmount())
  })

  test('session and transcript changes clear unread state and close previews without pulsing', () => {
    jest.useFakeTimers()
    const base = { ...sessionWith([]), id: 'one', agentSessionId: 'agent-one', logFilePath: '/one' }
    const r = render(base)
    const update = (session: Session) => act(() => r.update(createElement(MediaRail, { session })))
    update({ ...base, media: [imageMedia()] })
    expect(findByTestId(r, 'media-rail-new-dot')).toHaveLength(1)
    let current = { ...base, id: 'two', media: [imageMedia()] }
    update(current)
    expect(findByTestId(r, 'media-rail-new-dot')).toHaveLength(0)
    for (const change of [{ agentSessionId: 'agent-two' }, { logFilePath: '/two' }]) {
      act(() => findByTestId(r, 'media-rail-pill')[0].props.onClick())
      act(() => findByTestId(r, 'media-thumb')[0].props.onClick())
      current = { ...current, ...change }
      update(current)
      expect(findByTestId(r, 'media-lightbox')).toHaveLength(0)
      expect(findByTestId(r, 'media-rail')).toHaveLength(0)
      expect(findByTestId(r, 'media-rail-new-dot')).toHaveLength(0)
    }
    act(() => r.unmount())
  })

  test('media arriving while expanded is already seen', () => {
    const r = render(sessionWith([imageMedia()]))
    act(() => findByTestId(r, 'media-rail-pill')[0].props.onClick())
    act(() => r.update(createElement(MediaRail, {
      session: sessionWith([imageMedia(), imageMedia({ url: 'new' })]),
    })))
    act(() => r.root.findByProps({ 'aria-label': 'Collapse media rail' }).props.onClick())
    expect(findByTestId(r, 'media-rail-new-dot')).toHaveLength(0)
    act(() => r.unmount())
  })

})
