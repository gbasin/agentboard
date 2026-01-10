import { useState, useCallback, useEffect, useRef } from 'react'
import type { Session } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useTerminal } from '../hooks/useTerminal'
import { useThemeStore, terminalThemes } from '../stores/themeStore'
import TerminalControls from './TerminalControls'

interface TerminalProps {
  session: Session | null
  sessions: Session[]
  connectionStatus: ConnectionStatus
  sendMessage: (message: any) => void
  subscribe: (listener: any) => () => void
  onClose: () => void
  onSelectSession: (sessionId: string) => void
  pendingApprovals: number
}

const statusText: Record<Session['status'], string> = {
  working: 'Working',
  needs_approval: 'Approval',
  waiting: 'Waiting',
  unknown: 'Unknown',
}

const statusClass: Record<Session['status'], string> = {
  working: 'text-working',
  needs_approval: 'text-approval',
  waiting: 'text-waiting',
  unknown: 'text-muted',
}

export default function Terminal({
  session,
  sessions,
  connectionStatus,
  sendMessage,
  subscribe,
  onClose,
  onSelectSession,
  pendingApprovals,
}: TerminalProps) {
  const theme = useThemeStore((state) => state.theme)
  const terminalTheme = terminalThemes[theme]
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminal-font-size')
    return saved ? parseInt(saved, 10) : 13
  })
  const lastTouchY = useRef<number | null>(null)
  const accumulatedDelta = useRef<number>(0)

  const adjustFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const newSize = Math.max(8, Math.min(24, prev + delta))
      localStorage.setItem('terminal-font-size', String(newSize))
      return newSize
    })
  }, [])

  const { containerRef, terminalRef } = useTerminal({
    sessionId: session?.id ?? null,
    sendMessage,
    subscribe,
    theme: terminalTheme,
    fontSize,
    onScrollChange: (isAtBottom) => {
      setShowScrollButton(!isAtBottom)
    },
  })

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom()
  }, [terminalRef])

  // Touch scroll - send mouse wheel escape sequences to tmux
  useEffect(() => {
    const container = containerRef.current
    if (!container || !session) return

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        lastTouchY.current = e.touches[0].clientY
        accumulatedDelta.current = 0
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || lastTouchY.current === null) return

      const y = e.touches[0].clientY
      const deltaY = lastTouchY.current - y
      lastTouchY.current = y

      accumulatedDelta.current += deltaY
      const threshold = 30 // pixels per scroll event
      const scrollEvents = Math.trunc(accumulatedDelta.current / threshold)

      if (scrollEvents !== 0) {
        // Send mouse wheel escape sequences (SGR mode)
        // Button 64 = scroll up (show older), Button 65 = scroll down (show newer)
        // Drag down (negative scrollEvents) = scroll up (older content)
        const button = scrollEvents < 0 ? 64 : 65
        const count = Math.abs(scrollEvents)

        // SGR mouse format: \x1b[<button;col;rowM
        // Use middle of terminal as coordinates
        const cols = terminalRef.current?.cols ?? 80
        const rows = terminalRef.current?.rows ?? 24
        const col = Math.floor(cols / 2)
        const row = Math.floor(rows / 2)

        for (let i = 0; i < count; i++) {
          sendMessage({
            type: 'terminal-input',
            sessionId: session.id,
            data: `\x1b[<${button};${col};${row}M`
          })
        }
        accumulatedDelta.current -= scrollEvents * threshold
      }
    }

    const handleTouchEnd = () => {
      lastTouchY.current = null
      accumulatedDelta.current = 0
    }

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: true })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
    }
  }, [session, sendMessage, containerRef, terminalRef])

  const handleSendKey = useCallback(
    (key: string) => {
      if (!session) return
      sendMessage({ type: 'terminal-input', sessionId: session.id, data: key })
    },
    [session, sendMessage]
  )

  const hasSession = Boolean(session)

  return (
    <section
      className={`flex flex-1 flex-col bg-base ${hasSession ? 'terminal-mobile-overlay md:relative md:inset-auto' : 'hidden md:flex'}`}
      data-testid="terminal-panel"
    >
      {/* Terminal header - only show when session selected */}
      {session && (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-elevated px-3">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="btn py-1 text-[11px] md:hidden"
            >
              Back
            </button>
            <span className="text-sm font-medium text-primary">
              {session.name}
            </span>
            <span className={`text-xs ${statusClass[session.status]}`}>
              {statusText[session.status]}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {pendingApprovals > 0 && (
              <span className="flex items-center gap-1.5 rounded bg-approval/20 px-2 py-0.5 text-xs font-medium text-approval md:hidden">
                {pendingApprovals} pending
              </span>
            )}
            {connectionStatus !== 'connected' && (
              <span className="text-xs text-approval">
                {connectionStatus}
              </span>
            )}
            {/* Font size controls - mobile only */}
            <div className="flex items-center gap-1 md:hidden">
              <button
                onClick={() => adjustFontSize(-1)}
                className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary active:bg-hover"
                title="Decrease font size"
              >
                <span className="text-sm font-bold">−</span>
              </button>
              <button
                onClick={() => adjustFontSize(1)}
                className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary active:bg-hover"
                title="Increase font size"
              >
                <span className="text-sm font-bold">+</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Terminal content - always rendered so ref is attached */}
      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {!session && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            Select a session to view terminal
          </div>
        )}

        {/* Scroll to bottom button */}
        {showScrollButton && session && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-surface border border-border shadow-lg hover:bg-hover transition-colors"
            title="Scroll to bottom"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-secondary"
            >
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Mobile control strip */}
      {session && (
        <TerminalControls
          onSendKey={handleSendKey}
          disabled={connectionStatus !== 'connected'}
          sessions={sessions.map(s => ({ id: s.id, name: s.name, status: s.status }))}
          currentSessionId={session.id}
          onSelectSession={onSelectSession}
        />
      )}
    </section>
  )
}
