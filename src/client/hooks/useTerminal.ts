import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebglAddon } from 'xterm-addon-webgl'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { ServerMessage } from '@shared/types'
import type { ITheme } from 'xterm'

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

    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      scrollback: 5000,
      cursorBlink: false,
      cursorStyle: 'underline',
      convertEol: true,
      theme,
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

    terminal.attachCustomKeyEventHandler((event) => {
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

    return () => {
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

  // Update font size
  useEffect(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (terminal && fitAddon) {
      terminal.options.fontSize = fontSize
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

      // Scroll to bottom after content loads
      if (scrollTimer.current) {
        window.clearTimeout(scrollTimer.current)
      }
      scrollTimer.current = window.setTimeout(() => {
        terminal.scrollToBottom()
        checkScrollPosition()
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
        terminal.write(message.data)
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
