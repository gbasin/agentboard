import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession, ServerMessage, Session } from '@shared/types'
import SessionList from '../components/SessionList'
import NewSessionModal from '../components/NewSessionModal'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useThemeStore } from '../stores/themeStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  navigator?: Navigator
  ResizeObserver?: typeof ResizeObserver
  localStorage?: Storage
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalResizeObserver = globalAny.ResizeObserver
const originalLocalStorage = globalAny.localStorage

let sendCalls: Array<Record<string, unknown>> = []
let subscribeListener: ((message: ServerMessage) => void) | null = null
let keyHandlers = new Map<string, EventListener>()
let activeRenderer: TestRenderer.ReactTestRenderer | null = null

class TerminalMock {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  buffer = { active: { viewportY: 0, baseY: 0 } }
  element: HTMLElement | null = null

  loadAddon() {}
  open(container: HTMLElement) { this.element = container }
  reset() {}
  onData() {}
  onScroll() {}
  attachCustomKeyEventHandler() { return true }
  attachCustomWheelEventHandler() { return true }
  write() {}
  scrollToBottom() {}
  focus() {}
  hasSelection() { return false }
  getSelection() { return '' }
  dispose() {}
  refresh() {}
}

mock.module('@xterm/xterm', () => ({ Terminal: TerminalMock }))
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
mock.module('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} } }))
mock.module('@xterm/addon-search', () => ({ SearchAddon: class {} }))
mock.module('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
mock.module('@xterm/addon-progress', () => ({ ProgressAddon: class {} }))
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const actualWebSocket = await import('../hooks/useWebSocket')

mock.module('../hooks/useWebSocket', () => ({
  ...actualWebSocket,
  useWebSocket: () => ({
    sendMessage: (message: Record<string, unknown>) => {
      sendCalls.push(message)
    },
    subscribe: (listener: (message: ServerMessage) => void) => {
      subscribeListener = listener
      return () => {
        subscribeListener = null
      }
    },
  }),
}))


const { default: App } = await import('../App')

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

function setupDom() {
  keyHandlers = new Map()

  globalAny.localStorage = createStorage()
  globalAny.navigator = {
    platform: 'Win32',
    userAgent: 'Chrome',
    maxTouchPoints: 0,
    clipboard: { writeText: () => Promise.resolve() },
    vibrate: () => true,
  } as unknown as Navigator

  globalAny.document = {
    documentElement: {
      setAttribute: () => {},
    },
    querySelector: () => null,
  } as unknown as Document

  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    devicePixelRatio: 1,
  } as unknown as Window & typeof globalThis

  globalAny.ResizeObserver = class ResizeObserverMock {
    private callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe() {
      this.callback([], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  }
}

beforeEach(() => {
  sendCalls = []
  subscribeListener = null
  setupDom()
  activeRenderer = null

  useSessionStore.setState({
    sessions: [],
    agentSessions: { active: [], inactive: [] },
    selectedSessionId: null,
    hasLoaded: false,
    connectionStatus: 'connected',
    connectionError: null,
  })

  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'asc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    hostFilters: [],
  })

  useThemeStore.setState({ theme: 'dark' })
})

afterEach(() => {
  if (activeRenderer) {
    act(() => {
      activeRenderer?.unmount()
    })
  }
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.ResizeObserver = originalResizeObserver
  globalAny.localStorage = originalLocalStorage
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    hostFilters: [],
  })
})

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

const baseAgentSession: AgentSession = {
  sessionId: 'agent-session-a',
  logFilePath: '/tmp/agent-a.jsonl',
  projectPath: '/tmp/alpha',
  agentType: 'claude',
  displayName: 'alpha',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-01T00:00:00.000Z',
  isActive: true,
  isPinned: false,
  lastUserMessage: 'draft a plan',
}

function getKeyHandler() {
  const handler = keyHandlers.get('keydown')
  if (!handler) {
    throw new Error('Expected keydown handler')
  }
  return handler
}

