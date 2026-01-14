import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  document?: Document
  navigator?: Navigator
  window?: Window & typeof globalThis
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalWindow = globalAny.window
const originalSetInterval = globalAny.setInterval
const originalClearInterval = globalAny.clearInterval

const { default: SessionDrawer } = await import('../components/SessionDrawer')

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

let keyHandlers = new Map<string, EventListener>()
let vibrateCalls: Array<number | number[] | undefined> = []
let prefersReducedMotion = false

function setupDom() {
  keyHandlers = new Map()
  vibrateCalls = []

  globalAny.document = {
    activeElement: null,
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string, handler: EventListener) => {
      if (keyHandlers.get(event) === handler) {
        keyHandlers.delete(event)
      }
    },
  } as unknown as Document

  globalAny.navigator = {
    platform: 'Win32',
    userAgent: 'Chrome',
    maxTouchPoints: 0,
    vibrate: (pattern?: number | number[]) => {
      vibrateCalls.push(pattern)
      return true
    },
  } as unknown as Navigator

  globalAny.window = {
    matchMedia: (query: string) => ({
      matches: prefersReducedMotion && query.includes('prefers-reduced-motion'),
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  } as unknown as Window & typeof globalThis
}

function createDrawerMock() {
  const listeners = new Map<string, EventListener>()
  let focusCalls = 0

  const node = {
    focus: () => {
      focusCalls += 1
    },
    addEventListener: (event: string, handler: EventListener) => {
      listeners.set(event, handler)
    },
    removeEventListener: (event: string, handler: EventListener) => {
      if (listeners.get(event) === handler) {
        listeners.delete(event)
      }
    },
  } as unknown as HTMLDivElement

  const createNodeMock = (element: { type?: unknown; props?: Record<string, unknown> }) => {
    if (element.type === 'div' && element.props?.role === 'dialog') {
      return node
    }
    return null
  }

  return { node, listeners, getFocusCalls: () => focusCalls, createNodeMock }
}

beforeEach(() => {
  prefersReducedMotion = false
  setupDom()
  globalAny.setInterval = ((_callback: () => void, _delay?: number) => {
    return 1 as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalAny.clearInterval = (() => {}) as typeof clearInterval
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showSessionIdPrefix: false,
  })
})

afterEach(() => {
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.window = originalWindow
  globalAny.setInterval = originalSetInterval
  globalAny.clearInterval = originalClearInterval
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showSessionIdPrefix: false,
  })
})

