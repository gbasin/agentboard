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
const originalGetComputedStyle = globalAny.getComputedStyle
const originalFetch = globalThis.fetch

let scrollListeners: Listener[] = []
let resizeListeners: Listener[] = []

// Deterministic stand-in for window timers: hover-card open/close delays
// are flushed explicitly instead of waiting on wall-clock time.
let timers: { id: number; fn: () => void }[] = []
let nextTimerId = 1
function flushWindowTimers() {
  const pending = timers
  timers = []
  for (const t of pending) t.fn()
}

const fakeWindow = {
  innerWidth: 1000,
  innerHeight: 800,
  setTimeout: (fn: () => void, _ms?: number) => {
    const id = nextTimerId++
    timers.push({ id, fn })
    return id
  },
  clearTimeout: (id: number) => {
    timers = timers.filter((t) => t.id !== id)
  },
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

function chipEl(root: TestRenderer.ReactTestInstance) {
  return root
    .findAll(
      (el) =>
        typeof el.props.className === 'string' &&
        el.props.className.startsWith('relative inline-flex') &&
        typeof el.props.onMouseEnter === 'function'
    )
    .at(0)!
}

function openCard(root: TestRenderer.ReactTestInstance) {
  const chip = chipEl(root)
  act(() => chip.props.onMouseEnter())
  // Open is delayed for hover intent — elapse the timer.
  act(flushWindowTimers)
}

describe('PrChips hover card', () => {
  beforeEach(() => {
    scrollListeners = []
    resizeListeners = []
    timers = []
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
    globalAny.getComputedStyle = originalGetComputedStyle
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('opens only after the hover delay; leaving early cancels the open', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={[PR]} />, {
        createNodeMock,
      })
    })
    const chip = chipEl(renderer.root)

    // A passing hover doesn't open the card.
    act(() => chip.props.onMouseEnter())
    act(() => chip.props.onMouseLeave())
    act(flushWindowTimers)
    expect(findCard(renderer.root)).toBeUndefined()

    // Resting past the delay opens it.
    act(() => chip.props.onMouseEnter())
    expect(findCard(renderer.root)).toBeUndefined()
    act(flushWindowTimers)
    expect(findCard(renderer.root)).toBeDefined()
    act(() => renderer.unmount())
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

  test('renders skipped checks as neutral, not failed', async () => {
    // Distinct url: check results are cached module-wide per PR.
    const pr2 = { ...PR, url: 'https://github.com/o/r/pull/2', number: 2 }
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/pr-checks')) {
        return new Response(
          JSON.stringify({
            url: pr2.url,
            state: 'OPEN',
            title: 'My PR',
            author: 'me',
            checks: [
              { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SKIPPED' },
            ],
          })
        )
      }
      return new Response(JSON.stringify([]))
    }) as unknown as typeof fetch

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={[pr2]} />, {
        createNodeMock,
      })
    })
    act(() => openCard(renderer.root))
    await act(async () => {})

    const card = findCard(renderer.root)!
    const neutral = card.findAll(
      (el) =>
        el.props.children === '–' &&
        typeof el.props.className === 'string' &&
        el.props.className.includes('text-muted')
    )
    const failed = card.findAll((el) => el.props.children === '✗')
    expect(neutral.length).toBe(1)
    expect(failed.length).toBe(0)
    act(() => renderer.unmount())
  })
})

