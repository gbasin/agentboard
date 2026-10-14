import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
    expect(text).toBe('2+1')
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
})
