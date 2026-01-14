import { afterAll, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  navigator?: Navigator
  ResizeObserver?: typeof ResizeObserver
  localStorage?: Storage
  requestAnimationFrame?: typeof requestAnimationFrame
  cancelAnimationFrame?: typeof cancelAnimationFrame
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalResizeObserver = globalAny.ResizeObserver
const originalLocalStorage = globalAny.localStorage
const originalRequestAnimationFrame = globalAny.requestAnimationFrame
const originalCancelAnimationFrame = globalAny.cancelAnimationFrame

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

const createMatchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})

function setupDom() {
  class NodeMock {}
  class ElementMock extends NodeMock {}
  class HTMLElementMock extends ElementMock {}
  const raf = (callback: FrameRequestCallback) =>
    (setTimeout(() => callback(Date.now()), 0) as unknown as number)
  const caf = (handle: number) => clearTimeout(handle)

  const createStyle = () => ({
    setProperty: () => {},
    removeProperty: () => {},
  })

  const createElement = (tagName = 'div') =>
    Object.assign(new HTMLElementMock(), {
      tagName: tagName.toUpperCase(),
      style: createStyle(),
      focus: () => {},
      setAttribute: () => {},
      removeAttribute: () => {},
      appendChild: () => {},
      remove: () => {},
    })

  globalAny.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    createElement,
    activeElement: null,
    documentElement: Object.assign(createElement('html'), {
      style: createStyle(),
      setAttribute: () => {},
      removeAttribute: () => {},
    }),
  } as unknown as Document

  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
    matchMedia: createMatchMedia,
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    visualViewport: undefined,
    innerWidth: 1200,
    innerHeight: 800,
    Node: NodeMock,
    Element: ElementMock,
    HTMLElement: HTMLElementMock,
    document: globalAny.document,
    getComputedStyle: () => ({
      overflow: 'visible',
      overflowX: 'visible',
      overflowY: 'visible',
      display: 'block',
      transform: 'none',
      translate: 'none',
      scale: 'none',
      rotate: 'none',
      perspective: 'none',
      containerType: 'normal',
      backdropFilter: 'none',
      filter: 'none',
      willChange: '',
      contain: '',
    }),
    location: {
      protocol: 'http:',
      host: 'localhost:4040',
      port: '4040',
    },
  } as unknown as Window & typeof globalThis

  globalAny.Node = NodeMock as unknown as typeof Node
  globalAny.Element = ElementMock as unknown as typeof Element
  globalAny.HTMLElement = HTMLElementMock as unknown as typeof HTMLElement
  globalAny.navigator = {
    platform: 'Win32',
    userAgent: 'Chrome',
    maxTouchPoints: 0,
    clipboard: {
      read: () => Promise.resolve([] as ClipboardItem[]),
      readText: () => Promise.resolve(''),
      writeText: () => Promise.resolve(),
    },
    vibrate: () => true,
  } as unknown as Navigator

  globalAny.ResizeObserver = class ResizeObserverMock {
    constructor(_: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  globalAny.requestAnimationFrame = raf
  globalAny.cancelAnimationFrame = caf
}

setupDom()
globalAny.localStorage = createStorage()

mock.module('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    buffer = { active: { viewportY: 0, baseY: 0 } }
    element: HTMLElement | null = null
    loadAddon() {}
    open() {}
    reset() {}
    onData() {}
    onScroll() {}
    attachCustomKeyEventHandler() { return true }
    attachCustomWheelEventHandler() { return true }
    write() {}
    scrollToBottom() {}
    hasSelection() { return false }
    getSelection() { return '' }
    dispose() {}
  },
}))
mock.module('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} },
}))
mock.module('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {},
}))
mock.module('@xterm/addon-webgl', () => ({
  WebglAddon: class { dispose() {} },
}))
mock.module('@xterm/addon-search', () => ({
  SearchAddon: class {},
}))
mock.module('@xterm/addon-serialize', () => ({
  SerializeAddon: class {},
}))
mock.module('@xterm/addon-progress', () => ({
  ProgressAddon: class {},
}))
mock.module('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

const actualWebSocket = await import('../hooks/useWebSocket')

mock.module('../hooks/useWebSocket', () => ({
  ...actualWebSocket,
  useWebSocket: () => ({
    sendMessage: () => {},
    subscribe: () => () => {},
  }),
}))

const [{ default: App }, { default: Header }, { default: SessionList }, { default: Terminal }, { default: TerminalControls }, { default: NewSessionModal }, { default: SettingsModal }, { default: DPad }, { default: NumPad }] =
  await Promise.all([
    import('../App'),
    import('../components/Header'),
    import('../components/SessionList'),
    import('../components/Terminal'),
    import('../components/TerminalControls'),
    import('../components/NewSessionModal'),
    import('../components/SettingsModal'),
    import('../components/DPad'),
    import('../components/NumPad'),
  ])

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  source: 'managed',
}

function renderMarkup(element: JSX.Element): string {
  let renderer: any = null

  act(() => {
    renderer = TestRenderer.create(element)
  })

  const tree = renderer?.toJSON?.() ?? null
  const output = tree === null ? '' : JSON.stringify(tree)

  act(() => {
    renderer?.unmount()
  })

  return output
}

