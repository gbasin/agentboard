import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { useRef, type ReactNode } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { SortableContext } from '@dnd-kit/sortable'
import type { AgentSession, Session } from '@shared/types'
import SessionList from '../components/SessionList'
import SessionDrawer from '../components/SessionDrawer'
import SessionFilterButton from '../components/SessionFilterButton'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useMenuViewportFit, type MenuPoint } from '../hooks/useMenuViewportFit'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  getComputedStyle?: typeof getComputedStyle
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalGetComputedStyle = globalAny.getComputedStyle
const originalSetTimeout = globalThis.setTimeout

let scrollPaddingTop = '0px'
let scrollPaddingBottom = '0px'

// Stubs live in beforeAll/afterAll (see sessionListComponent.test.tsx):
// framer-motion frame callbacks can fire between tests and need a window.
beforeAll(() => {
  globalAny.window = {
    innerWidth: 1024,
    innerHeight: 768,
    scrollY: 0,
    scrollTo: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  } as unknown as Window & typeof globalThis
  globalAny.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { style: {} },
  } as unknown as Document
  globalAny.getComputedStyle = (() => ({
    scrollPaddingTop,
    scrollPaddingBottom,
    scrollPaddingLeft: '0px',
    scrollPaddingRight: '0px',
  })) as unknown as typeof getComputedStyle
})

afterAll(async () => {
  await new Promise((resolve) => originalSetTimeout(resolve, 64))
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.getComputedStyle = originalGetComputedStyle
})

beforeEach(() => {
  scrollPaddingTop = '0px'
  scrollPaddingBottom = '0px'
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    manualSessionOrder: [],
    sidebarAnchor: 'top',
    historySessionsExpanded: true,
    hibernatingSessionsExpanded: true,
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
    hostFilters: [],
  })
  useSessionStore.setState({ exitingSessions: new Map(), hostStatuses: [] })
})

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'waiting',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

// created desc: s3 (newest) is "first", then s2, then s1.
const sessions: Session[] = [1, 2, 3].map((n) => ({
  ...baseSession,
  id: `s${n}`,
  name: `s${n}`,
  tmuxWindow: `agentboard:${n}`,
  createdAt: `2024-01-0${n}T00:00:00.000Z`,
}))

function agentSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: id,
    logFilePath: `/tmp/${id}.jsonl`,
    projectPath: '/tmp/alpha',
    agentType: 'claude',
    displayName: id,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActivityAt: '2024-01-01T00:00:00.000Z',
    isActive: false,
    ...overrides,
  }
}

const hibernating = [
  agentSession('hib-a', { isHibernating: true }),
  agentSession('hib-b', { isHibernating: true }),
]
const history = Array.from({ length: 22 }, (_, i) => agentSession(`hist-${i}`))

type Json = TestRenderer.ReactTestRendererJSON | string | null

/** Flatten the rendered tree into landmark tokens, in document order. */
function outline(node: Json | Json[], out: string[] = []): string[] {
  if (node === null) return out
  if (Array.isArray(node)) {
    for (const child of node) outline(child, out)
    return out
  }
  if (typeof node === 'string') {
    if (['Active', 'Hibernating', 'History'].includes(node)) out.push(`label:${node}`)
    else if (node === 'Show more (') out.push('show-more')
    else if (/^hist-\d+$/.test(node)) out.push(node)
    else if (node === '[ ] nav') out.push('hint')
    return out
  }
  const { props } = node
  const className = typeof props.className === 'string' ? props.className : ''
  if (props['data-testid'] === 'session-card') out.push(`row:${props['data-session-id']}`)
  if (props['data-testid'] === 'hibernating-session-card') out.push(`hib:${props['data-session-id']}`)
  if (props['data-testid'] === 'controls') out.push('controls')
  if (props['data-testid'] === 'notice') out.push('notice')
  if (className.includes('sticky')) out.push('filter')
  if (props['data-testid'] === 'session-card' || props['data-testid'] === 'hibernating-session-card') {
    return out // row internals are not landmarks
  }
  if (node.children) outline(node.children as Json[], out)
  return out
}

type NodeMock = NonNullable<TestRenderer.TestRendererOptions['createNodeMock']>

function renderList(props: Partial<Parameters<typeof SessionList>[0]> = {}, nodeMock?: NodeMock) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <SessionList
        sessions={sessions}
        hibernatingSessions={hibernating}
        historySessions={history}
        selectedSessionId={null}
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
        filterBarControls={<div data-testid="controls" />}
        {...props}
      />,
      nodeMock ? { createNodeMock: nodeMock } : undefined
    )
  })
  return renderer
}