describe('PrChips single-row fit', () => {
  const PADDING_LEFT = 22
  const CHIP_W = 50
  const PLUS_W = 20 // "+"
  const PLUS_DIGIT_W = 26 // "+0" → digit width = 6

  let containerWidth = 0

  function textOf(el: TestRenderer.ReactTestInstance): string {
    const c = el.props.children
    return Array.isArray(c) ? c.join('') : String(c ?? '')
  }

  // Ref'd nodes: the container div reports clientWidth, the offscreen
  // measurer pills report offsetWidth by text content.
  const fitNodeMock = (el: { type: unknown; props: { children?: unknown } }) => {
    if (el.type === 'div') {
      return {
        get clientWidth() {
          return containerWidth
        },
        getBoundingClientRect: () => chipRect,
        contains: () => false,
      }
    }
    const c = el.props.children
    const flat = Array.isArray(c) ? c.join('') : String(c ?? '')
    if (flat === '+') return { offsetWidth: PLUS_W }
    if (flat === '+0') return { offsetWidth: PLUS_DIGIT_W }
    if (Array.isArray(c) && c.includes('#')) return { offsetWidth: CHIP_W }
    return {
      getBoundingClientRect: () => chipRect,
      contains: () => false,
    }
  }

  const makePrs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://github.com/o/r/pull/${i + 1}`,
      repo: 'o/r',
      number: i + 1,
    }))

  const chipLinks = (root: TestRenderer.ReactTestInstance) =>
    root.findAll((el) => el.type === 'a' && typeof el.props.href === 'string')

  const overflowText = (root: TestRenderer.ReactTestInstance) =>
    root
      .findAll((el) => /^\+[1-9]/.test(textOf(el)))
      .map(textOf)
      .at(-1)

  beforeEach(() => {
    globalAny.window = fakeWindow
    globalAny.document = { body: {} }
    globalAny.getComputedStyle = () => ({
      paddingLeft: `${PADDING_LEFT}px`,
      paddingRight: '0px',
      columnGap: '4px',
    })
  })

  afterAll(() => {
    globalAny.window = originalWindow
    globalAny.document = originalDocument
    globalAny.getComputedStyle = originalGetComputedStyle
  })

  test('shows only the chips that fit and collapses the rest into +N', () => {
    // avail = 222 - 22 = 200; chip=50, gap=4, "+N"=26, gap before "+N"=4.
    // 3 chips cost 154 + 30 reserved = 184; a 4th would need 84 more.
    containerWidth = 222
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={makePrs(5)} />, {
        createNodeMock: fitNodeMock,
      })
    })
    expect(chipLinks(renderer.root).length).toBe(3)
    expect(overflowText(renderer.root)).toBe('+2')
    act(() => renderer.unmount())
  })

  test('shows all chips and no +N when everything fits', () => {
    containerWidth = 1000
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={makePrs(5)} />, {
        createNodeMock: fitNodeMock,
      })
    })
    expect(chipLinks(renderer.root).length).toBe(5)
    expect(overflowText(renderer.root)).toBeUndefined()
    act(() => renderer.unmount())
  })

  test('reflows on resize: narrowing the row folds chips into +N', () => {
    containerWidth = 1000
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={makePrs(5)} />, {
        createNodeMock: fitNodeMock,
      })
    })
    expect(chipLinks(renderer.root).length).toBe(5)

    // avail = 130 - 22 = 108: one chip (50) + gap (4) + "+4" (26) = 80 fits,
    // a second chip would push past the edge.
    containerWidth = 130
    act(() => {
      for (const fn of resizeListeners) fn({})
    })
    expect(chipLinks(renderer.root).length).toBe(1)
    expect(overflowText(renderer.root)).toBe('+4')
    act(() => renderer.unmount())
  })

  test('falls back to showing all chips when measurements are unavailable', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={makePrs(5)} />, {
        createNodeMock,
      })
    })
    expect(chipLinks(renderer.root).length).toBe(5)
    act(() => renderer.unmount())
  })
})

