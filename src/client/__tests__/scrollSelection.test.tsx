import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession, Session } from '@shared/types'
import SessionList from '../components/SessionList'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  getComputedStyle?: typeof getComputedStyle
}

const originalWindow = globalAny.window
const originalGetComputedStyle = globalAny.getComputedStyle

let scrollPaddingTop = '0px'

interface FakeRow {
  /** Row's offset within the scrollable content (unaffected by scrollTop) */
  contentTop: number
  height: number
  container: FakeContainer
  getBoundingClientRect(): { top: number; left: number; height: number; width: number }
}

interface FakeContainer {
  scrollTop: number
  scrollLeft: number
  clientHeight: number
  clientWidth: number
  scrollHeight: number
  scrollWidth: number
  rows: Map<string, FakeRow>
  getBoundingClientRect(): { top: number; left: number; height: number; width: number }
  querySelector(selector: string): FakeRow | null
  scrollTo(opts: { top?: number; left?: number; behavior?: string }): void
}

function fakeContainer(
  rows: Map<string, FakeRow>,
  { clientHeight = 100, scrollHeight = 1000 }: { clientHeight?: number; scrollHeight?: number } = {}
): FakeContainer {
  const container: FakeContainer = {
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight,
    clientWidth: 200,
    scrollHeight,
    scrollWidth: 200, // never horizontally scrollable in these tests
    rows,
    getBoundingClientRect() {
      return { top: 0, left: 0, height: container.clientHeight, width: container.clientWidth }
    },
    querySelector(selector: string) {
      const match = selector.match(/data-session-id="([^"]*)"/)
      const row = (match && rows.get(match[1])) || null
      if (row) row.container = container
      return row
    },
    scrollTo(opts: { top?: number; left?: number; behavior?: string }) {
      if (typeof opts.top === 'number') container.scrollTop = opts.top
      if (typeof opts.left === 'number') container.scrollLeft = opts.left
    },
  }
  for (const row of rows.values()) row.container = container
  return container
}

function fakeRow(contentTop: number, height = 50): FakeRow {
  const row: FakeRow = {
    contentTop,
    height,
    container: undefined as unknown as FakeContainer,
    getBoundingClientRect() {
      // Viewport coords move opposite to scrollTop
      return {
        top: row.contentTop - row.container.scrollTop,
        left: 0,
        height: row.height,
        width: 200,
      }
    },
  }
  return row
}

// react-test-renderer calls createNodeMock for every host element with a ref;
// only the scroll container (overflow-y-auto) gets our fake, everything else
// gets null (the default behavior).
function createNodeMockFor(container: FakeContainer) {
  return (element: { type: unknown; props: { className?: string } }) =>
    element.type === 'div' &&
    typeof element.props.className === 'string' &&
    element.props.className.includes('overflow-y-auto')
      ? container
      : null
}

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

const baseHibernating: AgentSession = {
  sessionId: 'hib-1',
  logFilePath: '/tmp/hib-1.jsonl',
  projectPath: '/tmp/hib',
  agentType: 'claude',
  displayName: 'hib one',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-01T00:00:00.000Z',
  isActive: false,
  isHibernating: true,
}

function renderList(
  container: FakeContainer,
  props: Partial<Parameters<typeof SessionList>[0]> = {}
) {
  return TestRenderer.create(
    <SessionList
      sessions={[baseSession, { ...baseSession, id: 'session-2' }]}
      selectedSessionId={null}
      loading={false}
      error={null}
      onSelect={() => {}}
      onRename={() => {}}
      {...props}
    />,
    { createNodeMock: createNodeMockFor(container) }
  )
}

beforeEach(() => {
  scrollPaddingTop = '0px'
  globalAny.window = {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  } as unknown as Window & typeof globalThis

  globalAny.getComputedStyle = (() => ({
    scrollPaddingTop,
    scrollPaddingBottom: '0px',
    scrollPaddingLeft: '0px',
    scrollPaddingRight: '0px',
  })) as unknown as typeof getComputedStyle

  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    manualSessionOrder: [],
    historySessionsExpanded: false,
    hibernatingSessionsExpanded: false,
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
    hostFilters: [],
  })

  useSessionStore.setState({
    exitingSessions: new Map(),
  })
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.getComputedStyle = originalGetComputedStyle
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    manualSessionOrder: [],
    historySessionsExpanded: false,
    hibernatingSessionsExpanded: false,
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
    hostFilters: [],
  })
  useSessionStore.setState({
    exitingSessions: new Map(),
  })
})

