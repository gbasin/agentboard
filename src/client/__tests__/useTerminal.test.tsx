import { afterEach, beforeEach, describe, expect, jest, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ServerMessage } from '@shared/types'
import type { ITheme } from '@xterm/xterm'

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

  refresh() {}

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

  const container = {
    innerHTML: 'existing',
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

  return { container, textarea, listeners, listenerEntries, dispatchEvent }
}

function TerminalHarness(props: {
  sessionId: string | null
  tmuxTarget?: string | null
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
  } as unknown as Window & typeof globalThis

  // Mock requestAnimationFrame to execute callback synchronously
  globalAny.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }
  globalAny.cancelAnimationFrame = () => {}

  globalAny.document = {
    fonts: { ready: Promise.resolve() },
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
    expect(terminal.writes).toEqual([`\x1b[?2026hx\u23FA\uFE0Ey\x1b[?2026l`])

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
    // Should have called terminal.paste('') for the empty bracket paste signal
    expect(terminal.pasteCalls).toEqual([''])

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