const topHistory = Array.from({ length: 20 }, (_, i) => `hist-${i}`)

describe('SessionList anchor: rendered order', () => {
  test('top anchor keeps the existing order', () => {
    const renderer = renderList()
    expect(outline(renderer.toJSON())).toEqual([
      'filter',
      'controls',
      'label:Active',
      'row:s3',
      'row:s2',
      'row:s1',
      'label:Hibernating',
      'hib:hib-a',
      'hib:hib-b',
      'label:History',
      ...topHistory,
      'show-more',
      'hint',
    ])
    act(() => renderer.unmount())
  })

  test('bottom anchor mirrors sections and rows; labels stay above rows', () => {
    const renderer = renderList({ anchor: 'bottom' })
    expect(outline(renderer.toJSON())).toEqual([
      'label:History',
      'show-more',
      ...[...topHistory].reverse(),
      'label:Hibernating',
      'hib:hib-b',
      'hib:hib-a',
      'label:Active',
      'row:s1',
      'row:s2',
      'row:s3',
      'filter',
      'controls',
      'hint',
    ])
    act(() => renderer.unmount())
  })

  test('notice sits under the filter bar for top, never above it', () => {
    const renderer = renderList({ notice: <div data-testid="notice" /> })
    expect(outline(renderer.toJSON()).slice(0, 4)).toEqual([
      'filter',
      'controls',
      'notice',
      'label:Active',
    ])
    act(() => renderer.unmount())
  })

  test('notice is pinned at the column top for bottom, clear of the rows and bars', () => {
    const renderer = renderList({ anchor: 'bottom', notice: <div data-testid="notice" /> })
    const tokens = outline(renderer.toJSON())
    expect(tokens[0]).toBe('notice')
    // The first row still sits directly on the filter bar, which sits on the hint.
    expect(tokens.slice(-5)).toEqual(['row:s2', 'row:s3', 'filter', 'controls', 'hint'])
    act(() => renderer.unmount())
  })

  test('bottom anchor flips section dividers and the filter menu placement', () => {
    useSessionStore.setState({
      hostStatuses: [
        { host: 'a', ok: true, lastUpdated: '2024-01-01T00:00:00.000Z' },
        { host: 'b', ok: true, lastUpdated: '2024-01-01T00:00:00.000Z' },
      ],
    })
    const renderer = renderList({ anchor: 'bottom' })
    expect(renderer.root.findByType(SessionFilterButton).props.placement).toBe('up')
    expect(renderer.root.findByType(SessionFilterButton).props.showHosts).toBe(true)
    const sticky = renderer.root.find(
      (n) => typeof n.props.className === 'string' && n.props.className.includes('sticky')
    )
    expect(sticky.props.className).toContain('bottom-0')
    expect(sticky.props.className).toContain('border-t')
    act(() => renderer.unmount())

    const top = renderList()
    expect(top.root.findByType(SessionFilterButton).props.placement).toBe('down')
    act(() => top.unmount())
  })

  test('sortable items follow on-screen order', () => {
    const bottom = renderList({ anchor: 'bottom' })
    expect(bottom.root.findByType(SortableContext).props.items).toEqual(['s1', 's2', 's3'])
    act(() => bottom.unmount())
    const top = renderList()
    expect(top.root.findByType(SortableContext).props.items).toEqual(['s3', 's2', 's1'])
    act(() => top.unmount())
  })
})