describe('SessionList scroll-to-selection', () => {
  test('scrolls the selected row into view on mount', () => {
    const rows = new Map<string, FakeRow>()
    rows.set('session-1', fakeRow(300)) // below the 100px viewport
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, { selectedSessionId: 'session-1' })
    })
    act(() => renderer.unmount())

    // nearest: rowBottom (350) - clientHeight (100) = 250
    expect(container.scrollTop).toBe(250)
  })

  test('does not scroll when the selected row is already visible', () => {
    const rows = new Map<string, FakeRow>()
    rows.set('session-1', fakeRow(50)) // fully inside 0..100
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, { selectedSessionId: 'session-1' })
    })
    act(() => renderer.unmount())

    expect(container.scrollTop).toBe(0)
  })

  test('scrolls up to a row above the viewport edge', () => {
    const rows = new Map<string, FakeRow>()
    rows.set('session-1', fakeRow(100))
    const container = fakeContainer(rows)
    container.scrollTop = 300 // row contentTop 100 is above viewTop 300

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, { selectedSessionId: 'session-1' })
    })
    act(() => renderer.unmount())

    expect(container.scrollTop).toBe(100)
  })

  test('honors scroll-padding-top (sticky filter bar)', () => {
    scrollPaddingTop = '40px'
    const rows = new Map<string, FakeRow>()
    // Row at 100..150: with 40px padding, effective viewport is 40..100 —
    // rowBottom 150 > viewBottom 100, so it scrolls.
    rows.set('session-1', fakeRow(100))
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, { selectedSessionId: 'session-1' })
    })
    act(() => renderer.unmount())

    // rowBottom (150) - clientHeight (100) + padBottom (0) = 50
    expect(container.scrollTop).toBe(50)
  })

  test('scrolls the newly selected row when selection changes', () => {
    const rows = new Map<string, FakeRow>()
    rows.set('session-1', fakeRow(0))
    rows.set('session-2', fakeRow(300))
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionList
          sessions={[baseSession, { ...baseSession, id: 'session-2' }]}
          selectedSessionId="session-1"
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />,
        { createNodeMock: createNodeMockFor(container) }
      )
    })

    expect(container.scrollTop).toBe(0)

    act(() => {
      renderer.update(
        <SessionList
          sessions={[baseSession, { ...baseSession, id: 'session-2' }]}
          selectedSessionId="session-2"
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      )
    })
    act(() => renderer.unmount())

    expect(container.scrollTop).toBe(250)
  })

  test('retries until the selected row mounts (restored selection)', () => {
    const rows = new Map<string, FakeRow>()
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, { selectedSessionId: 'session-2' })
    })

    // Row not mounted yet — nothing scrolled
    expect(container.scrollTop).toBe(0)
    rows.set('session-2', fakeRow(300))

    // Simulate a later render where the row exists
    act(() => {
      renderer.update(
        <SessionList
          sessions={[baseSession, { ...baseSession, id: 'session-2' }]}
          selectedSessionId="session-2"
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      )
    })
    act(() => renderer.unmount())

    expect(container.scrollTop).toBe(250)
  })

  test('scrolls a hibernating row only when the section is expanded', () => {
    const rows = new Map<string, FakeRow>()
    rows.set('hib-1', fakeRow(300))
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, {
        hibernatingSessions: [baseHibernating],
        selectedHibernatingSessionId: 'hib-1',
        onSelectHibernating: () => {},
      })
    })

    // Collapsed: no DOM row, pending scroll is dropped
    expect(container.scrollTop).toBe(0)

    // Expanding later does not scroll either
    act(() => {
      useSettingsStore.setState({ hibernatingSessionsExpanded: true })
    })
    expect(container.scrollTop).toBe(0)

    act(() => renderer.unmount())
  })

  test('scrolls an expanded hibernating row into view', () => {
    useSettingsStore.setState({ hibernatingSessionsExpanded: true })
    const rows = new Map<string, FakeRow>()
    rows.set('hib-1', fakeRow(300))
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, {
        hibernatingSessions: [baseHibernating],
        selectedHibernatingSessionId: 'hib-1',
        onSelectHibernating: () => {},
      })
    })
    act(() => renderer.unmount())

    expect(container.scrollTop).toBe(250)
  })

  test('does not scroll while inactive, scrolls when activated', () => {
    const rows = new Map<string, FakeRow>()
    rows.set('session-1', fakeRow(300))
    rows.set('session-2', fakeRow(500))
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, {
        selectedSessionId: 'session-1',
        scrollSelectionActive: false,
      })
    })
    // Off-screen (closed drawer): no scroll even though the row is mounted
    expect(container.scrollTop).toBe(0)

    // Selection changes while inactive still don't scroll
    act(() => {
      renderer.update(
        <SessionList
          sessions={[baseSession, { ...baseSession, id: 'session-2' }]}
          selectedSessionId="session-2"
          scrollSelectionActive={false}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      )
    })
    expect(container.scrollTop).toBe(0)

    // Activating re-arms the pending scroll to the current selection
    act(() => {
      renderer.update(
        <SessionList
          sessions={[baseSession, { ...baseSession, id: 'session-2' }]}
          selectedSessionId="session-2"
          scrollSelectionActive={true}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      )
    })
    // rowBottom (550) - clientHeight (100) = 450
    expect(container.scrollTop).toBe(450)
    act(() => renderer.unmount())
  })

  test('does nothing when selection is cleared', () => {
    const rows = new Map<string, FakeRow>()
    rows.set('session-1', fakeRow(300))
    rows.set('session-2', fakeRow(500))
    const container = fakeContainer(rows)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(container, { selectedSessionId: null })
    })
    act(() => renderer.unmount())

    expect(container.scrollTop).toBe(0)
  })
})
