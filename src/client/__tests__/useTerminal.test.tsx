import { afterEach, beforeEach, describe, expect, jest, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ServerMessage } from '@shared/types'
import type { ITheme } from '@xterm/xterm'
import type { ConnectionStatus } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window
  document?: Document
  navigator?: Navigator
  ResizeObserver?: typeof ResizeObserver
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalResizeObserver = globalAny.ResizeObserver

class TerminalMock {
  static instances: TerminalMock[] = []
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  buffer = { active: { viewportY: 0, baseY: 0 } }
  element: HTMLElement | null = null
  writes: string[] = []
  pasteCalls: string[] = []
  resetCalls = 0
  focusCalls = 0
  scrollCalls = 0
  disposed = false
  selection = ''
  private dataHandler?: (data: string) => void
  private keyHandler?: (event: KeyboardEvent) => boolean
  private wheelHandler?: (event: WheelEvent) => boolean

  constructor() {
    TerminalMock.instances.push(this)
  }

  loadAddon() {}

  open(container: HTMLElement) {
    this.element = container
  }

  reset() {
    this.resetCalls += 1
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler
    return true
  }

  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
    this.wheelHandler = handler
    return true
  }

  write(data: string) {
    this.writes.push(data)
  }

  paste(text: string) {
    this.pasteCalls.push(text)
  }

  scrollToBottom() {
    this.scrollCalls += 1
  }

  focus() {
    this.focusCalls += 1
  }

  hasSelection() {
    return this.selection.length > 0
  }

  getSelection() {
    return this.selection
  }

  refreshCalls: Array<[number, number]> = []
  refresh(start: number, end: number) { this.refreshCalls.push([start, end]) }

  dispose() {
    this.disposed = true
  }

  emitData(data: string) {
    this.dataHandler?.(data)
  }

  emitWheel(event: WheelEvent) {
    return this.wheelHandler?.(event)
  }

  emitKey(event: { key: string; type: string; ctrlKey?: boolean; metaKey?: boolean }) {
    return this.keyHandler?.(event as KeyboardEvent)
  }
}

class FitAddonMock {
  static instances: FitAddonMock[] = []
  fitCalls = 0

  constructor() {
    FitAddonMock.instances.push(this)
  }

  fit() {
    this.fitCalls += 1
  }
}

class WebglAddonMock {
  static instances: WebglAddonMock[] = []
  disposed = false

  constructor() {
    WebglAddonMock.instances.push(this)
  }

  dispose() {
    this.disposed = true
  }
}

class ClipboardAddonMock {}

class SearchAddonMock {}
class SerializeAddonMock {}
class ProgressAddonMock {}

mock.module('@xterm/xterm', () => ({ Terminal: TerminalMock }))
mock.module('@xterm/addon-fit', () => ({ FitAddon: FitAddonMock }))
mock.module('@xterm/addon-clipboard', () => ({ ClipboardAddon: ClipboardAddonMock }))
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: WebglAddonMock }))
mock.module('@xterm/addon-search', () => ({ SearchAddon: SearchAddonMock }))
mock.module('@xterm/addon-serialize', () => ({ SerializeAddon: SerializeAddonMock }))
mock.module('@xterm/addon-progress', () => ({ ProgressAddon: ProgressAddonMock }))
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const { forceTextPresentation, sanitizeLink, useTerminal } = await import('../hooks/useTerminal')

// Tracks a registered event listener with its capture flag
interface ListenerEntry {
  handler: EventListener
  capture: boolean
}