describe('SessionList anchor: dormant sections', () => {
  test('bottom: show more pages older history in above the rows', () => {
    const renderer = renderList({ anchor: 'bottom' })
    const showMore = () =>
      renderer.root.find(
        (n) => n.type === 'button' && Array.isArray(n.props.children) && n.props.children[0] === 'Show more ('
      )
    act(() => showMore().props.onClick())
    const tokens = outline(renderer.toJSON())
    const historyRows = tokens.filter((t) => t.startsWith('hist-'))
    expect(historyRows).toHaveLength(22)
    expect(historyRows[0]).toBe('hist-21') // oldest at the top
    expect(historyRows[21]).toBe('hist-0')
    expect(tokens).not.toContain('show-more')
    act(() => renderer.unmount())
  })

  test('section toggles collapse and expand under bottom', () => {
    const renderer = renderList({ anchor: 'bottom' })
    const toggle = (label: string) =>
      renderer.root.find(
        (n) =>
          n.type === 'button' &&
          n.findAll((c) => c.type === 'span' && Array.isArray(c.props.children) && c.props.children.includes(label)).length > 0
      )
    act(() => toggle('History').props.onClick())
    act(() => toggle('Hibernating').props.onClick())
    expect(useSettingsStore.getState().historySessionsExpanded).toBe(false)
    expect(useSettingsStore.getState().hibernatingSessionsExpanded).toBe(false)
    const tokens = outline(renderer.toJSON())
    expect(tokens.some((t) => t.startsWith('hist-') || t.startsWith('hib:'))).toBe(false)
    expect(tokens.slice(0, 3)).toEqual(['label:History', 'label:Hibernating', 'label:Active'])
    act(() => renderer.unmount())
  })

  test('hibernating row callbacks reach the list props', () => {
    const selected: string[] = []
    const renderer = renderList({
      anchor: 'bottom',
      onSelectHibernating: (id) => selected.push(id),
    })
    const card = renderer.root.find((n) => n.props['data-testid'] === 'hibernating-session-card' && n.props['data-session-id'] === 'hib-a')
    act(() => card.props.onClick())
    expect(selected).toEqual(['hib-a'])
    act(() => renderer.unmount())
  })
})

describe('SessionList anchor: mobile drawer', () => {
  test('drawer stays top-anchored when the setting is bottom', () => {
    useSettingsStore.setState({ sidebarAnchor: 'bottom' })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionDrawer
          isOpen
          onClose={() => {}}
          sessions={sessions}
          selectedSessionId={null}
          onSelect={() => {}}
          onRename={() => {}}
          onNewSession={() => {}}
          loading={false}
          error={null}
        />
      )
    })
    const tokens = outline(renderer.toJSON())
    expect(tokens.slice(0, 5)).toEqual(['filter', 'label:Active', 'row:s3', 'row:s2', 'row:s1'])
    expect(renderer.root.findByType(SessionList).props.anchor).toBeUndefined()
    act(() => renderer.unmount())
  })
})

describe('SessionList anchor: drag to reorder', () => {
  function drag(renderer: TestRenderer.ReactTestRenderer, activeId: string, overId: string) {
    // DndContext is a memo component, which findByType does not match;
    // find it by its drag callbacks instead.
    const dnd = () =>
      renderer.root.find(
        (n) => typeof n.props.onDragEnd === 'function' && typeof n.props.onDragStart === 'function'
      )
    act(() => {
      dnd().props.onDragStart({ active: { id: activeId } })
    })
    act(() => {
      dnd().props.onDragOver({ active: { id: activeId }, over: { id: overId } })
    })
    const indicators = renderer.root.findAll(
      (n) =>
        n.type === 'div' &&
        typeof n.props.className === 'string' &&
        n.props.className.includes('border-dashed')
    )
    const indicatorClass = indicators.map((n) => n.props.className as string)
    act(() => {
      dnd().props.onDragEnd({ active: { id: activeId }, over: { id: overId } })
    })
    return indicatorClass
  }

  test('bottom: dragging the lowest row up onto the top row gives the visible order', () => {
    const renderer = renderList({ anchor: 'bottom' })
    // On screen (top to bottom): s1, s2, s3. Drag s3 up onto s1.
    const indicators = drag(renderer, 's3', 's1')
    // Moving up: the line shows above the target.
    expect(indicators).toHaveLength(1)
    expect(indicators[0]).toContain('-top-px')

    const state = useSettingsStore.getState()
    expect(state.sessionSortMode).toBe('manual')
    // On screen now: s3, s1, s2 -> stored first-to-last is the reverse.
    expect(state.manualSessionOrder).toEqual(['s2', 's1', 's3'])
    act(() => renderer.update(
      <SessionList
        sessions={sessions}
        selectedSessionId={null}
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
        anchor="bottom"
      />
    ))
    expect(outline(renderer.toJSON()).filter((t) => t.startsWith('row:'))).toEqual([
      'row:s3',
      'row:s1',
      'row:s2',
    ])
    act(() => renderer.unmount())
  })

  test('bottom: dragging down shows the indicator below the target', () => {
    const renderer = renderList({ anchor: 'bottom' })
    const indicators = drag(renderer, 's1', 's2')
    expect(indicators).toHaveLength(1)
    expect(indicators[0]).toContain('-bottom-px')
    // On screen now: s2, s1, s3.
    expect(useSettingsStore.getState().manualSessionOrder).toEqual(['s3', 's1', 's2'])
    act(() => renderer.unmount())
  })
})

