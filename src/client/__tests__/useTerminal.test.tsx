import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
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

  open(_container: HTMLElement) {
    // Create a mock element with event listener tracking
    const listeners = new Map<string, { handler: EventListener; capture: boolean }[]>()
    this.element = {
      appendChild: () => {},
      addEventListener: (type: string, handler: EventListener, options?: boolean | AddEventListenerOptions) => {
        const capture = typeof options === 'boolean' ? options : options?.capture ?? false
        if (!listeners.has(type)) listeners.set(type, [])
        listeners.get(type)!.push({ handler, capture })
      },
      removeEventListener: (type: string, handler: EventListener, options?: boolean | AddEventListenerOptions) => {
        const capture = typeof options === 'boolean' ? options : options?.capture ?? false
        const list = listeners.get(type)
        if (list) {
          const idx = list.findIndex(l => l.handler === handler && l.capture === capture)
          if (idx >= 0) list.splice(idx, 1)
        }
      },
      getEventListeners: (type: string) => listeners.get(type) ?? [],
      dispatchEvent: (event: Event) => {
        const list = listeners.get(event.type)
        if (list) {
          for (const { handler } of list) {
            handler(event)
          }
        }
        return true
      },
    } as unknown as HTMLElement
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
class WebLinksAddonMock {
  static instances: WebLinksAddonMock[] = []
  activateHandler?: (event: MouseEvent, uri: string) => void
  hoverHandler?: (event: MouseEvent, text: string) => void
  leaveHandler?: () => void

  constructor(
    handler: (event: MouseEvent, uri: string) => void,
    options?: { hover?: (event: MouseEvent, text: string) => void; leave?: () => void }
  ) {
    this.activateHandler = handler
    this.hoverHandler = options?.hover
    this.leaveHandler = options?.leave
    WebLinksAddonMock.instances.push(this)
  }

  dispose() {}
}
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: WebLinksAddonMock }))

const { forceTextPresentation, sanitizeLink, useTerminal } = await import('../hooks/useTerminal')

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

  const listeners = new Map<string, EventListener>()
  const container = {
    innerHTML: 'existing',
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

  return { container, textarea, listeners }
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
  WebLinksAddonMock.instances = []

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

  test('pointerdown handler prevents propagation when hovering link with cmd/ctrl', async () => {
    const openCalls: string[] = []
    globalAny.window = {
      ...globalAny.window,
      open: (url: string) => {
        openCalls.push(url)
        return null
      },
    } as unknown as Window & typeof globalThis

    globalAny.navigator = {
      userAgent: 'Safari',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      clipboard: { writeText: () => Promise.resolve() },
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
        {
          createNodeMock: () => container,
        }
      )
      await Promise.resolve()
    })

    const terminal = TerminalMock.instances[0]
    const webLinksAddon = WebLinksAddonMock.instances[0]
    if (!terminal || !webLinksAddon) {
      throw new Error('Expected terminal and webLinksAddon instances')
    }

    const element = terminal.element as unknown as {
      getEventListeners: (type: string) => Array<{ handler: EventListener; capture: boolean }>
      dispatchEvent: (event: Event) => boolean
    }

    // Verify pointerdown handler is attached in capture phase
    const pointerdownListeners = element.getEventListeners('pointerdown')
    expect(pointerdownListeners.length).toBe(1)
    expect(pointerdownListeners[0].capture).toBe(true)

    // Simulate hovering over a link
    webLinksAddon.hoverHandler?.({ clientX: 100, clientY: 100 } as MouseEvent, 'https://example.com')

    // Create a pointerdown event with metaKey (cmd on Mac)
    let preventDefaultCalled = false
    let stopPropagationCalled = false
    const pointerEvent = {
      type: 'pointerdown',
      metaKey: true,
      ctrlKey: false,
      preventDefault: () => { preventDefaultCalled = true },
      stopPropagation: () => { stopPropagationCalled = true },
    } as unknown as PointerEvent

    element.dispatchEvent(pointerEvent)

    expect(preventDefaultCalled).toBe(true)
    expect(stopPropagationCalled).toBe(true)
    // Link should be opened on pointerdown
    expect(openCalls).toEqual(['https://example.com'])

    // The click event's activate handler should be skipped (linkOpenedOnPointerDown flag)
    webLinksAddon.activateHandler?.({ metaKey: true, ctrlKey: false } as MouseEvent, 'https://example.com')
    // Should still be just one open call (no double-open)
    expect(openCalls).toEqual(['https://example.com'])

    // Test that leaving the link resets the hover state
    webLinksAddon.leaveHandler?.()

    // Now pointerdown with cmd should NOT prevent (not hovering anymore)
    preventDefaultCalled = false
    stopPropagationCalled = false
    element.dispatchEvent(pointerEvent)

    expect(preventDefaultCalled).toBe(false)
    expect(stopPropagationCalled).toBe(false)

    act(() => {
      renderer.unmount()
    })

    // Verify handler is removed on cleanup
    const remainingListeners = element.getEventListeners('pointerdown')
    expect(remainingListeners.length).toBe(0)
  })
})