describe('SessionDrawer', () => {
  test('closes on escape and backdrop click', () => {
    const closeCalls: number[] = []
    const { createNodeMock } = createDrawerMock()

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionDrawer
          isOpen
          onClose={() => closeCalls.push(1)}
          sessions={[baseSession]}
          selectedSessionId={null}
          onSelect={() => {}}
          onRename={() => {}}
          onNewSession={() => {}}
          loading={false}
          error={null}
        />,
        { createNodeMock }
      )
    })

    const keydown = keyHandlers.get('keydown')
    expect(typeof keydown).toBe('function')

    act(() => {
      keydown?.({ key: 'Escape', preventDefault: () => {} } as KeyboardEvent)
    })

    const backdrops = renderer!.root.findAllByProps({ 'aria-hidden': 'true' })
    const backdrop = backdrops[0]

    act(() => {
      backdrop.props.onClick()
    })

    expect(closeCalls).toHaveLength(2)

    act(() => {
      renderer!.unmount()
    })
  })

  test('manages focus and restores previous element', () => {
    const previousFocusCalls: number[] = []
    const previousFocus = {
      focus: () => previousFocusCalls.push(1),
    } as unknown as HTMLElement

    if (globalAny.document) {
      ;(globalAny.document as unknown as { activeElement?: HTMLElement }).activeElement = previousFocus
    }

    const { createNodeMock, getFocusCalls } = createDrawerMock()

    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SessionDrawer
          isOpen
          onClose={() => {}}
          sessions={[baseSession]}
          selectedSessionId={null}
          onSelect={() => {}}
          onRename={() => {}}
          onNewSession={() => {}}
          loading={false}
          error={null}
        />,
        { createNodeMock }
      )
    })

    expect(getFocusCalls()).toBe(1)

    const backdrops = renderer!.root.findAllByProps({ 'aria-hidden': 'true' })
    const backdrop = backdrops[0]
    const drawer = renderer!.root.findByProps({ role: 'dialog' })

    expect(backdrop.props.style).toBeUndefined()
    expect(drawer.props.style).toBeUndefined()

    act(() => {
      renderer!.update(
        <SessionDrawer
          isOpen={false}
          onClose={() => {}}
          sessions={[baseSession]}
          selectedSessionId={null}
          onSelect={() => {}}
          onRename={() => {}}
          onNewSession={() => {}}
          loading={false}
          error={null}
        />
      )
    })

    expect(previousFocusCalls).toHaveLength(1)

    act(() => {
      renderer!.unmount()
    })
  })

  test('swipe left closes and vibrates', () => {
    const closeCalls: number[] = []
    const { listeners, createNodeMock } = createDrawerMock()

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionDrawer
          isOpen
          onClose={() => closeCalls.push(1)}
          sessions={[baseSession]}
          selectedSessionId={null}
          onSelect={() => {}}
          onRename={() => {}}
          onNewSession={() => {}}
          loading={false}
          error={null}
        />,
        { createNodeMock }
      )
    })

    const touchStart = listeners.get('touchstart')
    const touchEnd = listeners.get('touchend')

    act(() => {
      touchStart?.({
        touches: [{ clientX: 100, clientY: 40 }],
      } as unknown as TouchEvent)
      touchEnd?.({
        changedTouches: [{ clientX: 20, clientY: 45 }],
      } as unknown as TouchEvent)
    })

    expect(closeCalls).toHaveLength(1)
    expect(vibrateCalls).toEqual([10])

    act(() => {
      renderer!.unmount()
    })
  })

  test('selecting a session and new session button close the drawer', () => {
    const closeCalls: number[] = []
    const selectCalls: string[] = []
    const newSessionCalls: number[] = []
    const { createNodeMock } = createDrawerMock()

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionDrawer
          isOpen
          onClose={() => closeCalls.push(1)}
          sessions={[baseSession]}
          selectedSessionId={null}
          onSelect={(sessionId) => selectCalls.push(sessionId)}
          onRename={() => {}}
          onNewSession={() => newSessionCalls.push(1)}
          loading={false}
          error={null}
        />,
        { createNodeMock }
      )
    })

    const card = renderer!.root.findByProps({ 'data-testid': 'session-card' })

    act(() => {
      card.props.onClick()
    })

    const button = renderer!.root.findByType('button')

    act(() => {
      button.props.onClick()
    })

    expect(selectCalls).toEqual(['session-1'])
    expect(newSessionCalls).toHaveLength(1)
    expect(closeCalls).toHaveLength(2)

    act(() => {
      renderer!.unmount()
    })
  })

  test('ignores short swipe gestures', () => {
    const closeCalls: number[] = []
    const { listeners, createNodeMock } = createDrawerMock()

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionDrawer
          isOpen
          onClose={() => closeCalls.push(1)}
          sessions={[baseSession]}
          selectedSessionId={null}
          onSelect={() => {}}
          onRename={() => {}}
          onNewSession={() => {}}
          loading={false}
          error={null}
        />,
        { createNodeMock }
      )
    })

    const touchStart = listeners.get('touchstart')
    const touchEnd = listeners.get('touchend')

    act(() => {
      touchStart?.({
        touches: [{ clientX: 50, clientY: 20 }],
      } as unknown as TouchEvent)
      touchEnd?.({
        changedTouches: [{ clientX: 10, clientY: 120 }],
      } as unknown as TouchEvent)
    })

    expect(closeCalls).toHaveLength(0)
    expect(vibrateCalls).toHaveLength(0)

    act(() => {
      renderer!.unmount()
    })
  })
})