interface FakeEl {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  clientWidth: number
  scrollWidth: number
  scrollLeft: number
  rows: Map<string, number>
  listeners: Map<string, () => void>
  addEventListener(type: string, fn: () => void): void
  removeEventListener(type: string): void
  getBoundingClientRect(): { top: number; left: number; height: number; width: number }
  querySelector(selector: string): unknown
  scrollTo(opts: { top?: number }): void
}

/** Scroll container whose scrollTop clamps like a browser's. */
function fakeScroller(scrollHeight: number, clientHeight: number): FakeEl {
  let top = 0
  const el: FakeEl = {
    get scrollTop() {
      return top
    },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight))
    },
    scrollHeight,
    clientHeight,
    clientWidth: 200,
    scrollWidth: 200,
    scrollLeft: 0,
    rows: new Map(),
    listeners: new Map(),
    addEventListener(type, fn) {
      el.listeners.set(type, fn)
    },
    removeEventListener(type) {
      el.listeners.delete(type)
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, height: el.clientHeight, width: 200 }
    },
    querySelector(selector: string) {
      const match = selector.match(/data-session-id="([^"]*)"/)
      const contentTop = match ? el.rows.get(match[1]) : undefined
      if (contentTop === undefined) return null
      return {
        getBoundingClientRect: () => ({ top: contentTop - el.scrollTop, left: 0, height: 50, width: 200 }),
      }
    },
    scrollTo(opts) {
      if (typeof opts.top === 'number') el.scrollTop = opts.top
    },
  }
  return el
}

function scrollerMock(el: FakeEl): NodeMock {
  return (element) =>
    element.type === 'div' &&
    typeof element.props.className === 'string' &&
    element.props.className.includes('overflow-y-auto')
      ? el
      : null
}

describe('SessionList anchor: bottom pinning', () => {
  test('opens scrolled to the bottom', () => {
    const el = fakeScroller(1000, 100)
    const renderer = renderList({ anchor: 'bottom' }, scrollerMock(el))
    expect(el.scrollTop).toBe(900)
    act(() => renderer.unmount())
  })

  test('top anchor does not touch the scroll position', () => {
    const el = fakeScroller(1000, 100)
    const renderer = renderList({}, scrollerMock(el))
    expect(el.scrollTop).toBe(0)
    expect(el.listeners.size).toBe(0)
    act(() => renderer.unmount())
  })

  test('stays pinned when content grows while at the bottom', () => {
    const el = fakeScroller(1000, 100)
    const renderer = renderList({ anchor: 'bottom' }, scrollerMock(el))
    el.scrollHeight = 1050 // a row was added
    act(() => {
      renderer.update(
        <SessionList
          sessions={[...sessions, { ...baseSession, id: 's4', createdAt: '2024-01-04T00:00:00.000Z' }]}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
          anchor="bottom"
        />
      )
    })
    expect(el.scrollTop).toBe(950)
    act(() => renderer.unmount())
  })

  test('stays pinned when the viewport shrinks (a banner appears above the list)', () => {
    const el = fakeScroller(1000, 100)
    const renderer = renderList({ anchor: 'bottom' }, scrollerMock(el))
    expect(el.scrollTop).toBe(900)
    el.clientHeight = 60 // same content, shorter viewport
    act(() => {
      renderer.update(
        <SessionList
          sessions={sessions}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
          anchor="bottom"
        />
      )
    })
    expect(el.scrollTop).toBe(940)
    act(() => renderer.unmount())
  })

  test('leaves the position alone once the user scrolls up', () => {
    const el = fakeScroller(1000, 100)
    const renderer = renderList({ anchor: 'bottom' }, scrollerMock(el))
    el.scrollTop = 200
    el.listeners.get('scroll')?.()
    el.scrollHeight = 1050
    act(() => {
      renderer.update(
        <SessionList
          sessions={sessions.slice(0, 2)}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
          anchor="bottom"
        />
      )
    })
    expect(el.scrollTop).toBe(200)

    // Scrolling back to the bottom re-arms the pin.
    el.scrollTop = 950
    el.listeners.get('scroll')?.()
    el.scrollHeight = 1100
    act(() => {
      renderer.update(
        <SessionList
          sessions={sessions}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
          anchor="bottom"
        />
      )
    })
    expect(el.scrollTop).toBe(1000)
    act(() => renderer.unmount())
  })

  test('selection scroll clears the sticky bottom filter bar', () => {
    scrollPaddingBottom = '40px'
    const el = fakeScroller(1100, 100)
    // Row s3 at 930..980. Scrolled to 880 the viewport is 880..980, but the
    // 40px sticky bar covers 940..980, hiding the row's lower part.
    el.rows.set('s3', 930)
    const renderer = renderList({ anchor: 'bottom' }, scrollerMock(el))
    el.scrollTop = 880
    el.listeners.get('scroll')?.()
    act(() => {
      renderer.update(
        <SessionList
          sessions={sessions}
          selectedSessionId="s3"
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
          anchor="bottom"
        />
      )
    })
    // rowBottom (980) - clientHeight (100) + padBottom (40) = 920
    expect(el.scrollTop).toBe(920)
    act(() => renderer.unmount())
  })

  test('a selection scroll in the same commit as a height change wins', () => {
    const el = fakeScroller(1000, 100)
    el.rows.set('s1', 100)
    const renderer = renderList({ anchor: 'bottom' }, scrollerMock(el))
    el.scrollHeight = 1050
    act(() => {
      renderer.update(
        <SessionList
          sessions={sessions}
          selectedSessionId="s1"
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
          anchor="bottom"
        />
      )
    })
    expect(el.scrollTop).toBe(100)
    act(() => renderer.unmount())
  })
})