function createContainerMock() {
  const textareaListeners = new Map<string, EventListener>()
  const textarea = {
    addEventListener: (event: string, handler: EventListener) => {
      textareaListeners.set(event, handler)
    },
    removeEventListener: (event: string, handler: EventListener) => {
      if (textareaListeners.get(event) === handler) {
        textareaListeners.delete(event)
      }
    },
    setAttribute: () => {},
    removeAttribute: () => {},
    focus: () => {},
  } as unknown as HTMLTextAreaElement

  // Store multiple listeners per event to support both bubble and capture phase
  const listenerEntries = new Map<string, ListenerEntry[]>()

  // Legacy single-entry map kept for backward compatibility with existing tests
  const listeners = new Map<string, EventListener>()

  // Track display style changes for iOS compositor repaint tests
  const displayLog: string[] = []
  const containerStyle = { cssText: '' } as Record<string, string>
  Object.defineProperty(containerStyle, 'display', {
    get() { return displayLog.length ? displayLog[displayLog.length - 1] : '' },
    set(v: string) { displayLog.push(v) },
    enumerable: true,
    configurable: true,
  })

  const container = {
    innerHTML: 'existing',
    style: containerStyle,
    get offsetHeight() { return 100 },
    addEventListener: (
      event: string,
      handler: EventListener,
      options?: boolean | AddEventListenerOptions,
    ) => {
      const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
      const entries = listenerEntries.get(event) ?? []
      entries.push({ handler, capture })
      listenerEntries.set(event, entries)
      // Keep legacy map in sync (last writer wins, mirrors old behavior)
      listeners.set(event, handler)
    },
    removeEventListener: (
      event: string,
      handler: EventListener,
      options?: boolean | EventListenerOptions,
    ) => {
      const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
      const entries = listenerEntries.get(event)
      if (entries) {
        const idx = entries.findIndex(
          (e) => e.handler === handler && e.capture === capture,
        )
        if (idx !== -1) entries.splice(idx, 1)
        if (entries.length === 0) listenerEntries.delete(event)
      }
      // Legacy map cleanup
      if (listeners.get(event) === handler) {
        listeners.delete(event)
      }
    },
    querySelector: (selector: string) =>
      selector === '.xterm-helper-textarea' ? textarea : null,
  } as unknown as HTMLDivElement

  /**
   * Dispatch a mock event to all registered listeners for the given event name.
   * Capture-phase listeners fire first, then bubble-phase listeners.
   */
  const dispatchEvent = (event: string, eventObj: unknown) => {
    const entries = listenerEntries.get(event)
    if (!entries) return
    // Fire capture-phase listeners first
    for (const entry of entries) {
      if (entry.capture) entry.handler(eventObj as Event)
    }
    // Then bubble-phase listeners
    for (const entry of entries) {
      if (!entry.capture) entry.handler(eventObj as Event)
    }
  }

  return { container, textarea, listeners, listenerEntries, dispatchEvent, displayLog }
}

function TerminalHarness(props: {
  sessionId: string | null
  tmuxTarget?: string | null
  connectionStatus?: ConnectionStatus
  connectionEpoch?: number
  sendMessage: (message: any) => void
  subscribe: (listener: (message: ServerMessage) => void) => () => void
  theme: ITheme
  fontSize: number
  lineHeight?: number
  letterSpacing?: number
  fontFamily?: string
  useWebGL?: boolean
  onScrollChange?: (isAtBottom: boolean) => void
}) {
  const { containerRef } = useTerminal({
    ...props,
    tmuxTarget: props.tmuxTarget ?? null,
    connectionStatus: props.connectionStatus ?? 'connected',
    connectionEpoch: props.connectionEpoch ?? 0,
    lineHeight: props.lineHeight ?? 1.0,
    letterSpacing: props.letterSpacing ?? 0,
    fontFamily: props.fontFamily ?? '"JetBrains Mono Variable", monospace',
    useWebGL: props.useWebGL ?? true,
  })
  return <div ref={containerRef} />
}

