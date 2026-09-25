import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession, Session } from '@shared/types'
import SessionList from '../components/SessionList'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
}

const originalWindow = globalAny.window

interface FakeNode {
  scrollCalls: ScrollIntoViewOptions[]
  scrollIntoView: (options?: ScrollIntoViewOptions) => void
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    scrollCalls: [],
    scrollIntoView(options) {
      node.scrollCalls.push(options ?? {})
    },
  }
  return node
}

/** Fake scroll container backed by a mutable map of rows. Tests add/remove
 * entries from `rows` to simulate rows mounting later (async session load). */
function fakeContainer(rows: Map<string, FakeNode>) {
  return {
    querySelector(selector: string) {
      const match = selector.match(/data-session-id="([^"]*)"/)
      return (match && rows.get(match[1])) || null
    },
  }
}

// react-test-renderer calls createNodeMock for every host element with a ref;
// only the scroll container (overflow-y-auto) gets our fake, everything else
// gets null (the default behavior).
function createNodeMockFor(container: ReturnType<typeof fakeContainer>) {
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
  rows: Map<string, FakeNode>,
  props: Partial<Parameters<typeof SessionList>[0]> = {}
) {
  const container = fakeContainer(rows)
  const renderer = TestRenderer.create(
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
  return renderer
}

beforeEach(() => {
  globalAny.window = {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  } as unknown as Window & typeof globalThis

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
    const rows = new Map<string, FakeNode>()
    const target = fakeNode()
    rows.set('session-1', target)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(rows, { selectedSessionId: 'session-1' })
    })
    act(() => renderer.unmount())

    expect(target.scrollCalls).toEqual([
      { block: 'nearest', inline: 'nearest', behavior: 'instant' },
    ])
  })

  test('scrolls the newly selected row when selection changes', () => {
    const rows = new Map<string, FakeNode>()
    const first = fakeNode()
    const second = fakeNode()
    rows.set('session-1', first)
    rows.set('session-2', second)

    const props = { selectedSessionId: 'session-1' as string | null }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionList
          sessions={[baseSession, { ...baseSession, id: 'session-2' }]}
          selectedSessionId={props.selectedSessionId}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />,
        { createNodeMock: createNodeMockFor(fakeContainer(rows)) }
      )
    })

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

    expect(first.scrollCalls).toHaveLength(1)
    expect(second.scrollCalls).toEqual([
      { block: 'nearest', inline: 'nearest', behavior: 'instant' },
    ])
  })

  test('retries until the selected row mounts (restored selection)', () => {
    const rows = new Map<string, FakeNode>()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(rows, { selectedSessionId: 'session-2' })
    })

    // Row not mounted yet — nothing scrolled
    const target = fakeNode()
    rows.set('session-2', target)

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

    expect(target.scrollCalls).toHaveLength(1)
  })

  test('scrolls a hibernating row only when the section is expanded', () => {
    const rows = new Map<string, FakeNode>()
    const hibNode = fakeNode()
    rows.set('hib-1', hibNode)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(rows, {
        hibernatingSessions: [baseHibernating],
        selectedHibernatingSessionId: 'hib-1',
        onSelectHibernating: () => {},
      })
    })

    // Collapsed: no DOM row, no scroll
    expect(hibNode.scrollCalls).toHaveLength(0)

    // Expanding later does not scroll either — the pending scroll was dropped
    act(() => {
      useSettingsStore.setState({ hibernatingSessionsExpanded: true })
    })
    expect(hibNode.scrollCalls).toHaveLength(0)

    act(() => renderer.unmount())
  })

  test('scrolls an expanded hibernating row into view', () => {
    useSettingsStore.setState({ hibernatingSessionsExpanded: true })
    const rows = new Map<string, FakeNode>()
    const hibNode = fakeNode()
    rows.set('hib-1', hibNode)

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(rows, {
        hibernatingSessions: [baseHibernating],
        selectedHibernatingSessionId: 'hib-1',
        onSelectHibernating: () => {},
      })
    })
    act(() => renderer.unmount())

    expect(hibNode.scrollCalls).toEqual([
      { block: 'nearest', inline: 'nearest', behavior: 'instant' },
    ])
  })

  test('does nothing when selection is cleared', () => {
    const rows = new Map<string, FakeNode>()
    rows.set('session-1', fakeNode())
    rows.set('session-2', fakeNode())

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderList(rows, { selectedSessionId: null })
    })
    act(() => renderer.unmount())

    for (const node of rows.values()) {
      expect(node.scrollCalls).toHaveLength(0)
    }
  })
})
