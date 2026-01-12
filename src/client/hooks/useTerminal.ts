import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon, type ClipboardSelectionType, type IClipboardProvider } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ProgressAddon } from '@xterm/addon-progress'
import type { ServerMessage } from '@shared/types'

// URL regex that matches standard URLs and IP:port patterns
const URL_REGEX = /https?:\/\/[^\s"'<>]+|\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}(?:\/[^\s"'<>]*)?\b/
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?]+$/
const BRACKET_PAIRS: Array<[string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]

const countOccurrences = (text: string, char: string) => text.split(char).length - 1

export function sanitizeLink(text: string): string {
  let result = text.trim()
  if (!result) return result

  const stripTrailingPunctuation = () => {
    result = result.replace(TRAILING_PUNCTUATION_REGEX, '')
  }

  stripTrailingPunctuation()

  let trimmed = true
  while (trimmed) {
    trimmed = false
    for (const [open, close] of BRACKET_PAIRS) {
      if (!result.endsWith(close)) continue
      const openCount = countOccurrences(result, open)
      const closeCount = countOccurrences(result, close)
      if (closeCount > openCount) {
        result = result.slice(0, -1)
        trimmed = true
      }
    }
  }

  stripTrailingPunctuation()
  return result
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

/**
 * Custom clipboard provider that prevents empty writes (matching Ghostty's behavior).
 * OSC 52 with empty base64 data clears clipboard in reference xterm, but this can
 * accidentally wipe images or other non-text content the user has copied.
 */
class SafeClipboardProvider implements IClipboardProvider {
  async readText(selection: ClipboardSelectionType): Promise<string> {
    if (selection !== 'c') return ''
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  }

  async writeText(selection: ClipboardSelectionType, text: string): Promise<void> {
    // Only write to system clipboard, and only if there's actual content
    if (selection !== 'c' || !text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard write failed (permissions, etc.)
    }
  }
}
import type { ITheme } from '@xterm/xterm'
import { isIOSDevice } from '../utils/device'

// Text presentation selector - forces text rendering instead of emoji
const TEXT_VS = '\uFE0E'

// Characters that iOS Safari renders as emoji but should be text
// Only add characters here that are verified to cause issues
const EMOJI_TO_TEXT_CHARS = new Set([
  '\u23FA', // ⏺ Black Circle for Record (Claude's bullet)
])

/**
 * Add text presentation selector after characters that iOS renders as emoji.
 * This forces the browser to render them as text glyphs instead.
 */
export function forceTextPresentation(data: string): string {
  let result = ''
  for (const char of data) {
    result += char
    if (EMOJI_TO_TEXT_CHARS.has(char)) {
      result += TEXT_VS
    }
  }
  return result
}

interface UseTerminalOptions {
  sessionId: string | null
  sendMessage: (message: any) => void
  subscribe: (listener: (message: ServerMessage) => void) => () => void
  theme: ITheme
  fontSize: number
  useWebGL: boolean
  onScrollChange?: (isAtBottom: boolean) => void
}

export function useTerminal({
  sessionId,
  sendMessage,
  subscribe,
  theme,
  fontSize,
  useWebGL,
  onScrollChange,
}: UseTerminalOptions) {
  const isiOS = isIOSDevice()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  const webLinksAddonRef = useRef<WebLinksAddon | null>(null)
  const linkTooltipRef = useRef<HTMLDivElement | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const progressAddonRef = useRef<ProgressAddon | null>(null)
  const resizeTimer = useRef<number | null>(null)
  const scrollTimer = useRef<number | null>(null)
  const fitTimer = useRef<number | null>(null)

  // Track the currently attached session to prevent race conditions
  const attachedSessionRef = useRef<string | null>(null)
  const sendMessageRef = useRef(sendMessage)
  const onScrollChangeRef = useRef(onScrollChange)
  const useWebGLRef = useRef(useWebGL)

  // Synchronized Output (DECSET 2026) - makes xterm.js render atomically
  // See: https://contour-terminal.org/vt-extensions/synchronized-output/
  const BSU = '\x1b[?2026h' // Begin Synchronized Update
  const ESU = '\x1b[?2026l' // End Synchronized Update

  // Output buffering with idle-based flushing + synchronized output
  const outputBufferRef = useRef<string>('')
  const idleTimerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)

  // Tuning: flush when idle for 2ms, or at most every 16ms
  const IDLE_FLUSH_MS = 2
  const MAX_FLUSH_MS = 16

  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  useEffect(() => {
    onScrollChangeRef.current = onScrollChange
  }, [onScrollChange])

  // Check if terminal is scrolled to bottom
  const checkScrollPosition = useCallback(() => {
    const terminal = terminalRef.current
    if (!terminal || !onScrollChangeRef.current) return

    const buffer = terminal.buffer.active
    const isAtBottom = buffer.viewportY >= buffer.baseY
    onScrollChangeRef.current(isAtBottom)
  }, [])

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return

    fitAddon.fit()

    const attached = attachedSessionRef.current
    if (attached) {
      sendMessageRef.current({
        type: 'terminal-resize',
        sessionId: attached,
        cols: terminal.cols,
        rows: terminal.rows,
      })
    }
  }, [])

  // Terminal initialization - only once on mount
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Already initialized
    if (terminalRef.current) return

    // Clear container
    container.innerHTML = ''

    // Calculate lineHeight that produces integer cell height for any fontSize
    // This keeps cell sizing stable across fractional line-height rendering
    const calcLineHeight = (size: number) => Math.round(size * 1.4) / size
    const computedLineHeight = calcLineHeight(fontSize)

    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
      fontSize,
      lineHeight: computedLineHeight,
      scrollback: 5000,
      cursorBlink: false,
      cursorStyle: 'underline',
      convertEol: true,
      theme,
      screenReaderMode: isiOS,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new ClipboardAddon(undefined, new SafeClipboardProvider()))

    // Load search addon for terminal buffer search
    const searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon

    // Load serialize addon for exporting terminal state
    const serializeAddon = new SerializeAddon()
    terminal.loadAddon(serializeAddon)
    serializeAddonRef.current = serializeAddon

    // Load progress addon for OSC 9;4 progress sequences
    const progressAddon = new ProgressAddon()
    terminal.loadAddon(progressAddon)
    progressAddonRef.current = progressAddon

    if (useWebGLRef.current) {
      try {
        const webglAddon = new WebglAddon()
        terminal.loadAddon(webglAddon)
        webglAddonRef.current = webglAddon
      } catch {
        // WebGL addon is optional
      }
    }

    terminal.open(container)
    fitAddon.fit()

    // Create tooltip element inside terminal (with xterm-hover class to prevent interference)
    // Guard for test environments where document.createElement may not be available
    let tooltip: HTMLDivElement | null = null
    let tooltipUrl: HTMLDivElement | null = null
    let tooltipHint: HTMLDivElement | null = null
    if (typeof document !== 'undefined' && document.createElement) {
      tooltip = document.createElement('div')
      tooltip.className = 'xterm-hover'
      tooltip.style.cssText = `
        position: absolute;
        display: none;
        z-index: 20;
        padding: 4px 8px;
        font-size: 12px;
        border-radius: 4px;
        background: var(--bg-surface);
        border: 1px solid var(--border);
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        color: var(--text-primary);
        pointer-events: none;
        max-width: 400px;
        word-break: break-all;
      `
      tooltipUrl = document.createElement('div')
      tooltip.appendChild(tooltipUrl)

      tooltipHint = document.createElement('div')
      tooltipHint.style.color = 'var(--text-muted)'
      tooltipHint.style.marginTop = '2px'
      tooltipHint.style.fontSize = '11px'
      tooltip.appendChild(tooltipHint)

      terminal.element?.appendChild(tooltip)
      linkTooltipRef.current = tooltip
    }

    const showTooltip = (event: MouseEvent, text: string) => {
      if (!terminal.element || !tooltip || !tooltipUrl || !tooltipHint) return
      const sanitized = sanitizeLink(text)
      if (!sanitized) return
      const rect = terminal.element.getBoundingClientRect()
      // Truncate long URLs
      const displayUrl = sanitized.length > 60 ? sanitized.slice(0, 57) + '...' : sanitized
      tooltipUrl.textContent = displayUrl
      tooltipHint.textContent = `${isMac ? '⌘' : 'Ctrl'}+click to open`
      tooltip.style.left = `${event.clientX - rect.left + 10}px`
      tooltip.style.top = `${event.clientY - rect.top + 10}px`
      tooltip.style.display = 'block'
    }

    const hideTooltip = () => {
      if (tooltip) tooltip.style.display = 'none'
    }

    // Link handler with hover/leave callbacks - used for both OSC 8 and WebLinksAddon
    const linkHandler = {
      activate: (event: MouseEvent, text: string) => {
        if (event.metaKey || event.ctrlKey) {
          const sanitized = sanitizeLink(text)
          if (!sanitized) return
          window.open(sanitized, '_blank', 'noopener')
        }
      },
      hover: (event: MouseEvent, text: string) => showTooltip(event, text),
      leave: () => hideTooltip(),
    }

    // Set linkHandler for OSC 8 hyperlinks
    terminal.options.linkHandler = linkHandler

    // WebLinksAddon for auto-detected URLs (pass linkHandler for hover/leave)
    const webLinksAddon = new WebLinksAddon(
      (event, uri) => linkHandler.activate(event, uri),
      {
        urlRegex: URL_REGEX,
        hover: (event, text) => linkHandler.hover(event, text),
        leave: () => linkHandler.leave(),
      }
    )
    terminal.loadAddon(webLinksAddon)
    webLinksAddonRef.current = webLinksAddon

    terminal.attachCustomKeyEventHandler((event) => {
      // Cmd/Ctrl+C: copy selection
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        if (terminal.hasSelection()) {
          const selection = terminal.getSelection()
          if (selection && navigator.clipboard) {
            void navigator.clipboard.writeText(selection)
          }
          return false
        }
      }

      // Ctrl+Backspace: delete word backward (browser eats this otherwise)
      if (event.ctrlKey && event.key === 'Backspace' && event.type === 'keydown') {
        const attached = attachedSessionRef.current
        if (attached) {
          sendMessageRef.current({ type: 'terminal-input', sessionId: attached, data: '\x17' })
        }
        return false
      }

      return true
    })

    // Handle input - only send to attached session
    terminal.onData((data) => {
      const attached = attachedSessionRef.current
      if (attached) {
        sendMessageRef.current({ type: 'terminal-input', sessionId: attached, data })
      }
    })

    // Track scroll position changes
    terminal.onScroll(() => {
      checkScrollPosition()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        fitAndResize()
      }).catch(() => {
        // Ignore font readiness errors
      })
    }

    // Desktop Safari + Retina: force refresh to fix blurry WebGL canvas
    const isSafariDesktop = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) && !isiOS
    if (isSafariDesktop && window.devicePixelRatio > 1) {
      setTimeout(() => {
        terminal.refresh(0, terminal.rows - 1)
      }, 100)
    }

    return () => {
      // Remove tooltip element
      if (linkTooltipRef.current) {
        linkTooltipRef.current.remove()
        linkTooltipRef.current = null
      }
      if (webLinksAddonRef.current) {
        try {
          webLinksAddonRef.current.dispose()
        } catch {
          // Ignore
        }
        webLinksAddonRef.current = null
      }
      if (webglAddonRef.current) {
        try {
          webglAddonRef.current.dispose()
        } catch {
          // Ignore
        }
        webglAddonRef.current = null
      }
      try {
        terminal.dispose()
      } catch {
        // Ignore
      }
      if (container) {
        container.innerHTML = ''
      }
      terminalRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
      serializeAddonRef.current = null
      progressAddonRef.current = null
      if (fitTimer.current) {
        window.clearTimeout(fitTimer.current)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitAndResize])

  // Update theme
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme
    }
  }, [theme])

  // Update font size (and lineHeight to maintain integer cell height)
  useEffect(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (terminal && fitAddon) {
      terminal.options.fontSize = fontSize
      // Recalculate lineHeight for integer cell height
      terminal.options.lineHeight = Math.round(fontSize * 1.4) / fontSize
      fitAddon.fit()
      // Notify server of new dimensions
      const attached = attachedSessionRef.current
      if (attached) {
        sendMessageRef.current({
          type: 'terminal-resize',
          sessionId: attached,
          cols: terminal.cols,
          rows: terminal.rows,
        })
      }
    }
  }, [fontSize])

  // Handle WebGL toggle at runtime
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    const wasEnabled = useWebGLRef.current
    useWebGLRef.current = useWebGL

    // Skip on first render (initialization handles it)
    if (wasEnabled === useWebGL) return

    if (useWebGL) {
      // Enable WebGL
      if (!webglAddonRef.current) {
        try {
          const webglAddon = new WebglAddon()
          terminal.loadAddon(webglAddon)
          webglAddonRef.current = webglAddon
        } catch {
          // WebGL addon is optional
        }
      }
    } else {
      // Disable WebGL - dispose addon to fall back to canvas
      if (webglAddonRef.current) {
        try {
          webglAddonRef.current.dispose()
        } catch {
          // Ignore disposal errors
        }
        webglAddonRef.current = null
      }
    }
  }, [useWebGL])

  // Handle session changes - attach/detach
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    const prevAttached = attachedSessionRef.current

    // Detach from previous session first
    if (prevAttached && prevAttached !== sessionId) {
      sendMessage({ type: 'terminal-detach', sessionId: prevAttached })
      attachedSessionRef.current = null
    }

    // Attach to new session
    if (sessionId && sessionId !== prevAttached) {
      // Reset terminal before attaching
      terminal.reset()
      // Send attach message
      sendMessage({ type: 'terminal-attach', sessionId })
      // Mark as attached
      attachedSessionRef.current = sessionId

      // Fit and resize after the session switch so tmux matches current viewport
      if (fitTimer.current) {
        window.clearTimeout(fitTimer.current)
      }
      fitTimer.current = window.setTimeout(() => {
        fitAndResize()
      }, 50)

      // Scroll to bottom and focus after content loads
      if (scrollTimer.current) {
        window.clearTimeout(scrollTimer.current)
      }
      scrollTimer.current = window.setTimeout(() => {
        terminal.scrollToBottom()
        checkScrollPosition()
        // Focus terminal so user can start typing immediately
        terminal.focus()
      }, 300)
    }

    // Handle deselection
    if (!sessionId && prevAttached) {
      attachedSessionRef.current = null
    }
  }, [sessionId, sendMessage, checkScrollPosition])

  // Subscribe to terminal output with idle-based buffering + synchronized output
  // This prevents flicker by: (1) batching output until stream goes idle,
  // (2) wrapping in BSU/ESU so xterm.js renders atomically
  useEffect(() => {
    const flush = () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      if (maxTimerRef.current !== null) {
        window.clearTimeout(maxTimerRef.current)
        maxTimerRef.current = null
      }

      const terminal = terminalRef.current
      const data = outputBufferRef.current
      if (!terminal || !data) return

      outputBufferRef.current = ''

      // Wrap in synchronized output sequences so xterm renders atomically
      terminal.write(BSU + data + ESU, () => {
        checkScrollPosition()
      })
    }

    const scheduleFlush = () => {
      // Reset idle timer on each new chunk
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
      }
      idleTimerRef.current = window.setTimeout(flush, IDLE_FLUSH_MS)

      // Start max timer if not already running
      if (maxTimerRef.current === null) {
        maxTimerRef.current = window.setTimeout(flush, MAX_FLUSH_MS)
      }
    }

    const unsubscribe = subscribe((message) => {
      const attachedSession = attachedSessionRef.current

      if (
        message.type === 'terminal-output' &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        outputBufferRef.current += forceTextPresentation(message.data)
        scheduleFlush()
      }
    })

    return () => {
      unsubscribe()
      // Flush any remaining buffer on cleanup
      flush()
    }
  }, [subscribe, checkScrollPosition])

  // Handle resize - with longer debounce to prevent flickering
  useEffect(() => {
    const container = containerRef.current
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current

    if (!container || !terminal || !fitAddon) return

    const handleResize = () => {
      if (resizeTimer.current) {
        window.clearTimeout(resizeTimer.current)
      }

      // Longer debounce to prevent rapid resize events
      resizeTimer.current = window.setTimeout(() => {
        fitAndResize()
      }, 150)
    }

    const observer = new ResizeObserver(handleResize)
    observer.observe(container)

    // Initial fit
    handleResize()

    return () => {
      observer.disconnect()
      if (resizeTimer.current) {
        window.clearTimeout(resizeTimer.current)
      }
    }
  }, [])

  return {
    containerRef,
    terminalRef,
    searchAddonRef,
    serializeAddonRef,
    progressAddonRef,
  }
}