beforeEach(() => {
  TerminalMock.instances = []
  FitAddonMock.instances = []
  WebglAddonMock.instances = []

  globalAny.window = {
    setTimeout: ((callback: () => void) => {
      callback()
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
    devicePixelRatio: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis

  // Mock requestAnimationFrame to execute callback synchronously
  globalAny.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }
  globalAny.cancelAnimationFrame = () => {}

  globalAny.document = {
    fonts: { ready: Promise.resolve() },
    visibilityState: 'visible',
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
})

afterEach(() => {
  jest.useRealTimers()
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.ResizeObserver = originalResizeObserver
})

describe('forceTextPresentation', () => {
  test('returns input when no emoji substitutions needed', () => {
    expect(forceTextPresentation('hello')).toBe('hello')
  })

  test('inserts text presentation selector for emoji-like chars', () => {
    const result = forceTextPresentation(`x\u23FAy`)
    expect(result).toBe(`x\u23FA\uFE0Ey`)
  })
})

describe('sanitizeLink', () => {
  test('strips trailing punctuation and unmatched brackets', () => {
    expect(sanitizeLink('https://github.com/tmux-plugins/tmux-resurrect))')).toBe(
      'https://github.com/tmux-plugins/tmux-resurrect'
    )
    expect(sanitizeLink('https://example.com/path).')).toBe('https://example.com/path')
  })

  test('preserves balanced brackets', () => {
    expect(sanitizeLink('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    )
  })
})

describe('useTerminal', () => {
  test('attaches, forwards input/output, and handles key events', () => {
    const clipboardWrites: string[] = []
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: (text: string) => {
          clipboardWrites.push(text)
          return Promise.resolve()
        },
      },
    } as unknown as Navigator

    const sendCalls: Array<Record<string, unknown>> = []
    const scrollStates: boolean[] = []
    const listeners: Array<(message: ServerMessage) => void> = []

    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={(listener) => {
            listeners.push(listener)
            return () => {}
          }}
          theme={{ background: '#000' }}
          fontSize={12}
          onScrollChange={(isAtBottom) => scrollStates.push(isAtBottom)}
        />,
        {
          createNodeMock: () => container,
        }
      )
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) {
      throw new Error('Expected terminal instance')
    }

    act(() => {
      terminal.emitData('ls')
    })

    expect(sendCalls).toContainEqual({
      type: 'terminal-input',
      sessionId: 'session-1',
      data: 'ls',
    })

    terminal.selection = 'copy-me'
    const handledCopy = terminal.emitKey({
      key: 'c',
      type: 'keydown',
      ctrlKey: true,
    })

    expect(handledCopy).toBe(false)
    expect(clipboardWrites).toEqual(['copy-me'])

    terminal.emitKey({ key: 'Backspace', type: 'keydown', ctrlKey: true })

    expect(sendCalls).toContainEqual({
      type: 'terminal-input',
      sessionId: 'session-1',
      data: '\x17',
    })

    act(() => {
      listeners[0]?.({
        type: 'terminal-output',
        sessionId: 'session-1',
        data: `x\u23FAy`,
      })
    })

    // Output is wrapped in synchronized output sequences (BSU/ESU)
    expect(terminal.writes).toEqual([`\x1b[?2026hx\u23FAy\x1b[?2026l`])

    terminal.selection = ''

    act(() => {
      terminal.emitWheel({ deltaY: -30 } as WheelEvent)
    })

    expect(scrollStates).toContain(false)

    act(() => {
      renderer.update(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={(listener) => {
            listeners.push(listener)
            return () => {}
          }}
          theme={{ background: '#000' }}
          fontSize={14}
          onScrollChange={(isAtBottom) => scrollStates.push(isAtBottom)}
        />
      )
    })

    expect(terminal.options.fontSize).toBe(14)
    expect(sendCalls.some((call) => call.type === 'terminal-resize')).toBe(true)
  })

  test('adds text presentation selectors to output on iOS only', async () => {
    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const listeners: Array<(message: ServerMessage) => void> = []
    const { container } = createContainerMock()

    await act(async () => {
      TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={(listener) => {
            listeners.push(listener)
            return () => {}
          }}
          theme={{ background: '#000' }}
          fontSize={12}
          onScrollChange={() => {}}
        />,
        {
          createNodeMock: () => container,
        }
      )
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) {
      throw new Error('Expected terminal instance')
    }

    act(() => {
      listeners[0]?.({
        type: 'terminal-output',
        sessionId: 'session-1',
        data: `x\u23FAy`,
      })
    })

    expect(terminal.writes).toEqual([`\x1b[?2026hx\u23FA\uFE0Ey\x1b[?2026l`])
  })

  test('detaches previous session and cleans up on unmount', async () => {
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const sendCalls: Array<Record<string, unknown>> = []
    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        {
          createNodeMock: () => container,
        }
      )
      // Wait for document.fonts.ready promise to resolve
      await Promise.resolve()
    })

    await act(async () => {
      renderer.update(
        <TerminalHarness
          sessionId="session-2"
          tmuxTarget="agentboard:@2"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />
      )
      await Promise.resolve()
    })

    expect(sendCalls).toContainEqual({
      type: 'terminal-detach',
      sessionId: 'session-1',
    })
    expect(sendCalls).toContainEqual({
      type: 'terminal-attach',
      sessionId: 'session-2',
      tmuxTarget: 'agentboard:@2',
      cols: 80,
      rows: 24,
    })

    act(() => {
      renderer.unmount()
    })

    const terminal = TerminalMock.instances[0]
    const webglAddon = WebglAddonMock.instances[0]

    expect(terminal?.disposed).toBe(true)
    expect(webglAddon?.disposed).toBe(true)
    expect(container.innerHTML).toBe('')
  })

  test('reattaches active session after websocket reconnect', async () => {
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const sendCalls: Array<Record<string, unknown>> = []
    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          connectionStatus="connected"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        {
          createNodeMock: () => container,
        }
      )
      await Promise.resolve()
    })

    await act(async () => {
      renderer.update(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          connectionStatus="reconnecting"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />
      )
      await Promise.resolve()
    })

    await act(async () => {
      renderer.update(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          connectionStatus="connected"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />
      )
      await Promise.resolve()
    })

    const attachCalls = sendCalls.filter((call) => call.type === 'terminal-attach')
    expect(attachCalls).toHaveLength(2)
    expect(attachCalls[1]).toEqual({
      type: 'terminal-attach',
      sessionId: 'session-1',
      tmuxTarget: 'agentboard:@1',
      cols: 80,
      rows: 24,
    })
  })

  test('reattaches active session when connection epoch changes while connected', async () => {
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const sendCalls: Array<Record<string, unknown>> = []
    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          connectionStatus="connected"
          connectionEpoch={1}
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        {
          createNodeMock: () => container,
        }
      )
      await Promise.resolve()
    })

    await act(async () => {
      renderer.update(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          connectionStatus="connected"
          connectionEpoch={2}
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />
      )
      await Promise.resolve()
    })

    const attachCalls = sendCalls.filter((call) => call.type === 'terminal-attach')
    expect(attachCalls).toHaveLength(2)
    expect(attachCalls[1]).toEqual({
      type: 'terminal-attach',
      sessionId: 'session-1',
      tmuxTarget: 'agentboard:@1',
      cols: 80,
      rows: 24,
    })
  })

  test('Cmd+V triggers paste via capture-phase listener', async () => {
    jest.useFakeTimers()
    const originalFetch = globalThis.fetch
    // Mock fetch so /api/clipboard-file-path returns no file path (normal paste flow)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === '/api/clipboard-file-path') {
        return { ok: true, json: async () => ({ path: null }) } as Response
      }
      return originalFetch(input)
    }) as typeof fetch

    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve('fallback-text'),
      },
    } as unknown as Navigator

    const sendCalls: Array<Record<string, unknown>> = []
    const { container, dispatchEvent } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        {
          createNodeMock: () => container,
        },
      )
      await Promise.resolve()
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) throw new Error('Expected terminal instance')

    // Emit Cmd+V keydown (metaKey=true on macOS)
    const result = terminal.emitKey({
      key: 'v',
      type: 'keydown',
      metaKey: true,
      ctrlKey: false,
    })
    // Key handler should return false to swallow the event
    expect(result).toBe(false)

    // Simulate the browser paste event that follows Cmd+V.
    // The hook's capture-phase listener grabs clipboardData text.
    const pasteEvent = {
      type: 'paste',
      preventDefault: mock(() => {}),
      stopPropagation: mock(() => {}),
      clipboardData: { getData: () => 'pasted-text' },
    }
    dispatchEvent('paste', pasteEvent)

    // Advance past the 100ms paste timeout and flush the async paste handler
    await act(async () => {
      jest.advanceTimersByTime(100)
    })

    expect(terminal.pasteCalls).toContain('pasted-text')
    // The capture-phase listener should have prevented the default to block ClipboardAddon
    expect(pasteEvent.preventDefault).toHaveBeenCalled()
    expect(pasteEvent.stopPropagation).toHaveBeenCalled()

    act(() => {
      renderer.unmount()
    })

    globalThis.fetch = originalFetch
  })

  test('Ctrl+V on macOS sends empty bracket paste', async () => {
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve(''),
      },
    } as unknown as Navigator

    const sendCalls: Array<Record<string, unknown>> = []
    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        {
          createNodeMock: () => container,
        },
      )
      await Promise.resolve()
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) throw new Error('Expected terminal instance')

    // Ctrl+V on macOS (ctrlKey=true, metaKey=false) should trigger bracket paste
    const result = terminal.emitKey({
      key: 'v',
      type: 'keydown',
      ctrlKey: true,
      metaKey: false,
    })

    // Should return false (swallowed because session is attached)
    expect(result).toBe(false)
    // Should have sent bracket paste markers directly as terminal-input
    // (not via terminal.paste('') which depends on bracketedPasteMode being on)
    expect(sendCalls).toContainEqual({
      type: 'terminal-input',
      sessionId: 'session-1',
      data: '\x1b[200~\x1b[201~',
    })
    // Should NOT have called terminal.paste() — that path depends on bracketedPasteMode
    expect(terminal.pasteCalls).toEqual([])

    act(() => {
      renderer.unmount()
    })
  })

  test('Ctrl+V while in tmux copy-mode exits copy-mode first', async () => {
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve(''),
      },
    } as unknown as Navigator

    const sendCalls: Array<Record<string, unknown>> = []
    const listeners: Array<(message: ServerMessage) => void> = []
    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={(listener) => {
            listeners.push(listener)
            return () => {}
          }}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        {
          createNodeMock: () => container,
        },
      )
      await Promise.resolve()
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) throw new Error('Expected terminal instance')

    // Put the hook into copy-mode via server message
    act(() => {
      listeners[0]?.({
        type: 'tmux-copy-mode-status',
        sessionId: 'session-1',
        inCopyMode: true,
      })
    })

    sendCalls.length = 0 // Clear prior messages

    // Ctrl+V while in copy-mode
    terminal.emitKey({
      key: 'v',
      type: 'keydown',
      ctrlKey: true,
      metaKey: false,
    })

    // Should have sent tmux-cancel-copy-mode BEFORE the bracket paste
    expect(sendCalls[0]).toEqual({
      type: 'tmux-cancel-copy-mode',
      sessionId: 'session-1',
    })
    expect(sendCalls[1]).toEqual({
      type: 'terminal-input',
      sessionId: 'session-1',
      data: '\x1b[200~\x1b[201~',
    })
    expect(terminal.pasteCalls).toEqual([])

    act(() => {
      renderer.unmount()
    })
  })

  test('falls back to clipboard API when paste event never fires', async () => {
    jest.useFakeTimers()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === '/api/clipboard-file-path') {
        return { ok: true, json: async () => ({ path: null }) } as Response
      }
      return originalFetch(input)
    }) as typeof fetch

    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve('clipboard-api-text'),
      },
    } as unknown as Navigator

    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) throw new Error('Expected terminal instance')

    // Emit Cmd+V but do NOT dispatch a paste event
    terminal.emitKey({ key: 'v', type: 'keydown', metaKey: true, ctrlKey: false })

    // Trigger the 100ms paste timeout and flush the async clipboard fallback
    await act(async () => {
      jest.advanceTimersByTime(100)
    })

    // Should have fallen back to navigator.clipboard.readText()
    expect(terminal.pasteCalls).toContain('clipboard-api-text')

    act(() => { renderer.unmount() })
    globalThis.fetch = originalFetch
  })

  test('Cmd+V with empty clipboard checks Finder file path on macOS', async () => {
    jest.useFakeTimers()
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve(''),
      },
    } as unknown as Navigator

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === '/api/clipboard-file-path') {
        return { ok: true, json: async () => ({ path: '/Users/test/file.txt' }) } as Response
      }
      return originalFetch(input)
    }) as typeof fetch

    const sendCalls: Array<Record<string, unknown>> = []
    const { container, dispatchEvent } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={(message) => sendCalls.push(message)}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) throw new Error('Expected terminal instance')

    // Emit Cmd+V
    terminal.emitKey({ key: 'v', type: 'keydown', metaKey: true, ctrlKey: false })

    // Dispatch paste event with empty text (simulating Finder file copy)
    dispatchEvent('paste', {
      type: 'paste',
      preventDefault: () => {},
      stopPropagation: () => {},
      clipboardData: { getData: () => '' },
    })

    // Advance past the paste timeout and flush the async fetch handler
    await act(async () => {
      jest.advanceTimersByTime(100)
    })

    // Should have sent the file path as terminal-input (not bracket paste)
    expect(sendCalls).toContainEqual({
      type: 'terminal-input',
      sessionId: 'session-1',
      data: '/Users/test/file.txt',
    })
    // Should NOT have called terminal.paste() since we used raw input
    expect(terminal.pasteCalls).toEqual([])

    act(() => { renderer.unmount() })
    globalThis.fetch = originalFetch
  })

  test('Cmd+V does nothing when no session is attached', async () => {
    jest.useFakeTimers()
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve('some-text'),
      },
    } as unknown as Navigator

    const { container } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId={null}
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    const terminal = TerminalMock.instances[0]
    if (!terminal) throw new Error('Expected terminal instance')

    // Emit Cmd+V with no attached session
    terminal.emitKey({ key: 'v', type: 'keydown', metaKey: true, ctrlKey: false })

    // Advance past the paste timeout and flush any async operations
    await act(async () => {
      jest.advanceTimersByTime(100)
    })

    // Should not have pasted anything since no session is attached
    expect(terminal.pasteCalls).toEqual([])

    act(() => { renderer.unmount() })
  })

  test('forces iOS compositor repaint on visibility resume', async () => {
    // Use deferred timers to verify the 200ms delay behavior
    const pendingTimers: Array<{ callback: () => void; delay: number; id: number }> = []
    let nextTimerId = 100
    globalAny.window = {
      setTimeout: ((cb: () => void, delay?: number) => {
        const id = nextTimerId++
        pendingTimers.push({ callback: cb, delay: delay ?? 0, id })
        return id
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis

    let visibilityState = 'hidden'
    const docListeners = new Map<string, Set<EventListener>>()
    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      get visibilityState() { return visibilityState },
      addEventListener(event: string, handler: EventListener) {
        const set = docListeners.get(event) ?? new Set()
        set.add(handler)
        docListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        docListeners.get(event)?.delete(handler)
      },
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    // Clear initialization artifacts
    pendingTimers.length = 0
    displayLog.length = 0

    // Simulate resume: visibility changes to 'visible'
    visibilityState = 'visible'
    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })

    // No display toggle yet — 200ms timer is pending
    expect(displayLog).toEqual([])

    // Find and execute the 200ms repaint timer
    const repaintTimer = pendingTimers.find(t => t.delay === 200)
    expect(repaintTimer).toBeDefined()
    act(() => { repaintTimer!.callback() })

    // Now display should be toggled
    expect(displayLog).toEqual(['none', ''])

    act(() => { renderer.unmount() })
  })

  test('skips repaint on non-iOS visibility resume', async () => {
    let visibilityState = 'hidden'
    const docListeners = new Map<string, Set<EventListener>>()
    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      get visibilityState() { return visibilityState },
      addEventListener(event: string, handler: EventListener) {
        const set = docListeners.get(event) ?? new Set()
        set.add(handler)
        docListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        docListeners.get(event)?.delete(handler)
      },
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    displayLog.length = 0

    visibilityState = 'visible'
    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })

    // Non-iOS: no display toggle should have happened
    expect(displayLog).toEqual([])

    act(() => { renderer.unmount() })
  })

  test('forces repaint after terminal-ready on iOS', async () => {
    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const listeners: Array<(message: ServerMessage) => void> = []
    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={(listener) => {
            listeners.push(listener)
            return () => {}
          }}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    displayLog.length = 0

    // Deliver terminal-ready for the attached session
    act(() => {
      listeners[0]?.({
        type: 'terminal-ready',
        sessionId: 'session-1',
      })
    })

    // Should have toggled display for compositor repaint
    expect(displayLog).toEqual(['none', ''])

    act(() => { renderer.unmount() })
  })

  test('does not force repaint after terminal-ready on non-iOS', async () => {
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const listeners: Array<(message: ServerMessage) => void> = []
    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={(listener) => {
            listeners.push(listener)
            return () => {}
          }}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    displayLog.length = 0

    act(() => {
      listeners[0]?.({
        type: 'terminal-ready',
        sessionId: 'session-1',
      })
    })

    // Non-iOS: no display toggle
    expect(displayLog).toEqual([])

    act(() => { renderer.unmount() })
  })

  test('cleans up iOS visibilitychange listener and pending timer on unmount', async () => {
    // Deferred timers to verify pending timer cancellation
    const pendingTimers: Array<{ callback: () => void; delay: number; id: number }> = []
    let nextTimerId = 100
    const clearedIds = new Set<number>()
    globalAny.window = {
      setTimeout: ((cb: () => void, delay?: number) => {
        const id = nextTimerId++
        pendingTimers.push({ callback: cb, delay: delay ?? 0, id })
        return id
      }) as typeof setTimeout,
      clearTimeout: ((id: number) => { clearedIds.add(id) }) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis

    const docListeners = new Map<string, Set<EventListener>>()
    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      visibilityState: 'visible',
      addEventListener(event: string, handler: EventListener) {
        const set = docListeners.get(event) ?? new Set()
        set.add(handler)
        docListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        docListeners.get(event)?.delete(handler)
      },
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    // Listener should be registered
    expect(docListeners.get('visibilitychange')?.size).toBe(1)

    // Fire visibilitychange to create a pending repaint timer
    pendingTimers.length = 0
    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })
    const repaintTimer = pendingTimers.find(t => t.delay === 200)
    expect(repaintTimer).toBeDefined()

    act(() => { renderer.unmount() })

    // After unmount, listener should be removed
    const remaining = docListeners.get('visibilitychange')?.size ?? 0
    expect(remaining).toBe(0)

    // Pending repaint timer should have been cleared
    expect(clearedIds.has(repaintTimer!.id)).toBe(true)

    // Fire visibilitychange after unmount — should not toggle display
    displayLog.length = 0
    for (const handler of docListeners.get('visibilitychange') ?? []) {
      handler(new Event('visibilitychange'))
    }
    expect(displayLog).toEqual([])
  })

  test('coalesces rapid iOS visibility resumes into single repaint', async () => {
    const pendingTimers: Array<{ callback: () => void; delay: number; id: number }> = []
    let nextTimerId = 100
    const clearedIds = new Set<number>()
    globalAny.window = {
      setTimeout: ((cb: () => void, delay?: number) => {
        const id = nextTimerId++
        pendingTimers.push({ callback: cb, delay: delay ?? 0, id })
        return id
      }) as typeof setTimeout,
      clearTimeout: ((id: number) => { clearedIds.add(id) }) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis

    let visibilityState = 'hidden'
    const docListeners = new Map<string, Set<EventListener>>()
    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      get visibilityState() { return visibilityState },
      addEventListener(event: string, handler: EventListener) {
        const set = docListeners.get(event) ?? new Set()
        set.add(handler)
        docListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        docListeners.get(event)?.delete(handler)
      },
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    pendingTimers.length = 0
    displayLog.length = 0

    // Fire visibilitychange twice rapidly
    visibilityState = 'visible'
    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })
    const firstTimer = pendingTimers.find(t => t.delay === 200)
    expect(firstTimer).toBeDefined()

    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })

    // First timer should have been cleared
    expect(clearedIds.has(firstTimer!.id)).toBe(true)

    // Execute only the latest timer
    const lastTimer = pendingTimers.filter(t => t.delay === 200).pop()
    act(() => { lastTimer!.callback() })

    // Only one repaint should have happened
    expect(displayLog).toEqual(['none', ''])

    act(() => { renderer.unmount() })
  })

  test('triggers repaint on iOS pageshow with persisted=true', async () => {
    const pendingTimers: Array<{ callback: () => void; delay: number; id: number }> = []
    let nextTimerId = 100
    const winListeners = new Map<string, Set<EventListener>>()
    globalAny.window = {
      setTimeout: ((cb: () => void, delay?: number) => {
        const id = nextTimerId++
        pendingTimers.push({ callback: cb, delay: delay ?? 0, id })
        return id
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener(event: string, handler: EventListener) {
        const set = winListeners.get(event) ?? new Set()
        set.add(handler)
        winListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        winListeners.get(event)?.delete(handler)
      },
    } as unknown as Window & typeof globalThis

    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    pendingTimers.length = 0
    displayLog.length = 0

    // pageshow with persisted=true should trigger repaint
    act(() => {
      for (const handler of winListeners.get('pageshow') ?? []) {
        handler({ type: 'pageshow', persisted: true } as unknown as Event)
      }
    })

    const repaintTimer = pendingTimers.find(t => t.delay === 200)
    expect(repaintTimer).toBeDefined()

    act(() => { repaintTimer!.callback() })
    expect(displayLog).toEqual(['none', ''])

    // Reset and test persisted=false — should NOT trigger repaint
    pendingTimers.length = 0
    displayLog.length = 0

    act(() => {
      for (const handler of winListeners.get('pageshow') ?? []) {
        handler({ type: 'pageshow', persisted: false } as unknown as Event)
      }
    })

    expect(pendingTimers.find(t => t.delay === 200)).toBeUndefined()

    act(() => { renderer.unmount() })
  })

  test('triggers repaint on iOS window focus (fallback for PWA foreground)', async () => {
    const pendingTimers: Array<{ callback: () => void; delay: number; id: number }> = []
    let nextTimerId = 100
    const winListeners = new Map<string, Set<EventListener>>()
    globalAny.window = {
      setTimeout: ((cb: () => void, delay?: number) => {
        const id = nextTimerId++
        pendingTimers.push({ callback: cb, delay: delay ?? 0, id })
        return id
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener(event: string, handler: EventListener) {
        const set = winListeners.get(event) ?? new Set()
        set.add(handler)
        winListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        winListeners.get(event)?.delete(handler)
      },
    } as unknown as Window & typeof globalThis

    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    pendingTimers.length = 0
    displayLog.length = 0

    // window 'focus' should trigger repaint on iOS
    act(() => {
      for (const handler of winListeners.get('focus') ?? []) {
        handler(new Event('focus'))
      }
    })

    const repaintTimer = pendingTimers.find(t => t.delay === 200)
    expect(repaintTimer).toBeDefined()

    act(() => { repaintTimer!.callback() })
    expect(displayLog).toEqual(['none', ''])

    // Verify terminal.refresh was called to force xterm re-render
    const terminal = TerminalMock.instances[0]
    expect(terminal?.refreshCalls.length).toBeGreaterThan(0)
    expect(terminal?.refreshCalls[0]).toEqual([0, 23])

    act(() => { renderer.unmount() })
  })

  test('does not trigger repaint on non-iOS window focus', async () => {
    const winListeners = new Map<string, Set<EventListener>>()
    globalAny.window = {
      setTimeout: ((callback: () => void) => {
        callback()
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener(event: string, handler: EventListener) {
        const set = winListeners.get(event) ?? new Set()
        set.add(handler)
        winListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        winListeners.get(event)?.delete(handler)
      },
    } as unknown as Window & typeof globalThis

    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    displayLog.length = 0

    // window 'focus' should NOT register a listener on non-iOS
    const focusHandlers = winListeners.get('focus')
    expect(focusHandlers?.size ?? 0).toBe(0)

    act(() => { renderer.unmount() })
  })

  test('restores display when repaint canceled mid-toggle', async () => {
    // Deferred timers AND deferred rAF to test cancel between hide and restore
    const pendingTimers: Array<{ callback: () => void; delay: number; id: number }> = []
    let nextTimerId = 100
    const clearedTimerIds = new Set<number>()

    const pendingRafs: Array<{ callback: FrameRequestCallback; id: number }> = []
    let nextRafId = 500
    const canceledRafIds = new Set<number>()

    globalAny.window = {
      setTimeout: ((cb: () => void, delay?: number) => {
        const id = nextTimerId++
        pendingTimers.push({ callback: cb, delay: delay ?? 0, id })
        return id
      }) as typeof setTimeout,
      clearTimeout: ((id: number) => { clearedTimerIds.add(id) }) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis

    globalAny.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = nextRafId++
      pendingRafs.push({ callback: cb, id })
      return id
    }
    globalAny.cancelAnimationFrame = (id: number) => { canceledRafIds.add(id) }

    let visibilityState = 'hidden'
    const docListeners = new Map<string, Set<EventListener>>()
    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      get visibilityState() { return visibilityState },
      addEventListener(event: string, handler: EventListener) {
        const set = docListeners.get(event) ?? new Set()
        set.add(handler)
        docListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        docListeners.get(event)?.delete(handler)
      },
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    pendingTimers.length = 0
    pendingRafs.length = 0
    displayLog.length = 0

    // Fire first resume
    visibilityState = 'visible'
    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })

    // Execute the 200ms timer → forceRepaint → display='none', raf1 queued
    const timer1 = pendingTimers.find(t => t.delay === 200)
    expect(timer1).toBeDefined()
    act(() => { timer1!.callback() })
    expect(displayLog).toEqual(['none'])

    // raf1 is pending but NOT executed yet
    expect(pendingRafs.length).toBeGreaterThan(0)

    // Fire second resume BEFORE raf1 completes — should cancel and restore
    pendingTimers.length = 0
    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })

    // cancelIosRepaint should have restored display to original value
    expect(displayLog).toEqual(['none', ''])

    // Now let the second repaint run to completion
    const timer2 = pendingTimers.find(t => t.delay === 200)
    expect(timer2).toBeDefined()
    act(() => { timer2!.callback() })
    // display='none' again
    expect(displayLog).toEqual(['none', '', 'none'])

    // Run both rAFs
    while (pendingRafs.length > 0) {
      const raf = pendingRafs.shift()!
      if (!canceledRafIds.has(raf.id)) {
        act(() => { raf.callback(0) })
      }
    }

    // Should be restored
    expect(displayLog[displayLog.length - 1]).toBe('')

    act(() => { renderer.unmount() })
  })

  test('visibility + terminal-ready triggers coalesce into single repaint', async () => {
    // Both triggers fire close together (reconnect + resume scenario).
    // The 50ms terminal-ready repaint should supersede the 200ms visibility
    // repaint, resulting in exactly one hide/restore cycle.
    const pendingTimers: Array<{ callback: () => void; delay: number; id: number }> = []
    let nextTimerId = 100
    const clearedTimerIds = new Set<number>()

    globalAny.window = {
      setTimeout: ((cb: () => void, delay?: number) => {
        const id = nextTimerId++
        pendingTimers.push({ callback: cb, delay: delay ?? 0, id })
        return id
      }) as typeof setTimeout,
      clearTimeout: ((id: number) => { clearedTimerIds.add(id) }) as typeof clearTimeout,
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis

    let visibilityState = 'hidden'
    const docListeners = new Map<string, Set<EventListener>>()
    globalAny.document = {
      fonts: { ready: Promise.resolve() },
      get visibilityState() { return visibilityState },
      addEventListener(event: string, handler: EventListener) {
        const set = docListeners.get(event) ?? new Set()
        set.add(handler)
        docListeners.set(event, set)
      },
      removeEventListener(event: string, handler: EventListener) {
        docListeners.get(event)?.delete(handler)
      },
    } as unknown as Document

    globalAny.navigator = {
      userAgent: 'iPhone',
      platform: 'iPhone',
      maxTouchPoints: 5,
      clipboard: { writeText: () => Promise.resolve() },
    } as unknown as Navigator

    const listeners: Array<(message: ServerMessage) => void> = []
    const { container, displayLog } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={(listener) => {
            listeners.push(listener)
            return () => {}
          }}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        { createNodeMock: () => container },
      )
      await Promise.resolve()
    })

    pendingTimers.length = 0
    displayLog.length = 0

    // 1. Visibility resume fires → schedules 200ms repaint
    visibilityState = 'visible'
    act(() => {
      for (const handler of docListeners.get('visibilitychange') ?? []) {
        handler(new Event('visibilitychange'))
      }
    })

    const visibilityTimer = pendingTimers.find(t => t.delay === 200)
    expect(visibilityTimer).toBeDefined()

    // 2. terminal-ready fires shortly after → schedules 50ms repaint,
    //    which cancels the 200ms visibility repaint
    act(() => {
      listeners[0]?.({ type: 'terminal-ready', sessionId: 'session-1' })
    })

    const readyTimer = pendingTimers.find(t => t.delay === 50)
    expect(readyTimer).toBeDefined()

    // The 200ms visibility timer should have been cleared
    expect(clearedTimerIds.has(visibilityTimer!.id)).toBe(true)

    // No display toggle yet — only 50ms timer is pending
    expect(displayLog).toEqual([])

    // 3. Execute the 50ms timer (the only one that should fire)
    act(() => { readyTimer!.callback() })

    // Exactly one hide/restore cycle
    expect(displayLog).toEqual(['none', ''])

    act(() => { renderer.unmount() })
  })

  test('paste capture-phase listener is cleaned up on unmount', async () => {
    globalAny.navigator = {
      userAgent: 'Chrome',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve(''),
      },
    } as unknown as Navigator

    const { container, listenerEntries } = createContainerMock()

    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <TerminalHarness
          sessionId="session-1"
          tmuxTarget="agentboard:@1"
          sendMessage={() => {}}
          subscribe={() => () => {}}
          theme={{ background: '#000' }}
          fontSize={12}
        />,
        {
          createNodeMock: () => container,
        },
      )
      await Promise.resolve()
    })

    // Verify the paste capture-phase listener was registered
    const pasteEntries = listenerEntries.get('paste')
    const hasCaptureListener = pasteEntries?.some((e) => e.capture) ?? false
    expect(hasCaptureListener).toBe(true)

    act(() => {
      renderer.unmount()
    })

    // After unmount, the capture-phase paste listener should have been removed
    const pasteEntriesAfter = listenerEntries.get('paste')
    const hasCaptureListenerAfter = pasteEntriesAfter?.some((e) => e.capture) ?? false
    expect(hasCaptureListenerAfter).toBe(false)
  })
})
