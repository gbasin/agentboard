import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import { useThemeStore } from '../stores/themeStore'

const globalAny = globalThis as typeof globalThis & {
  document?: Document
  localStorage?: Storage
  navigator?: Navigator
  window?: Window & typeof globalThis
  ResizeObserver?: typeof ResizeObserver
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalLocalStorage = globalAny.localStorage
const originalNavigator = globalAny.navigator
const originalResizeObserver = globalAny.ResizeObserver

class TerminalMock {
  static instances: TerminalMock[] = []
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  buffer = { active: { viewportY: 0, baseY: 0 } }
  element: HTMLElement | null = null
  scrollCalls = 0
  private wheelHandler?: (event: WheelEvent) => boolean

  constructor() {
    TerminalMock.instances.push(this)
  }

  loadAddon() {}

  open(container: HTMLElement) {
    this.element = container
  }

  reset() {}

  onData() {}

  attachCustomKeyEventHandler() {
    return true
  }

  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
    this.wheelHandler = handler
    return true
  }

  write() {}

  scrollToBottom() {
    this.scrollCalls += 1
  }

  focus() {}

  hasSelection() {
    return false
  }

  getSelection() {
    return ''
  }

  dispose() {}

  refresh() {}

  emitWheel(event: WheelEvent) {
    return this.wheelHandler?.(event)
  }
}

mock.module('@xterm/xterm', () => ({ Terminal: TerminalMock }))
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

const { default: Terminal } = await import('../components/Terminal')

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

function createContainerMock() {
  const listeners = new Map<string, EventListener>()
  const input = {
    focus: () => {},
    select: () => {},
  } as unknown as HTMLInputElement
  const textarea = {
    addEventListener: (_event: string, _handler: EventListener) => {},
    removeEventListener: (_event: string, _handler: EventListener) => {},
    setAttribute: () => {},
    removeAttribute: () => {},
    focus: () => {},
  } as unknown as HTMLTextAreaElement

  const container = {
    innerHTML: '',
    addEventListener: (event: string, handler: EventListener) => {
      listeners.set(event, handler)
    },
    removeEventListener: (event: string, handler: EventListener) => {
      if (listeners.get(event) === handler) {
        listeners.delete(event)
      }
    },
    querySelector: (selector: string) =>
      selector === '.xterm-helper-textarea' ? textarea : null,
  } as unknown as HTMLDivElement

  const createNodeMock = (element: { type?: unknown }) => {
    if (element.type === 'input') return input
    if (element.type === 'div') return container
    return null
  }

  return { container, createNodeMock }
}

