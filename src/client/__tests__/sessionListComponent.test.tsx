import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import SessionList from '../components/SessionList'
import { useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  window?: Window & typeof globalThis
}

const originalSetTimeout = globalAny.setTimeout
const originalClearTimeout = globalAny.clearTimeout
const originalSetInterval = globalAny.setInterval
const originalClearInterval = globalAny.clearInterval
const originalWindow = globalAny.window

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

function makeSession(overrides: Partial<Session>): Session {
  return { ...baseSession, ...overrides }
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
    showSessionIdPrefix: false,
  })
})

afterEach(() => {
  globalAny.setTimeout = originalSetTimeout
  globalAny.clearTimeout = originalClearTimeout
  globalAny.setInterval = originalSetInterval
  globalAny.clearInterval = originalClearInterval
  globalAny.window = originalWindow
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showSessionIdPrefix: false,
  })
})

describe('SessionList component', () => {
  test('orders sessions by status and selects on click', () => {
    useSettingsStore.setState({
      sessionSortMode: 'status',
      sessionSortDirection: 'desc',
    })

    const sessions = [
      makeSession({
        id: 'waiting-old',
        status: 'waiting',
        lastActivity: '2024-01-01T00:00:00.000Z',
      }),
      makeSession({
        id: 'unknown',
        status: 'unknown',
        lastActivity: '2024-01-05T00:00:00.000Z',
      }),
      makeSession({
        id: 'permission',
        status: 'permission',
        lastActivity: '2024-01-04T00:00:00.000Z',
      }),
      makeSession({
        id: 'working',
        status: 'working',
        lastActivity: '2024-01-02T00:00:00.000Z',
      }),
      makeSession({
        id: 'waiting-new',
        status: 'waiting',
        lastActivity: '2024-01-03T00:00:00.000Z',
      }),
    ]

    const selected: string[] = []

    const renderer = TestRenderer.create(
      <SessionList
        sessions={sessions}
        selectedSessionId={null}
        loading={false}
        error={null}
        onSelect={(sessionId) => selected.push(sessionId)}
        onRename={() => {}}
      />
    )

    const cards = renderer.root.findAllByProps({
      'data-testid': 'session-card',
    })

    expect(cards.map((card) => card.props['data-session-id'])).toEqual([
      'permission',
      'waiting-new',
      'waiting-old',
      'working',
      'unknown',
    ])

    act(() => {
      cards[0].props.onClick()
    })

    expect(selected).toEqual(['permission'])

    act(() => {
      renderer.unmount()
    })
  })

  test('renames session on enter after long press', () => {
    globalAny.setTimeout = ((callback: () => void, delay?: number) => {
      if (delay === 500) {
        callback()
      }
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalAny.clearTimeout = (() => {}) as typeof clearTimeout

    const renameCalls: Array<{ id: string; name: string }> = []

    const renderer = TestRenderer.create(
      <SessionList
        sessions={[baseSession]}
        selectedSessionId={null}
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={(sessionId, newName) => {
          renameCalls.push({ id: sessionId, name: newName })
        }}
      />
    )

    const card = renderer.root.findByProps({ 'data-testid': 'session-card' })

    act(() => {
      card.props.onTouchStart()
    })

    const input = renderer.root.findByType('input')

    act(() => {
      input.props.onChange({ target: { value: '  Beta  ' } })
    })

    act(() => {
      input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    })

    expect(renameCalls).toEqual([{ id: 'session-1', name: 'Beta' }])

    act(() => {
      renderer.unmount()
    })
  })

  test('cancels rename on escape', () => {
    globalAny.setTimeout = ((callback: () => void, delay?: number) => {
      if (delay === 500) {
        callback()
      }
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalAny.clearTimeout = (() => {}) as typeof clearTimeout

    const renameCalls: Array<{ id: string; name: string }> = []

    const renderer = TestRenderer.create(
      <SessionList
        sessions={[baseSession]}
        selectedSessionId={null}
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={(sessionId, newName) => {
          renameCalls.push({ id: sessionId, name: newName })
        }}
      />
    )

    const card = renderer.root.findByProps({ 'data-testid': 'session-card' })

    act(() => {
      card.props.onTouchStart()
    })

    const input = renderer.root.findByType('input')

    act(() => {
      input.props.onChange({ target: { value: '  Gamma  ' } })
    })

    act(() => {
      input.props.onKeyDown({ key: 'Escape', preventDefault: () => {} })
    })

    expect(renameCalls).toEqual([])
    expect(() => renderer.root.findByType('input')).toThrow()

    act(() => {
      renderer.unmount()
    })
  })

  test('refresh interval registers and clears on unmount', () => {
    const intervals: Array<{ id: number; delay: number }> = []
    const cleared: number[] = []

    globalAny.setInterval = ((callback: () => void, delay?: number) => {
      const id = 42
      intervals.push({ id, delay: delay ?? 0 })
      return id as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalAny.clearInterval = ((id: number) => {
      cleared.push(id)
    }) as typeof clearInterval

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SessionList
          sessions={[baseSession]}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      )
    })

    expect(intervals).toEqual([{ id: 42, delay: 30000 }])

    act(() => {
      renderer.unmount()
    })

    expect(cleared).toEqual([42])
  })
})
