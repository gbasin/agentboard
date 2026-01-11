import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebglAddon } from 'xterm-addon-webgl'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { ServerMessage } from '@shared/types'
import type { ITheme } from 'xterm'
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
  onScrollChange?: (isAtBottom: boolean) => void
}

export function useTerminal({
  sessionId,
  sendMessage,
  subscribe,
  theme,
  fontSize,
  onScrollChange,
}: UseTerminalOptions) {
  const isiOS = isIOSDevice()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  const resizeTimer = useRef<number | null>(null)
  const scrollTimer = useRef<number | null>(null)
  const fitTimer = useRef<number | null>(null)

  // Track the currently attached session to prevent race conditions
  const attachedSessionRef = useRef<string | null>(null)
  const sendMessageRef = useRef(sendMessage)
  const onScrollChangeRef = useRef(onScrollChange)

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
    terminal.loadAddon(new ClipboardAddon())

    try {
      const webglAddon = new WebglAddon()
      terminal.loadAddon(webglAddon)
      webglAddonRef.current = webglAddon
    } catch {
      // WebGL addon is optional
    }

    terminal.open(container)
    fitAddon.fit()

    // Handle paste events - listen on both terminal element and the hidden textarea
    const handlePaste = (e: Event) => {
      const clipboardEvent = e as ClipboardEvent
      const text = clipboardEvent.clipboardData?.getData('text')
      const attached = attachedSessionRef.current
      if (text && attached) {
        e.preventDefault()
        sendMessageRef.current({ type: 'terminal-input', sessionId: attached, data: text })
      }
      // Don't preventDefault for non-text (images, files) - let native behavior happen
    }
    terminal.element?.addEventListener('paste', handlePaste)
    // Also listen on the helper textarea where focus actually goes
    const textarea = terminal.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    textarea?.addEventListener('paste', handlePaste)

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
      terminal.element?.removeEventListener('paste', handlePaste)
      textarea?.removeEventListener('paste', handlePaste)
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

  // Subscribe to terminal output
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      const terminal = terminalRef.current
      const attachedSession = attachedSessionRef.current

      if (
        message.type === 'terminal-output' &&
        terminal &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        // Force text presentation for characters iOS renders as emoji
        terminal.write(forceTextPresentation(message.data))
        // Update scroll position after write
        checkScrollPosition()
      }
    })

    return unsubscribe
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

  return { containerRef, terminalRef }
}
