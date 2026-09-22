import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'

// Render portal children inline so the card is part of the test tree.
mock.module('react-dom', () => ({
  createPortal: (children: unknown) => children,
}))

const { PrChips } = await import('../components/PrChips')

const PR = {
  url: 'https://github.com/o/r/pull/1',
  repo: 'o/r',
  number: 1,
}

type Listener = (e: { target?: unknown }) => void

const globalAny = globalThis as unknown as Record<string, unknown>
const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalFetch = globalThis.fetch

let scrollListeners: Listener[] = []
let resizeListeners: Listener[] = []

const fakeWindow = {
  innerWidth: 1000,
  innerHeight: 800,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  addEventListener: (type: string, fn: Listener) => {
    if (type === 'scroll') scrollListeners.push(fn)
    else if (type === 'resize') resizeListeners.push(fn)
  },
  removeEventListener: (type: string, fn: Listener) => {
    const arr = type === 'scroll' ? scrollListeners : resizeListeners
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  },
}

let chipRect = { top: 700, bottom: 720, left: 100, right: 140 }

// Anchor spans read getBoundingClientRect; card divs read contains().
const createNodeMock = () => ({
  getBoundingClientRect: () => chipRect,
  contains: (target: unknown) =>
    !!(target && (target as { __inCard?: boolean }).__inCard),
})

function findCard(root: TestRenderer.ReactTestInstance) {
  return root
    .findAll(
      (el) =>
        typeof el.props.className === 'string' &&
        el.props.className.includes('fixed')
    )
    .at(-1)
}

function openCard(root: TestRenderer.ReactTestInstance) {
  const chip = root.findByProps({ className: 'relative inline-flex' })
  act(() => chip.props.onMouseEnter())
}

describe('PrChips hover card', () => {
  beforeEach(() => {
    scrollListeners = []
    resizeListeners = []
    chipRect = { top: 700, bottom: 720, left: 100, right: 140 }
    globalAny.window = fakeWindow
    globalAny.document = { body: {} }
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/pr-checks')) {
        return new Response(
          JSON.stringify({
            url: PR.url,
            state: 'OPEN',
            title: 'My PR',
            author: 'me',
            checks: [
              {
                name: 'ci',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                link: 'https://github.com/o/r/actions/runs/1',
              },
            ],
          })
        )
      }
      return new Response(JSON.stringify([]))
    }) as unknown as typeof fetch
  })

  afterAll(() => {
    globalAny.window = originalWindow
    globalAny.document = originalDocument
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('anchors above the chip when there is more room above', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={[PR]} />, {
        createNodeMock,
      })
    })
    act(() => openCard(renderer.root))
    const card = findCard(renderer.root)!
    expect(card.props.style.bottom).toBe(800 - 700 + 3)
    expect(card.props.style.top).toBeUndefined()
    expect(card.props.style.left).toBe(100)
    expect(card.props.style.maxHeight).toBe(692 - 3)
    act(() => renderer.unmount())
  })

  test('flips below the chip near the top edge and clamps left', () => {
    chipRect = { top: 40, bottom: 60, left: 950, right: 990 }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={[PR]} />, {
        createNodeMock,
      })
    })
    act(() => openCard(renderer.root))
    const card = findCard(renderer.root)!
    expect(card.props.style.top).toBe(60 + 3)
    expect(card.props.style.bottom).toBeUndefined()
    // w-64 card: clamped to innerWidth - 256 - 8, never negative.
    expect(card.props.style.left).toBe(1000 - 256 - 8)
    expect(card.props.style.maxHeight).toBe(732 - 3)
    act(() => renderer.unmount())
  })

  test('scroll inside the card keeps it open; outside scroll closes it', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={[PR]} />, {
        createNodeMock,
      })
    })
    act(() => openCard(renderer.root))
    expect(scrollListeners.length).toBeGreaterThan(0)

    act(() => {
      for (const fn of scrollListeners) fn({ target: { __inCard: true } })
    })
    expect(findCard(renderer.root)).toBeDefined()

    act(() => {
      for (const fn of scrollListeners) fn({ target: {} })
    })
    expect(findCard(renderer.root)).toBeUndefined()
    act(() => renderer.unmount())
  })

  test('header, title, and check rows link out', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={[PR]} />, {
        createNodeMock,
      })
    })
    act(() => openCard(renderer.root))
    // Let the lazy /api/pr-checks fetch resolve.
    await act(async () => {})

    const card = findCard(renderer.root)!
    const links = card
      .findAll((el) => el.type === 'a')
      .map((el) => el.props.href)
    // repo#number + title + one linked check row.
    expect(links.filter((h) => h === PR.url).length).toBe(2)
    expect(links).toContain('https://github.com/o/r/actions/runs/1')
    act(() => renderer.unmount())
  })
})