describe('PrChips info fetch resilience', () => {
  // Unique url space — module caches persist across tests in this file.
  const prFor = (n: number) => ({
    url: `https://github.com/o/r/pull/${100 + n}`,
    repo: 'o/r',
    number: 100 + n,
  })

  const infoResponse = (url: string, state: string) =>
    new Response(
      JSON.stringify([{ url, state, isDraft: false, title: 't', author: 'a' }])
    )

  let visListeners: (() => void)[] = []
  let fetchImpl: () => Promise<Response>
  let fetchMock: ReturnType<typeof mock>

  // State-color classes appear only on the visible chip's dot; the
  // offscreen measurer dots have no bg-* class.
  const dotClasses = (root: TestRenderer.ReactTestInstance) =>
    root
      .findAll(
        (el) =>
          typeof el.props.className === 'string' &&
          /bg-(muted|green-500|purple-500|red-500)/.test(el.props.className)
      )
      .map((el) => el.props.className as string)

  const hasDot = (root: TestRenderer.ReactTestInstance, cls: string) =>
    dotClasses(root).some((c) => c.includes(cls))

  beforeEach(() => {
    visListeners = []
    globalAny.window = fakeWindow
    globalAny.document = {
      body: {},
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'visibilitychange') visListeners.push(fn)
      },
      removeEventListener: (type: string, fn: () => void) => {
        if (type !== 'visibilitychange') return
        const i = visListeners.indexOf(fn)
        if (i >= 0) visListeners.splice(i, 1)
      },
    }
    fetchImpl = async () => new Response(JSON.stringify([]))
    fetchMock = mock((_input: RequestInfo | URL) => fetchImpl())
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterAll(() => {
    globalAny.window = originalWindow
    globalAny.document = originalDocument
    globalThis.fetch = originalFetch
  })

  test('error results are not cached — remount retries and colors the dot', async () => {
    const pr = prFor(1)
    fetchImpl = async () =>
      new Response(JSON.stringify([{ url: pr.url, error: 'unavailable' }]))
    let r1!: TestRenderer.ReactTestRenderer
    act(() => {
      r1 = TestRenderer.create(<PrChips prs={[pr]} />, { createNodeMock })
    })
    await act(async () => {})
    expect(hasDot(r1.root, 'bg-muted')).toBe(true)
    const calls = fetchMock.mock.calls.length
    act(() => r1.unmount())

    fetchImpl = async () => infoResponse(pr.url, 'OPEN')
    let r2!: TestRenderer.ReactTestRenderer
    act(() => {
      r2 = TestRenderer.create(<PrChips prs={[pr]} />, { createNodeMock })
    })
    await act(async () => {})
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls)
    expect(hasDot(r2.root, 'bg-green-500')).toBe(true)
    act(() => r2.unmount())
  })

  test('chip mounting while a fetch is in flight still gets the result', async () => {
    const pr = prFor(2)
    let resolveFetch!: (r: Response) => void
    fetchImpl = () =>
      new Promise<Response>((res) => {
        resolveFetch = res
      })
    let r1!: TestRenderer.ReactTestRenderer
    act(() => {
      r1 = TestRenderer.create(<PrChips prs={[pr]} />, { createNodeMock })
    })
    // First chip unmounts with the request still in flight; a fresh chip
    // must subscribe to the shared promise rather than stay gray forever.
    act(() => r1.unmount())
    let r2!: TestRenderer.ReactTestRenderer
    act(() => {
      r2 = TestRenderer.create(<PrChips prs={[pr]} />, { createNodeMock })
    })
    resolveFetch(infoResponse(pr.url, 'OPEN'))
    await act(async () => {})
    expect(fetchMock.mock.calls.length).toBe(1)
    expect(hasDot(r2.root, 'bg-green-500')).toBe(true)
    act(() => r2.unmount())
  })

  test('becoming visible refetches stale info', async () => {
    const pr = prFor(3)
    fetchImpl = async () => infoResponse(pr.url, 'OPEN')
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PrChips prs={[pr]} />, {
        createNodeMock,
      })
    })
    await act(async () => {})
    expect(hasDot(renderer.root, 'bg-green-500')).toBe(true)

    // Age the cache past the 60s TTL, swap the response, then simulate
    // the PWA resuming from suspension.
    const realNow = Date.now
    Date.now = () => realNow() + 61_000
    fetchImpl = async () => infoResponse(pr.url, 'MERGED')
    const calls = fetchMock.mock.calls.length
    act(() => {
      for (const fn of visListeners) fn()
    })
    await act(async () => {})
    Date.now = realNow
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls)
    expect(hasDot(renderer.root, 'bg-purple-500')).toBe(true)
    act(() => renderer.unmount())
  })
})