describe('filter bar controls', () => {
  const barChildren = (renderer: TestRenderer.ReactTestRenderer) => {
    const bar = renderer.root.find((n) =>
      n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('sticky')
    )
    return bar.children.map((child) =>
      typeof child === 'string' ? child : child.props['data-testid'] ?? child.props.className
    )
  }

  test.each(['top', 'bottom'] as const)('%s anchor: filter button on the left, controls at the right end', (anchor) => {
    const renderer = renderList({ anchor })
    const children = barChildren(renderer)
    expect(children).toHaveLength(2)
    expect(children[0]).toContain('min-w-0 flex-1')
    expect(children[1]).toBe('controls')
    act(() => renderer.unmount())
  })

  test('without controls (mobile drawer) the bar holds only the filter button', () => {
    const renderer = renderList({ filterBarControls: undefined })
    const children = barChildren(renderer)
    expect(children).toHaveLength(1)
    expect(children[0]).toContain('min-w-0 flex-1')
    act(() => renderer.unmount())
  })
})

describe('filter menu placement', () => {
  test('up opens the menu above the bar, down below it', () => {
    const menuClass = (placement?: 'down' | 'up') => {
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <SessionFilterButton
            projects={['/a']}
            selectedProjects={[]}
            onSelectProjects={() => {}}
            hosts={['h']}
            selectedHosts={[]}
            onSelectHosts={() => {}}
            showHosts
            hasHiddenPermissions={false}
            placement={placement}
          />
        )
      })
      const button = renderer.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu')
      act(() => button.props.onClick())
      const classes = renderer.root
        .findAll((n) => n.type === 'div' && n.props.role === 'menu')
        .map((n) => n.props.className as string)
      act(() => renderer.unmount())
      return classes
    }
    const down = menuClass()
    expect(down).toHaveLength(1)
    expect(down[0]).toContain('top-full mt-1')
    expect(down[0]).not.toContain('bottom-full')
    const up = menuClass('up')
    expect(up).toHaveLength(1)
    expect(up[0]).toContain('bottom-full')
    expect(up[0]).not.toContain('mt-1')
  })
})

describe('useMenuViewportFit', () => {
  function Probe({ point, onPosition }: { point: MenuPoint | null; onPosition: (p: unknown) => void }): ReactNode {
    const ref = useRef<HTMLDivElement>(null)
    const position = useMenuViewportFit(ref, point)
    onPosition(position)
    return point ? <div ref={ref} data-menu /> : null
  }

  function fit(point: MenuPoint | null, size = { width: 160, height: 200 }) {
    let last: unknown
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<Probe point={point} onPosition={(p) => { last = p }} />, {
        createNodeMock: () => ({ getBoundingClientRect: () => ({ ...size, top: 0, left: 0 }) }),
      })
    })
    act(() => renderer.unmount())
    return last
  }

  test('keeps the pointer position when the menu fits', () => {
    expect(fit({ x: 100, y: 100 })).toEqual({ left: 100, top: 100 })
  })

  test('flips up and left when the menu would overflow the viewport', () => {
    // viewport 1024x768
    expect(fit({ x: 1000, y: 700 })).toEqual({ left: 840, top: 500 })
  })

  test('never goes above or left of the viewport edge', () => {
    expect(fit({ x: 50, y: 700 }, { width: 2000, height: 900 })).toEqual({ left: 0, top: 0 })
  })

  test('returns null when closed', () => {
    expect(fit(null)).toBeNull()
  })
})
