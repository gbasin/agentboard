import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon, type ClipboardSelectionType, type IClipboardProvider } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ProgressAddon } from '@xterm/addon-progress'
import type { SendClientMessage, SubscribeServerMessage } from '@shared/types'

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
    // Only write to system clipboard, and only if there's actual non-whitespace content
    // This prevents OSC 52 sequences from clearing images/rich content from the clipboard
    if (selection !== 'c' || !text?.trim()) return
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
  tmuxTarget: string | null
  sendMessage: SendClientMessage
  subscribe: SubscribeServerMessage
  theme: ITheme
  fontSize: number
  lineHeight: number
  letterSpacing: number
  fontFamily: string
  useWebGL: boolean
  onScrollChange?: (isAtBottom: boolean) => void
}

export function useTerminal({
  sessionId,
  tmuxTarget,
  sendMessage,
  subscribe,
  theme,
  fontSize,
  lineHeight,
  letterSpacing,
  fontFamily,
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

  // Wheel event handling for tmux scrollback
  const wheelAccumRef = useRef<number>(0)
  const inTmuxCopyModeRef = useRef<boolean>(false)
  const copyModeCheckTimer = useRef<number | null>(null)

  // Track the currently attached session to prevent race conditions
  const attachedSessionRef = useRef<string | null>(null)
  const attachedTargetRef = useRef<string | null>(null)
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
    const isAtBottom = !inTmuxCopyModeRef.current && buffer.viewportY >= buffer.baseY
    onScrollChangeRef.current(isAtBottom)
  }, [])

  const setTmuxCopyMode = useCallback((nextValue: boolean) => {
    if (inTmuxCopyModeRef.current === nextValue) return
    inTmuxCopyModeRef.current = nextValue
    checkScrollPosition()
  }, [checkScrollPosition])

  // Request tmux copy-mode status from server (debounced)
  const requestCopyModeCheck = useCallback(() => {
    const attached = attachedSessionRef.current
    if (!attached) return

    // Debounce: clear existing timer and set a new one
    if (copyModeCheckTimer.current !== null) {
      window.clearTimeout(copyModeCheckTimer.current)
    }
    copyModeCheckTimer.current = window.setTimeout(() => {
      copyModeCheckTimer.current = null
      sendMessageRef.current({ type: 'tmux-check-copy-mode', sessionId: attached })
    }, 150) // Check 150ms after last scroll
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

    // Track if effect has been cleaned up (for async font loading)
    let cancelled = false

    // Clear container
    container.innerHTML = ''

    // Calculate lineHeight that produces integer cell height for any fontSize
    // This keeps cell sizing stable across fractional line-height rendering
    const calcLineHeight = (size: number, lh: number) => Math.round(size * lh) / size
    const computedLineHeight = calcLineHeight(fontSize, lineHeight)

    const terminal = new Terminal({
      fontFamily,
      fontSize,
      lineHeight: computedLineHeight,
      letterSpacing,
      scrollback: 0, // Disabled - we use tmux scrollback instead
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

    // Function to complete terminal initialization after fonts are ready
    // This ensures the WebGL renderer builds its texture atlas with correct font metrics
    const openTerminal = () => {
      if (cancelled) return

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

      // Append tooltip after terminal.open() sets terminal.element
      if (tooltip && terminal.element) {
        terminal.element.appendChild(tooltip)
      }
    }

    // Wait for fonts to be ready before opening terminal to ensure WebGL
    // texture atlas is built with correct glyph metrics for all font weights
    if (document.fonts?.ready) {
      document.fonts.ready.then(openTerminal).catch(openTerminal)
    } else {
      // Fallback for environments without document.fonts
      openTerminal()
    }

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

    // Track the currently hovered link URL so we can open it on mousedown
    // before xterm.js sends mouse sequences to tmux that exit copy-mode
    let hoveredLinkUrl: string | null = null
    let linkOpenedOnMouseDown = false
    let linkOpenedResetTimer: ReturnType<typeof setTimeout> | null = null

    // Link handler with hover/leave callbacks - used for both OSC 8 and WebLinksAddon
    const linkHandler = {
      activate: (event: MouseEvent, text: string) => {
        // Skip if already opened by mousedown handler (prevents double-open)
        if (linkOpenedOnMouseDown) return
        // Fallback for cases where mousedown didn't intercept
        if (event.metaKey || event.ctrlKey) {
          const sanitized = sanitizeLink(text)
          if (!sanitized) return
          window.open(sanitized, '_blank', 'noopener')
        }
      },
      hover: (event: MouseEvent, text: string) => {
        const sanitized = sanitizeLink(text)
        hoveredLinkUrl = sanitized || null
        showTooltip(event, text)
      },
      leave: () => {
        hoveredLinkUrl = null
        hideTooltip()
      },
    }

    // Open links on mousedown instead of click to beat the race condition where
    // xterm.js sends mouse sequences to tmux (exiting copy-mode) before the
    // link addon's click handler fires
    const handleLinkMouseDown = (e: MouseEvent) => {
      if (hoveredLinkUrl && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.stopPropagation()
        linkOpenedOnMouseDown = true
        window.open(hoveredLinkUrl, '_blank', 'noopener')
        // Reset flag after a short delay (in case click event still fires)
        if (linkOpenedResetTimer) clearTimeout(linkOpenedResetTimer)
        linkOpenedResetTimer = setTimeout(() => { linkOpenedOnMouseDown = false }, 100)
      }
    }
    container.addEventListener('mousedown', handleLinkMouseDown, true)

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
      // Cmd/Ctrl+C: copy selection (only non-whitespace to avoid clearing images from clipboard)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        if (terminal.hasSelection()) {
          const selection = terminal.getSelection()
          if (selection?.trim() && navigator.clipboard) {
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
        // When in copy-mode, filter out mouse sequences so clicks don't exit copy-mode
        // This prevents accidental copy-mode exit when clicking in scrollback (Safari desktop)
        // Mouse sequence formats:
        // - SGR extended: ESC [ < Ps ; Ps ; Ps M/m (most common with tmux)
        // - URXVT: ESC [ Ps ; Ps ; Ps M
        // - Normal/UTF-8: ESC [ M followed by exactly 3 encoded bytes
        // eslint-disable-next-line no-control-regex
        const isMouseSequence = /^\x1b\[(<[\d;]+[Mm]|[\d;]+M|M[\x20-\xff]{3})$/.test(data)
        if (inTmuxCopyModeRef.current && isMouseSequence) {
          return // Drop mouse event, let xterm handle selection locally
        }

        // If we scrolled in tmux copy-mode, exit it before sending keyboard input
        if (inTmuxCopyModeRef.current) {
          sendMessageRef.current({ type: 'tmux-cancel-copy-mode', sessionId: attached })
          setTmuxCopyMode(false)
        }
        sendMessageRef.current({ type: 'terminal-input', sessionId: attached, data })
      }
    })

    // Forward wheel events to tmux for scrollback (like Blink terminal)
    // This enters tmux copy-mode instead of using xterm.js local scrollback
    terminal.attachCustomWheelEventHandler((ev) => {
      const attached = attachedSessionRef.current
      if (!attached) return true // Let xterm handle it

      // Don't intercept wheel over HTML inputs (like Claude Code's text box)
      const target = ev.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"], .xterm-hover')) {
        return true
      }

      // If user has active selection, let them scroll to extend it
      if (terminal.hasSelection()) return true

      // Shift+scroll = horizontal scroll intent, let browser handle
      if (ev.shiftKey) return true

      // Accumulate wheel delta to avoid spamming on trackpads
      const STEP = 30
      wheelAccumRef.current += ev.deltaY

      // Get approximate cell position for SGR mouse event
      const cols = terminal.cols
      const rows = terminal.rows
      const col = Math.floor(cols / 2)
      const row = Math.floor(rows / 2)

      let scrolledUp = false
      let didScroll = false
      while (Math.abs(wheelAccumRef.current) >= STEP) {
        didScroll = true
        const down = wheelAccumRef.current > 0
        wheelAccumRef.current += down ? -STEP : STEP

        // SGR mouse wheel: button 64 = scroll up, 65 = scroll down
        const button = down ? 65 : 64
        if (!down) scrolledUp = true
        sendMessageRef.current({
          type: 'terminal-input',
          sessionId: attached,
          data: `\x1b[<${button};${col};${row}M`
        })
      }

      // Optimistically show button when scrolling up
      if (scrolledUp) {
        setTmuxCopyMode(true)
      }
      // Request actual copy-mode status from tmux (debounced) - only if we sent scroll
      if (didScroll) {
        requestCopyModeCheck()
      }
      return false // We handled it, prevent xterm local scroll
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Desktop Safari + Retina: force refresh to fix blurry WebGL canvas
    const isSafariDesktop = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) && !isiOS
    if (isSafariDesktop && window.devicePixelRatio > 1) {
      setTimeout(() => {
        terminal.refresh(0, terminal.rows - 1)
      }, 100)
    }

    return () => {
      // Cancel any pending async operations (font loading)
      cancelled = true
      // Clean up link handling state
      if (linkOpenedResetTimer) clearTimeout(linkOpenedResetTimer)
      hoveredLinkUrl = null
      // Remove link mousedown handler
      container.removeEventListener('mousedown', handleLinkMouseDown, true)
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
      if (copyModeCheckTimer.current !== null) {
        window.clearTimeout(copyModeCheckTimer.current)
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

  // Update font size, lineHeight, letterSpacing, and fontFamily (maintaining integer cell height)
  useEffect(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (terminal && fitAddon) {
      terminal.options.fontFamily = fontFamily
      terminal.options.fontSize = fontSize
      // Recalculate lineHeight for integer cell height
      terminal.options.lineHeight = Math.round(fontSize * lineHeight) / fontSize
      terminal.options.letterSpacing = letterSpacing
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
  }, [fontSize, lineHeight, letterSpacing, fontFamily])

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
    const prevTarget = attachedTargetRef.current

    // Detach from previous session first
    if (prevAttached && prevAttached !== sessionId) {
      sendMessage({ type: 'terminal-detach', sessionId: prevAttached })
      attachedSessionRef.current = null
      attachedTargetRef.current = null
      // Reset copy-mode state - each session has its own scroll position
      inTmuxCopyModeRef.current = false
    }

    // Attach to new session
    if (sessionId && (sessionId !== prevAttached || tmuxTarget !== prevTarget)) {
      // Reset terminal before attaching
      terminal.reset()

      // Fit terminal first to get accurate dimensions
      const fitAddon = fitAddonRef.current
      if (fitAddon) {
        fitAddon.fit()
      }

      // Send attach message with current dimensions so server spawns at correct size
      sendMessage({
        type: 'terminal-attach',
        sessionId,
        tmuxTarget: tmuxTarget ?? undefined,
        cols: terminal.cols,
        rows: terminal.rows,
      })
      // Mark as attached
      attachedSessionRef.current = sessionId
      attachedTargetRef.current = tmuxTarget ?? null

      // Check if this session is already in copy-mode (scrolled back)
      sendMessage({ type: 'tmux-check-copy-mode', sessionId })

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
      attachedTargetRef.current = null
    }
  }, [sessionId, tmuxTarget, sendMessage, checkScrollPosition])

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

      // Handle tmux copy-mode status response
      if (
        message.type === 'tmux-copy-mode-status' &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        setTmuxCopyMode(message.inCopyMode)
      }
    })

    return () => {
      unsubscribe()
      // Flush any remaining buffer on cleanup
      flush()
    }
  }, [subscribe, checkScrollPosition, setTmuxCopyMode])

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
    inTmuxCopyModeRef,
    setTmuxCopyMode,
  }
}
