import { useState, useCallback, useEffect, useRef } from 'react'
import type { Session } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useTerminal } from '../hooks/useTerminal'
import { useThemeStore, terminalThemes } from '../stores/themeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { isIOSDevice, getEffectiveModifier, getModifierDisplay } from '../utils/device'
import TerminalControls from './TerminalControls'
import SessionDrawer from './SessionDrawer'
import { PlusIcon, XCloseIcon, DotsVerticalIcon, Menu01Icon } from '@untitledui-icons/react/line'

interface TerminalProps {
  session: Session | null
  sessions: Session[]
  connectionStatus: ConnectionStatus
  sendMessage: (message: any) => void
  subscribe: (listener: any) => () => void
  onClose: () => void
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onKillSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, newName: string) => void
  onOpenSettings: () => void
  loading?: boolean
  error?: string | null
}

const statusText: Record<Session['status'], string> = {
  working: 'Working',
  waiting: 'Waiting',
  permission: 'Needs Input',
  unknown: 'Unknown',
}

const statusClass: Record<Session['status'], string> = {
  working: 'text-working',
  waiting: 'text-waiting',
  permission: 'text-approval',
  unknown: 'text-muted',
}

const statusButtonBase: Record<Session['status'], string> = {
  working: 'bg-working/25 text-working',
  waiting: 'bg-waiting/25 text-waiting',
  permission: 'bg-approval/25 text-approval',
  unknown: 'bg-muted/25 text-muted',
}

const statusButtonActive: Record<Session['status'], string> = {
  working: 'bg-working text-white',
  waiting: 'bg-waiting text-white',
  permission: 'bg-approval text-white',
  unknown: 'bg-muted text-white',
}

function triggerHaptic() {
  if ('vibrate' in navigator) {
    navigator.vibrate(10)
  }
}