beforeEach(() => {
  TerminalMock.instances = []

  globalAny.localStorage = createStorage()
  globalAny.navigator = {
    userAgent: 'Chrome',
    platform: 'MacIntel',
    maxTouchPoints: 0,
    clipboard: { writeText: () => Promise.resolve() },
    vibrate: () => true,
  } as unknown as Navigator

  globalAny.window = {
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    devicePixelRatio: 1,
  } as unknown as Window & typeof globalThis

  globalAny.document = {
    fonts: { ready: Promise.resolve() },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document

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

  useThemeStore.setState({ theme: 'dark' })
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.localStorage = originalLocalStorage
  globalAny.navigator = originalNavigator
  globalAny.ResizeObserver = originalResizeObserver
})

describe('Terminal', () => {
  test('shows scroll button and handles more menu actions', () => {
    let openSettingsCalls = 0

    const { createNodeMock } = createContainerMock()
    let renderer!: TestRenderer.ReactTestRenderer

    const sentMessages: unknown[] = []
    act(() => {
      renderer = TestRenderer.create(
        <Terminal
          session={baseSession}
          sessions={[baseSession]}
          connectionStatus="connected"
          sendMessage={(msg) => { sentMessages.push(msg) }}
          subscribe={() => () => {}}
          onClose={() => {}}
          onSelectSession={() => {}}
          onNewSession={() => {}}
          onKillSession={() => {}}
          onRenameSession={() => {}}
          onResumeSession={() => {}}
          onOpenSettings={() => {
            openSettingsCalls += 1
          }}
        />,
        {
          createNodeMock,
        }
      )
    })

    const terminalInstance = TerminalMock.instances[0]
    if (!terminalInstance) {
      throw new Error('Expected terminal instance')
    }

    act(() => {
      terminalInstance.emitWheel({ deltaY: 30 } as WheelEvent)
    })

    const scrollButton = renderer.root.findAllByType('button').find(
      (button) => button.props.title === 'Scroll to bottom'
    )
    if (!scrollButton) {
      throw new Error('Expected scroll button')
    }

    const initialMessageCount = sentMessages.length

    act(() => {
      scrollButton.props.onClick()
    })

    // Scroll to bottom now sends tmux-cancel-copy-mode to exit copy-mode
    expect(sentMessages.length).toBe(initialMessageCount + 1)
    expect(sentMessages[sentMessages.length - 1]).toEqual({
      type: 'tmux-cancel-copy-mode',
      sessionId: baseSession.id,
    })

    const moreButton = renderer.root.findByProps({ title: 'More options' })

    act(() => {
      moreButton.props.onClick()
    })

    const buttons = renderer.root.findAllByType('button')
    const themeButton = buttons.find(
      (button) => button.props.children === 'Light Mode'
    )

    if (!themeButton) {
      throw new Error('Expected theme button')
    }

    act(() => {
      themeButton.props.onClick()
    })

    expect(useThemeStore.getState().theme).toBe('light')

    act(() => {
      moreButton.props.onClick()
    })

    const settingsButton = renderer.root.findAllByType('button').find(
      (button) => button.props.children === 'Settings'
    )

    if (!settingsButton) {
      throw new Error('Expected settings button')
    }

    act(() => {
      settingsButton.props.onClick()
    })

    expect(openSettingsCalls).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('renames and kills session', () => {
    const renamed: Array<{ id: string; name: string }> = []
    const killed: string[] = []

    const { createNodeMock } = createContainerMock()
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <Terminal
          session={baseSession}
          sessions={[baseSession]}
          connectionStatus="connected"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          onClose={() => {}}
          onSelectSession={() => {}}
          onNewSession={() => {}}
          onKillSession={(id) => killed.push(id)}
          onRenameSession={(id, name) => renamed.push({ id, name })}
          onResumeSession={() => {}}
          onOpenSettings={() => {}}
        />,
        {
          createNodeMock,
        }
      )
    })

    const moreButton = renderer.root.findByProps({ title: 'More options' })

    act(() => {
      moreButton.props.onClick()
    })

    const renameButton = renderer.root.findAllByType('button').find(
      (button) => button.props.children === 'Rename'
    )

    if (!renameButton) {
      throw new Error('Expected rename button')
    }

    act(() => {
      renameButton.props.onClick()
    })

    const input = renderer.root.findByType('input')

    act(() => {
      input.props.onChange({ target: { value: ' beta ' } })
    })

    act(() => {
      input.props.onKeyDown({
        key: 'Enter',
        preventDefault: () => {},
      })
    })

    expect(renamed).toEqual([{ id: baseSession.id, name: 'beta' }])

    const killButton = renderer.root.findAllByType('button').find(
      (button) =>
        typeof button.props.title === 'string' &&
        button.props.title.includes('Kill session')
    )

    if (!killButton) {
      throw new Error('Expected kill button')
    }

    act(() => {
      killButton.props.onClick()
    })

    const confirmButton = renderer.root.findAllByType('button').find(
      (button) => button.props.children === 'Kill Session'
    )

    if (!confirmButton) {
      throw new Error('Expected confirm button')
    }

    act(() => {
      confirmButton.props.onClick()
    })

    expect(killed).toEqual([baseSession.id])

    act(() => {
      renderer.unmount()
    })
  })
})