describe('App', () => {
  test('handles websocket messages and errors', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    if (!subscribeListener) {
      throw new Error('Expected websocket subscription')
    }

    const updated = { ...baseSession, status: 'waiting' as const }
    const created = { ...baseSession, id: 'session-2', name: 'beta' }

    act(() => {
      subscribeListener?.({ type: 'sessions', sessions: [baseSession] })
    })

    expect(useSessionStore.getState().sessions).toHaveLength(1)

    act(() => {
      subscribeListener?.({ type: 'session-update', session: updated })
    })

    expect(useSessionStore.getState().sessions[0]?.status).toBe('waiting')

    act(() => {
      subscribeListener?.({ type: 'session-created', session: created })
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')

    act(() => {
      subscribeListener?.({ type: 'error', message: 'Boom' })
    })

    // Find the desktop sidebar SessionList (first one) - drawer also has one
    const sessionLists = renderer.root.findAllByType(SessionList)
    expect(sessionLists.length).toBeGreaterThan(0)
    expect(sessionLists[0].props.error).toBe('Boom')

  })

  test('keeps card on supersede-orphan and updates metadata on activation', () => {
    useSessionStore.setState({
      sessions: [
        {
          ...baseSession,
          agentSessionId: baseAgentSession.sessionId,
          agentSessionName: baseAgentSession.displayName,
          logFilePath: baseAgentSession.logFilePath,
          isPinned: false,
          lastUserMessage: 'draft a plan',
        },
      ],
      selectedSessionId: baseSession.id,
      hasLoaded: true,
    })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    if (!subscribeListener) {
      throw new Error('Expected websocket subscription')
    }

    const activatedSession: AgentSession = {
      ...baseAgentSession,
      sessionId: 'agent-session-b',
      logFilePath: '/tmp/agent-b.jsonl',
      displayName: 'alpha-exec',
      isPinned: true,
      lastUserMessage: 'implement the plan',
    }

    // Supersede-orphan should not remove the session card.
    act(() => {
      subscribeListener?.({
        type: 'session-orphaned',
        session: {
          ...baseAgentSession,
          isActive: false,
        },
        supersededBy: activatedSession.sessionId,
      })
    })

    const afterSupersedeOrphan = useSessionStore.getState().sessions
    expect(afterSupersedeOrphan).toHaveLength(1)
    expect(afterSupersedeOrphan[0]?.agentSessionId).toBe(baseAgentSession.sessionId)

    // Activation should update the existing card in place by tmux window.
    act(() => {
      subscribeListener?.({
        type: 'session-activated',
        session: activatedSession,
        window: baseSession.tmuxWindow,
      })
    })

    const updated = useSessionStore.getState().sessions[0]
    expect(updated?.id).toBe(baseSession.id)
    expect(updated?.agentSessionId).toBe(activatedSession.sessionId)
    expect(updated?.agentSessionName).toBe(activatedSession.displayName)
    expect(updated?.logFilePath).toBe(activatedSession.logFilePath)
    expect(updated?.isPinned).toBe(true)
    expect(updated?.lastUserMessage).toBe(activatedSession.lastUserMessage)

    // A true orphan (no supersededBy) should still remove the card.
    act(() => {
      subscribeListener?.({
        type: 'session-orphaned',
        session: { ...activatedSession, isActive: false },
      })
    })

    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  test('handles keyboard shortcuts for navigation and actions', () => {
    const sessionB = {
      ...baseSession,
      id: 'session-2',
      name: 'beta',
      createdAt: '2024-01-02T00:00:00.000Z',
    }

    useSessionStore.setState({
      sessions: [baseSession, sessionB],
      selectedSessionId: baseSession.id,
      hasLoaded: true,
    })

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    let keyHandler = getKeyHandler()

    act(() => {
      keyHandler({
        key: ']',
        code: 'BracketRight',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')

    keyHandler = getKeyHandler()

    act(() => {
      keyHandler({
        key: '[',
        code: 'BracketLeft',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')

    act(() => {
      keyHandler({
        key: 'n',
        code: 'KeyN',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    const modal = renderer.root.findByType(NewSessionModal)
    expect(modal.props.isOpen).toBe(true)

    act(() => {
      modal.props.onClose()
    })

    keyHandler = getKeyHandler()

    act(() => {
      keyHandler({
        key: 'x',
        code: 'KeyX',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(sendCalls).toContainEqual({
      type: 'session-kill',
      sessionId: 'session-1',
    })

  })
})