export default function Terminal({
  session,
  sessions,
  connectionStatus,
  sendMessage,
  subscribe,
  onClose: _onClose,
  onSelectSession,
  onNewSession,
  onKillSession,
  onRenameSession,
  onOpenSettings,
  loading = false,
  error = null,
}: TerminalProps) {
  void _onClose // Keep for interface compatibility
  const theme = useThemeStore((state) => state.theme)
  const toggleTheme = useThemeStore((state) => state.toggleTheme)
  const terminalTheme = terminalThemes[theme]
  const useWebGL = useSettingsStore((state) => state.useWebGL)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))
  const isiOS = isIOSDevice()
  const [isMobileLayout, setIsMobileLayout] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(max-width: 767px)').matches
  })
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [isSelectingText, setIsSelectingText] = useState(false)
  const [showEndConfirm, setShowEndConfirm] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const endSessionButtonRef = useRef<HTMLButtonElement>(null)
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminal-font-size')
    return saved ? parseInt(saved, 10) : 13
  })
  const lastTouchY = useRef<number | null>(null)
  const accumulatedDelta = useRef<number>(0)

  const adjustFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const newSize = Math.max(6, Math.min(24, prev + delta))
      localStorage.setItem('terminal-font-size', String(newSize))
      return newSize
    })
  }, [])

  const { containerRef, terminalRef } = useTerminal({
    sessionId: session?.id ?? null,
    tmuxTarget: session?.tmuxWindow ?? null,
    sendMessage,
    subscribe,
    theme: terminalTheme,
    fontSize,
    useWebGL,
    onScrollChange: (isAtBottom) => {
      setShowScrollButton(!isAtBottom)
    },
  })

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom()
  }, [terminalRef])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mediaQuery = window.matchMedia('(max-width: 767px)')
    const handleChange = () => setIsMobileLayout(mediaQuery.matches)
    handleChange()
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }
    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [])

  useEffect(() => {
    if (!isMobileLayout && isDrawerOpen) {
      setIsDrawerOpen(false)
    }
  }, [isDrawerOpen, isMobileLayout])

  // Swipe from left edge to open drawer
  useEffect(() => {
    if (!isMobileLayout) return

    const EDGE_THRESHOLD = 30 // pixels from left edge to start
    const SWIPE_DISTANCE = 50 // min horizontal swipe distance
    const SWIPE_RATIO = 1.5 // horizontal distance must be > vertical * ratio

    let touchStartX = 0
    let touchStartY = 0
    let isEdgeSwipe = false

    const handleTouchStart = (e: TouchEvent) => {
      if (isDrawerOpen) return
      const touch = e.touches[0]
      // Only start tracking if touch begins near left edge
      if (touch.clientX <= EDGE_THRESHOLD) {
        touchStartX = touch.clientX
        touchStartY = touch.clientY
        isEdgeSwipe = true
      } else {
        isEdgeSwipe = false
      }
    }

    const handleTouchEnd = (e: TouchEvent) => {
      if (!isEdgeSwipe || isDrawerOpen) return

      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - touchStartX
      const deltaY = Math.abs(touch.clientY - touchStartY)

      // Check if swipe was primarily horizontal and far enough
      if (deltaX >= SWIPE_DISTANCE && deltaX > deltaY * SWIPE_RATIO) {
        setIsDrawerOpen(true)
        triggerHaptic()
      }

      isEdgeSwipe = false
    }

    document.addEventListener('touchstart', handleTouchStart, { passive: true })
    document.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isMobileLayout, isDrawerOpen])

  // Close more menu when clicking outside
  useEffect(() => {
    if (!showMoreMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showMoreMenu])

  // Focus rename input when renaming
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  // Focus kill session button when confirm modal opens
  useEffect(() => {
    if (showEndConfirm && endSessionButtonRef.current) {
      endSessionButtonRef.current.focus()
    }
  }, [showEndConfirm])

  const handleEndSession = () => {
    if (!session) return
    onKillSession(session.id)
    setShowEndConfirm(false)
  }

  const handleStartRename = () => {
    if (!session) return
    setRenameValue(session.name)
    setIsRenaming(true)
    setShowMoreMenu(false)
  }

  const handleRenameSubmit = () => {
    if (!session) return
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== session.name) {
      onRenameSession(session.id, trimmed)
    }
    setIsRenaming(false)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleRenameSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setIsRenaming(false)
    }
  }

  useEffect(() => {
    if (!isiOS || !session || !isMobileLayout) {
      setIsSelectingText(false)
      return
    }

    const container = containerRef.current
    if (!container) return

    const isSelectionInside = (sel: Selection) => {
      const a11yTree = container.querySelector('.xterm-accessibility-tree')
      if (!a11yTree) return false
      const anchor = sel.anchorNode
      const focus = sel.focusNode
      return (!!anchor && a11yTree.contains(anchor)) || (!!focus && a11yTree.contains(focus))
    }

    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) {
        // Only update if currently true to avoid unnecessary re-renders
        setIsSelectingText((prev) => prev ? false : prev)
        return
      }
      const newValue = isSelectionInside(sel) && !sel.isCollapsed
      // Only update if value changed
      setIsSelectingText((prev) => prev !== newValue ? newValue : prev)
    }

    const onCopy = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return
      if (!isSelectionInside(sel)) return

      setTimeout(() => {
        try {
          sel.removeAllRanges()
        } catch {
          // Ignore selection cleanup errors
        }
      }, 0)
    }

    const onTouchEnd = (event: TouchEvent) => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setIsSelectingText(false)
        return
      }

      const a11yTree = container.querySelector('.xterm-accessibility-tree')
      if (!a11yTree) return

      if (!isSelectionInside(sel)) {
        setIsSelectingText(false)
        return
      }

      const target = event.target as Node | null
      const targetInTree = target ? a11yTree.contains(target) : false

      let targetInSelection = false
      if (targetInTree && target) {
        try {
          targetInSelection = sel.containsNode(target, true)
        } catch {
          targetInSelection = false
        }
      }

      if (!targetInTree || !targetInSelection) {
        setTimeout(() => {
          try {
            sel.removeAllRanges()
          } catch {
            // Ignore selection cleanup errors
          }
          setIsSelectingText(false)
        }, 0)
      }
    }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('copy', onCopy)
    document.addEventListener('touchend', onTouchEnd, { passive: true })

    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('touchend', onTouchEnd)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- use session?.id to avoid re-running on session data changes
  }, [containerRef, isiOS, isMobileLayout, session?.id])

  useEffect(() => {
    if (!isiOS) return
    const container = containerRef.current
    if (!container) return

    const updateA11yMetrics = () => {
      const row = container.querySelector('.xterm-accessibility-tree > div') as HTMLElement | null
      if (row) {
        const rowHeight = row.getBoundingClientRect().height
        if (rowHeight) {
          container.style.setProperty('--xterm-cell-height', `${rowHeight}px`)
          container.style.setProperty('--xterm-a11y-offset', `${Math.round(rowHeight / 2)}px`)
        }
      }

      const xterm = container.querySelector('.xterm') as HTMLElement | null
      const computedFontSize = xterm ? window.getComputedStyle(xterm).fontSize : `${fontSize}px`
      if (computedFontSize) {
        container.style.setProperty('--xterm-font-size', computedFontSize)
      }
    }

    updateA11yMetrics()
    const rafId = window.requestAnimationFrame(updateA11yMetrics)
    const retryId = window.setTimeout(updateA11yMetrics, 100)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(retryId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- use session?.id to avoid re-running on session data changes
  }, [containerRef, fontSize, isiOS, session?.id])

  // Track isSelectingText in a ref to avoid re-running effect
  const isSelectingTextRef = useRef(isSelectingText)
  useEffect(() => {
    isSelectingTextRef.current = isSelectingText
  }, [isSelectingText])

  // Track session ID in a ref for use in handlers without causing effect re-runs
  const sessionIdRef = useRef(session?.id)
  useEffect(() => {
    sessionIdRef.current = session?.id
  }, [session?.id])

  // Track sendMessage in a ref to avoid effect re-runs
  const sendMessageRef = useRef(sendMessage)
  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  // Touch scroll with native long-press selection
  // Single tap focuses terminal for keyboard input
  useEffect(() => {
    const container = containerRef.current
    if (!container || !session?.id) return

    // Check if mobile
    if (!isMobileLayout) return
    const TAP_MOVE_THRESHOLD = 10 // pixels - if moved more, it's not a tap

    let touchStartPos = { x: 0, y: 0 }
    let hasMoved = false

    // Get textarea and keep it disabled to prevent auto-focus
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (textarea) {
      textarea.setAttribute('disabled', 'true')
    }

    const focusTerminalInput = () => {
      // Enable and focus - don't re-disable on blur to prevent keyboard dismissal
      // The textarea will be re-disabled when session changes (effect cleanup)
      if (textarea) {
        textarea.removeAttribute('disabled')
        textarea.focus()
      }
    }

    const resetTouchState = () => {
      lastTouchY.current = null
      accumulatedDelta.current = 0
    }

    const hasActiveSelection = () => {
      if (!isiOS) return false
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return false
      const a11yTree = container.querySelector('.xterm-accessibility-tree')
      if (!a11yTree) return false
      const anchor = selection.anchorNode
      const focus = selection.focusNode
      return (!!anchor && a11yTree.contains(anchor)) || (!!focus && a11yTree.contains(focus))
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (isSelectingTextRef.current) {
        resetTouchState()
        return
      }

      if (e.touches.length === 1) {
        touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        hasMoved = false
        lastTouchY.current = e.touches[0].clientY
        accumulatedDelta.current = 0

        // Enable textarea on touch start so iOS long-press paste menu works
        if (textarea) {
          textarea.removeAttribute('disabled')
        }
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (isSelectingTextRef.current) {
        resetTouchState()
        return
      }

      if (e.touches.length !== 1 || lastTouchY.current === null) return

      const x = e.touches[0].clientX
      const y = e.touches[0].clientY

      // Check if moved beyond tap threshold
      const dx = Math.abs(x - touchStartPos.x)
      const dy = Math.abs(y - touchStartPos.y)
      if (dx > TAP_MOVE_THRESHOLD || dy > TAP_MOVE_THRESHOLD) {
        hasMoved = true
      }

      const deltaY = lastTouchY.current - y
      lastTouchY.current = y

      accumulatedDelta.current += deltaY
      const threshold = 30 // pixels per scroll event
      const scrollEvents = Math.trunc(accumulatedDelta.current / threshold)

      if (scrollEvents !== 0) {
        // Send mouse wheel escape sequences (SGR mode)
        const button = scrollEvents < 0 ? 64 : 65
        const count = Math.abs(scrollEvents)
        const cols = terminalRef.current?.cols ?? 80
        const rows = terminalRef.current?.rows ?? 24
        const col = Math.floor(cols / 2)
        const row = Math.floor(rows / 2)

        for (let i = 0; i < count; i++) {
          const currentSessionId = sessionIdRef.current
          if (currentSessionId) {
            sendMessageRef.current({
              type: 'terminal-input',
              sessionId: currentSessionId,
              data: `\x1b[<${button};${col};${row}M`
            })
          }
        }
        accumulatedDelta.current -= scrollEvents * threshold
      }
    }

    const handleTouchEnd = () => {
      resetTouchState()

      if (isSelectingTextRef.current || hasActiveSelection()) return

      // Only count as tap if didn't move much
      if (hasMoved) return

      // Single tap - focus terminal for keyboard input
      focusTerminalInput()
    }

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: true })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
      // Re-enable textarea on cleanup
      if (textarea) {
        textarea.removeAttribute('disabled')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- use session?.id and refs to avoid re-running on unrelated changes
  }, [session?.id, containerRef, terminalRef, isiOS, isMobileLayout])

  const handleSendKey = useCallback(
    (key: string) => {
      if (!session) return
      sendMessage({ type: 'terminal-input', sessionId: session.id, data: key })
    },
    [session, sendMessage]
  )

  const handleRefocus = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (textarea) {
      textarea.removeAttribute('disabled')
      textarea.focus()
    }
  }, [containerRef])

  const isKeyboardVisible = useCallback(() => {
    const container = containerRef.current
    if (!container) return false
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    return textarea ? document.activeElement === textarea : false
  }, [containerRef])

  return (
    <section
      className={`flex flex-1 flex-col bg-base terminal-mobile-overlay md:relative md:inset-auto ${isiOS ? 'ios-native-term-selection' : ''}`}
      data-testid="terminal-panel"
    >
      {/* Mobile header - always show on mobile for drawer access */}
      <div className={`flex h-10 shrink-0 items-center justify-between border-b border-border bg-elevated px-3 ${session ? '' : 'md:hidden'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setIsDrawerOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all md:hidden shrink-0"
            aria-label="Open session menu"
          >
            <Menu01Icon width={16} height={16} />
          </button>
          {session ? (
            <>
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={handleRenameKeyDown}
                  className="w-full max-w-[200px] rounded border border-border bg-surface px-2 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
                />
              ) : (
                <span className="text-sm font-medium text-primary truncate">
                  {session.name}
                </span>
              )}
              <span className={`text-xs shrink-0 ${statusClass[session.status]}`}>
                {statusText[session.status]}
              </span>
            </>
          ) : (
            <span className="text-sm font-medium text-primary md:hidden">
              Sessions
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {connectionStatus !== 'connected' && (
            <span className="text-xs text-approval">
              {connectionStatus}
            </span>
          )}

          {/* New session button - mobile only (desktop has it in header) */}
          <button
            onClick={onNewSession}
            className="flex h-7 w-7 items-center justify-center rounded bg-accent text-white hover:bg-accent/90 active:scale-95 transition-all md:hidden"
            title={`New session (${modDisplay}N)`}
            aria-label="New session"
          >
            <PlusIcon width={16} height={16} />
          </button>

          {/* Kill session button - only for managed sessions */}
          {session?.source === 'managed' && (
            <button
              onClick={() => setShowEndConfirm(true)}
              className="flex h-7 w-7 items-center justify-center rounded bg-danger/10 border border-danger/30 text-danger hover:bg-danger/20 active:scale-95 transition-all"
              title={`Kill session (${modDisplay}X)`}
              aria-label="Kill session"
            >
              <XCloseIcon width={16} height={16} />
            </button>
          )}

          {/* More menu - only show when session selected */}
          {session && (
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setShowMoreMenu(!showMoreMenu)}
                className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all"
                title="More options"
                aria-label="More options"
              >
                <DotsVerticalIcon width={16} height={16} />
              </button>

              {showMoreMenu && (
                <div className="absolute right-0 top-full mt-1 z-20 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1">
                  <button
                    onClick={handleStartRename}
                    className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
                  >
                    Rename
                  </button>
                  <div className="border-t border-border my-1" />
                  <div className="px-3 py-2">
                    <div className="text-xs text-muted mb-2">Font Size</div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => adjustFontSize(-1)}
                        className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover"
                      >
                        <span className="text-sm font-bold">−</span>
                      </button>
                      <span className="text-sm text-secondary w-6 text-center">{fontSize}</span>
                      <button
                        onClick={() => adjustFontSize(1)}
                        className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover"
                      >
                        <span className="text-sm font-bold">+</span>
                      </button>
                    </div>
                  </div>
                  <div className="border-t border-border my-1" />
                  <button
                    onClick={() => {
                      toggleTheme()
                      setShowMoreMenu(false)
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
                  >
                    {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                  </button>
                  <button
                    onClick={() => {
                      onOpenSettings()
                      setShowMoreMenu(false)
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
                  >
                    Settings
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mobile session switcher - top of terminal */}
      {session && sessions.length > 1 && (
        <div className="relative bg-elevated border-b border-border md:hidden">
          {/* Left fade indicator */}
          <div className="absolute left-0 top-0 bottom-0 w-4 bg-gradient-to-r from-elevated to-transparent z-10 pointer-events-none" />
          {/* Right fade indicator */}
          <div className="absolute right-0 top-0 bottom-0 w-4 bg-gradient-to-l from-elevated to-transparent z-10 pointer-events-none" />
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto scrollbar-none scroll-smooth snap-x snap-mandatory"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            {sessions.map((s, index) => {
              const isActive = s.id === session.id
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`
                    flex items-center justify-center shrink-0 snap-start
                    h-8 w-8 text-sm font-bold rounded-lg
                    active:scale-95 transition-all duration-75
                    select-none touch-manipulation
                    ${isActive ? statusButtonActive[s.status] : statusButtonBase[s.status]}
                  `}
                  onClick={() => {
                    triggerHaptic()
                    onSelectSession(s.id)
                  }}
                >
                  {index + 1}
                </button>
              )
            })}
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
        {showScrollButton && session && !isSelectingText && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-surface border border-border shadow-lg hover:bg-hover transition-colors"
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
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
          hideSessionSwitcher
          onRefocus={handleRefocus}
          isKeyboardVisible={isKeyboardVisible}
        />
      )}

      {/* Mobile session drawer */}
      {isMobileLayout && (
        <SessionDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          sessions={sessions}
          selectedSessionId={session?.id ?? null}
          onSelect={onSelectSession}
          onRename={onRenameSession}
          onNewSession={onNewSession}
          loading={loading}
          error={error}
        />
      )}

      {/* Kill session confirmation modal */}
      {showEndConfirm && session && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-lg border border-border bg-elevated p-4 shadow-xl">
            <h3 className="text-base font-medium text-primary mb-2 text-balance">
              Kill Session
            </h3>
            <p className="text-sm text-secondary mb-4 text-pretty">
              Kill "{session.name}"? The process will be terminated. Conversation history is preserved in logs.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowEndConfirm(false)}
                className="btn py-1.5 px-3 text-sm"
              >
                Cancel
              </button>
              <button
                ref={endSessionButtonRef}
                onClick={handleEndSession}
                className="btn btn-danger py-1.5 px-3 text-sm"
              >
                Kill Session
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