describe('component rendering', () => {
  test('renders app shell', () => {
    const html = renderMarkup(<App />)
    expect(html).toContain('AGENTBOARD')
  })

  test('renders header', () => {
    const html = renderMarkup(
      <Header connectionStatus="connected" onNewSession={() => {}} tailscaleIp={null} />
    )
    expect(html).toContain('AGENTBOARD')
  })

  test('renders session list', () => {
    const html = renderMarkup(
      <SessionList
        sessions={[baseSession]}
        selectedSessionId="session-1"
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(html).toContain('Sessions')
    expect(html).toContain('alpha')
  })

  test('renders session list loading and empty states', () => {
    const loadingHtml = renderMarkup(
      <SessionList
        sessions={[]}
        selectedSessionId={null}
        loading
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(loadingHtml).toContain('animate-pulse')

    const emptyHtml = renderMarkup(
      <SessionList
        sessions={[]}
        selectedSessionId={null}
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(emptyHtml).toContain('No sessions')
  })

  test('renders session list error state', () => {
    const html = renderMarkup(
      <SessionList
        sessions={[baseSession]}
        selectedSessionId={baseSession.id}
        loading={false}
        error="Oops"
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(html).toContain('Oops')
  })

  test('renders terminal', () => {
    const html = renderMarkup(
      <Terminal
        session={baseSession}
        sessions={[baseSession]}
        connectionStatus="connected"
        sendMessage={() => {}}
        subscribe={() => () => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onKillSession={() => {}}
        onRenameSession={() => {}}
        onResumeSession={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('alpha')
  })

  test('renders terminal placeholder when no session selected', () => {
    const html = renderMarkup(
      <Terminal
        session={null}
        sessions={[]}
        connectionStatus="connected"
        sendMessage={() => {}}
        subscribe={() => () => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onKillSession={() => {}}
        onRenameSession={() => {}}
        onResumeSession={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Select a session to view terminal')
  })

  test('renders terminal mobile switcher for multiple sessions', () => {
    const secondSession = {
      ...baseSession,
      id: 'session-2',
      name: 'beta',
      status: 'waiting' as const,
    }

    const html = renderMarkup(
      <Terminal
        session={baseSession}
        sessions={[baseSession, secondSession]}
        connectionStatus="connected"
        sendMessage={() => {}}
        subscribe={() => () => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onKillSession={() => {}}
        onRenameSession={() => {}}
        onResumeSession={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('scroll-smooth')
  })

  test('renders terminal controls', () => {
    const html = renderMarkup(
      <TerminalControls
        onSendKey={() => {}}
        sessions={[{ id: 'session-1', name: 'alpha', status: 'working' }]}
        currentSessionId="session-1"
        onSelectSession={() => {}}
      />
    )
    expect(html).toContain('terminal-controls')
  })

  test('renders terminal controls session row when multiple sessions', () => {
    const html = renderMarkup(
      <TerminalControls
        onSendKey={() => {}}
        sessions={[
          { id: 'session-1', name: 'alpha', status: 'working' },
          { id: 'session-2', name: 'beta', status: 'waiting' },
        ]}
        currentSessionId="session-1"
        onSelectSession={() => {}}
      />
    )
    expect(html).toContain('snap-mandatory')
  })

  test('renders new session modal', () => {
    const html = renderMarkup(
      <NewSessionModal
        isOpen
        onClose={() => {}}
        onCreate={() => {}}
        defaultProjectDir="/tmp"
        commandPresets={[
          { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
          { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
        ]}
        defaultPresetId="claude"
        onUpdateModifiers={() => {}}
        lastProjectPath="/tmp/alpha"
        activeProjectPath="/tmp/alpha"
      />
    )
    expect(html).toContain('New Session')
  })

  test('does not render new session modal when closed', () => {
    const html = renderMarkup(
      <NewSessionModal
        isOpen={false}
        onClose={() => {}}
        onCreate={() => {}}
        defaultProjectDir="/tmp"
        commandPresets={[
          { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
          { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
        ]}
        defaultPresetId="claude"
        onUpdateModifiers={() => {}}
        lastProjectPath="/tmp/alpha"
        activeProjectPath="/tmp/alpha"
      />
    )
    expect(html).toBe('')
  })

  test('renders settings modal', () => {
    const html = renderMarkup(
      <SettingsModal isOpen onClose={() => {}} />
    )
    expect(html).toContain('Settings')
  })

  test('renders controls widgets', () => {
    const dpad = renderMarkup(<DPad onSendKey={() => {}} />)
    const numpad = renderMarkup(<NumPad onSendKey={() => {}} />)
    expect(dpad).toContain('terminal-key')
    expect(numpad).toContain('terminal-key')
  })
})

afterAll(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.ResizeObserver = originalResizeObserver
  globalAny.localStorage = originalLocalStorage
  globalAny.requestAnimationFrame = originalRequestAnimationFrame
  globalAny.cancelAnimationFrame = originalCancelAnimationFrame
})
