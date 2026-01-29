import { useState, useCallback, useEffect, useRef } from 'react'
import type { AgentSession, Session, SendClientMessage, SubscribeServerMessage } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useTerminal } from '../hooks/useTerminal'
import { useIsMobileLayout } from '../hooks/useMobileLayout'
import { useOnClickOutside } from '../hooks/useOnClickOutside'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { useEdgeSwipeToOpenDrawer } from '../hooks/useEdgeSwipeToOpenDrawer'
import { useThemeStore, terminalThemes } from '../stores/themeStore'
import { useSettingsStore, getFontFamily } from '../stores/settingsStore'
import { isIOSDevice, getEffectiveModifier, getModifierDisplay } from '../utils/device'
import TerminalControls from './TerminalControls'
import SessionDrawer from './SessionDrawer'
import { PlusIcon, XCloseIcon, DotsVerticalIcon, Menu01Icon } from '@untitledui-icons/react/line'
import Edit05Icon from '@untitledui-icons/react/line/esm/Edit05Icon'
import Settings01Icon from '@untitledui-icons/react/line/esm/Settings01Icon'

interface TerminalProps {
  session: Session | null
  sessions: Session[]
  inactiveSessions?: AgentSession[]
  connectionStatus: ConnectionStatus
  sendMessage: SendClientMessage
  subscribe: SubscribeServerMessage
  onClose: () => void
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onKillSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, newName: string) => void
  onResumeSession: (sessionId: string) => void
  onSetPinned?: (sessionId: string, isPinned: boolean) => void
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
  inactiveSessions = [],
  connectionStatus,
  sendMessage,
  subscribe,
  onClose: _onClose,
  onSelectSession,
  onNewSession,
  onKillSession,
  onRenameSession,
  onResumeSession,
  onSetPinned,
  onOpenSettings,
  loading = false,
  error = null,
}: TerminalProps) {
  void _onClose // Keep for interface compatibility
  const theme = useThemeStore((state) => state.theme)
  const terminalTheme = terminalThemes[theme]
  const useWebGL = useSettingsStore((state) => state.useWebGL)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const lineHeight = useSettingsStore((state) => state.lineHeight)
  const letterSpacing = useSettingsStore((state) => state.letterSpacing)
  const fontOption = useSettingsStore((state) => state.fontOption)
  const customFontFamily = useSettingsStore((state) => state.customFontFamily)
  const fontFamily = getFontFamily(fontOption, customFontFamily)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))
  const isiOS = isIOSDevice()
  const isMobileLayout = useIsMobileLayout()
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [isSelectingText, setIsSelectingText] = useState(false)
  const [showEndConfirm, setShowEndConfirm] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const lastSelectionInsideRef = useRef(false)
  const clearIOSSelectionRef = useRef<(() => void) | null>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const endSessionButtonRef = useRef<HTMLButtonElement>(null)

  const { containerRef, terminalRef, inTmuxCopyModeRef, setTmuxCopyMode } = useTerminal({
    sessionId: session?.id ?? null,
    tmuxTarget: session?.tmuxWindow ?? null,
    sendMessage,
    subscribe,
    theme: terminalTheme,
    fontSize,
    lineHeight,
    letterSpacing,
    fontFamily,
    useWebGL,
    onScrollChange: (isAtBottom) => {
      setShowScrollButton(!isAtBottom)
    },
  })

  const scrollToBottom = useCallback(() => {
    // Exit tmux copy-mode to return to live output (oracle recommendation)
    if (!session) return
    sendMessage({ type: 'tmux-cancel-copy-mode', sessionId: session.id })
    setTmuxCopyMode(false)
    terminalRef.current?.scrollToBottom()
  }, [session, sendMessage, setTmuxCopyMode, terminalRef])

  // Edge swipe to open drawer
  const handleOpenDrawer = useCallback(() => {
    setIsDrawerOpen(true)
    triggerHaptic()
  }, [])
  const isEdgeSwipingRef = useEdgeSwipeToOpenDrawer({
    enabled: isMobileLayout || isiOS,
    isOpen: isDrawerOpen,
    onOpen: handleOpenDrawer,
  })

  // Close drawer when switching to desktop layout
  useEffect(() => {
    if (!isMobileLayout && !isiOS && isDrawerOpen) {
      setIsDrawerOpen(false)
    }
  }, [isDrawerOpen, isMobileLayout, isiOS])

  // Close more menu when clicking outside
  const handleCloseMoreMenu = useCallback(() => setShowMoreMenu(false), [])
  useOnClickOutside(moreMenuRef, showMoreMenu, handleCloseMoreMenu)

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

  // Handle Escape key to close confirm modal
  const handleCloseConfirm = useCallback(() => setShowEndConfirm(false), [])
  useEscapeToClose(showEndConfirm, handleCloseConfirm)

  const handleEndSession = () => {
    if (!session) return
    onKillSession(session.id)
    setShowEndConfirm(false)
  }

  const handleStartRename = () => {
    if (!session) return
    setRenameValue(session.agentSessionName || session.name)
    setIsRenaming(true)
    setShowMoreMenu(false)
  }

  const handleRenameSubmit = () => {
    if (!session) return
    const trimmed = renameValue.trim()
    const displayName = session.agentSessionName || session.name
    if (trimmed && trimmed !== displayName) {
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
    if (!isiOS || !session) {
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

    const forceA11yRepaint = () => {
      const a11yRoot = container.querySelector('.xterm-accessibility') as HTMLElement | null
      const a11yTree = container.querySelector('.xterm-accessibility-tree') as HTMLElement | null
      if (!a11yRoot || !a11yTree) return

      a11yRoot.style.setProperty('opacity', '0')
      a11yTree.style.setProperty('opacity', '0')
      a11yRoot.style.setProperty('-webkit-user-select', 'none')
      a11yRoot.style.setProperty('user-select', 'none')
      a11yTree.style.setProperty('-webkit-user-select', 'none')
      a11yTree.style.setProperty('user-select', 'none')
      void a11yRoot.offsetHeight // Force reflow

      requestAnimationFrame(() => {
        a11yRoot.style.removeProperty('opacity')
        a11yTree.style.removeProperty('opacity')
        a11yRoot.style.removeProperty('-webkit-user-select')
        a11yRoot.style.removeProperty('user-select')
        a11yTree.style.removeProperty('-webkit-user-select')
        a11yTree.style.removeProperty('user-select')
      })
    }

    // Hard-clear iOS selection by removing ranges and forcing a11y repaint
    const clearIOSSelection = () => {
      lastSelectionInsideRef.current = false
      const sel = window.getSelection()
      try { sel?.removeAllRanges() } catch {}
      terminalRef.current?.clearSelection()
      forceA11yRepaint()
      setIsSelectingText(false)
    }

    clearIOSSelectionRef.current = clearIOSSelection

    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        if (lastSelectionInsideRef.current) {
          clearIOSSelection()
        } else {
          // Only update if currently true to avoid unnecessary re-renders
          setIsSelectingText((prev) => prev ? false : prev)
        }
        return
      }

      const selectionInside = isSelectionInside(sel)
      if (!selectionInside && lastSelectionInsideRef.current) {
        clearIOSSelection()
        return
      }

      lastSelectionInsideRef.current = selectionInside
      const newValue = selectionInside
      // Only update if value changed
      setIsSelectingText((prev) => prev !== newValue ? newValue : prev)
    }

    const onCopy = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return
      if (!isSelectionInside(sel)) return

      setTimeout(clearIOSSelection, 0)
    }

    // Track touch movement to distinguish taps from drags
    const TAP_MOVE_THRESHOLD = 10
    let selectionTouchStart: { x: number; y: number } | null = null
    let selectionTouchMoved = false

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        const touch = event.touches[0]
        selectionTouchStart = { x: touch.clientX, y: touch.clientY }
        selectionTouchMoved = false
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (selectionTouchMoved || !selectionTouchStart || event.touches.length !== 1) return
      const touch = event.touches[0]
      const dx = Math.abs(touch.clientX - selectionTouchStart.x)
      const dy = Math.abs(touch.clientY - selectionTouchStart.y)
      if (dx > TAP_MOVE_THRESHOLD || dy > TAP_MOVE_THRESHOLD) {
        selectionTouchMoved = true
      }
    }

    const onTouchEnd = (event: TouchEvent) => {
      const wasDrag = selectionTouchMoved
      selectionTouchStart = null
      selectionTouchMoved = false

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

      // If user was dragging (extending selection), don't clear - they're still selecting
      if (wasDrag) {
        return
      }

      // Only clear on taps outside the selection (to dismiss it)
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
        setTimeout(clearIOSSelection, 0)
      }
    }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('copy', onCopy)
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })

    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      clearIOSSelectionRef.current = null
      lastSelectionInsideRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- use session?.id to avoid re-running on session data changes
  }, [containerRef, isiOS, session?.id])

  useEffect(() => {
    if (!isiOS) return
    const container = containerRef.current
    if (!container) return

    const syncA11yOverlay = () => {
      const terminal = terminalRef.current
      const root = container.querySelector('.xterm') as HTMLElement | null
      if (!terminal || !root) return

      const screen = root.querySelector('.xterm-screen') as HTMLElement | null
      const a11yRoot = root.querySelector('.xterm-accessibility') as HTMLElement | null
      const a11yTree = root.querySelector('.xterm-accessibility-tree') as HTMLElement | null
      if (!screen || !a11yRoot || !a11yTree) return

      // 1) Position a11y overlay to match the screen rect (handles padding without transforms)
      const rootRect = root.getBoundingClientRect()
      const screenRect = screen.getBoundingClientRect()

      const left = screenRect.left - rootRect.left
      const top = screenRect.top - rootRect.top

      Object.assign(a11yRoot.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${screenRect.width}px`,
        height: `${screenRect.height}px`,
      })

      // 2) Compute canvas grid cell size
      const cellW = screenRect.width / terminal.cols
      const cellH = screenRect.height / terminal.rows

      // 3) Measure DOM character width inside the a11y tree context
      const probe = document.createElement('span')
      probe.textContent = '0'.repeat(200)
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none;letter-spacing:0px'
      a11yTree.appendChild(probe)
      const domCharW = probe.getBoundingClientRect().width / 200
      probe.remove()

      // 4) Compute letter-spacing so DOM advances match the canvas grid
      const letterSpacing = Math.max(-2, Math.min(2, cellW - domCharW))

      container.style.setProperty('--xterm-font-size', `${terminal.options.fontSize}px`)
      container.style.setProperty('--xterm-cell-height', `${cellH}px`)
      container.style.setProperty('--xterm-a11y-letter-spacing', `${letterSpacing}px`)
    }

    syncA11yOverlay()
    const rafId = window.requestAnimationFrame(syncA11yOverlay)
    const retryId = window.setTimeout(syncA11yOverlay, 100)

    // Re-sync on resize/orientation changes
    const scheduleSync = () => window.requestAnimationFrame(syncA11yOverlay)
    window.visualViewport?.addEventListener('resize', scheduleSync)
    window.addEventListener('orientationchange', scheduleSync)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(retryId)
      window.visualViewport?.removeEventListener('resize', scheduleSync)
      window.removeEventListener('orientationchange', scheduleSync)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- use session?.id to avoid re-running on session data changes
  }, [containerRef, fontSize, isiOS, session?.id, terminalRef])

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

  // Flag to swallow next mouse event (after iOS selection dismissal)
  const swallowNextMouseRef = useRef(false)

  // Touch scroll with native long-press selection
  // Single tap focuses terminal for keyboard input
  useEffect(() => {
    const container = containerRef.current
    if (!container || !session?.id) return

    // Check if mobile or iOS (iOS needs touch scroll even in landscape where width > 767px)
    if (!isMobileLayout && !isiOS) return
    const TAP_MOVE_THRESHOLD = 6 // pixels - allows small jitter without canceling taps
    const LONG_PRESS_MS = 350

    let touchStartPos = { x: 0, y: 0 }
    let touchStartTime = 0
    let hasMoved = false
    let lastTouchY: number | null = null
    let lastTouchTime = 0
    let velocity = 0
    let accumulatedDelta = 0
    let lineHeightPx = Math.round(fontSize * lineHeight)
    let momentumAnimationId: number | null = null

    const resolveLineHeight = () => {
      const computed = window.getComputedStyle(container)
      const cssValue = computed.getPropertyValue('--xterm-cell-height').trim()
      const parsed = Number.parseFloat(cssValue)
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed
      }
      return Math.round(fontSize * lineHeight)
    }

    const getTextarea = () =>
      container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null

    const disableTextareaIfIdle = () => {
      const current = getTextarea()
      if (!current) return
      if (document.activeElement !== current) {
        current.disabled = true
      }
    }

    const enableTextarea = () => {
      const current = getTextarea()
      if (!current) return
      current.disabled = false
    }

    // Keep textarea disabled to prevent auto-focus, but don't break active input sessions.
    disableTextareaIfIdle()

    const focusTerminalInput = () => {
      // Don't focus if in tmux copy-mode (scrolled back) - user should use scroll-to-bottom button
      if (inTmuxCopyModeRef.current) {
        return
      }

      // Enable and focus - don't re-disable on blur to prevent keyboard dismissal
      // The textarea will be re-disabled when session changes (effect cleanup)
      const current = getTextarea()
      if (!current) return
      current.disabled = false
      current.focus()
    }

    const stopMomentum = () => {
      if (momentumAnimationId !== null) {
        cancelAnimationFrame(momentumAnimationId)
        momentumAnimationId = null
      }
      velocity = 0
    }

    // Send scroll events to tmux as SGR mouse sequences (like desktop wheel handler)
    // Returns true if scrolled up (into history), false otherwise
    const sendScrollToTmux = (lines: number): boolean => {
      const currentSessionId = sessionIdRef.current
      if (!currentSessionId || lines === 0) return false

      const terminal = terminalRef.current
      const cols = terminal?.cols ?? 80
      const rows = terminal?.rows ?? 24
      const col = Math.floor(cols / 2)
      const row = Math.floor(rows / 2)

      // SGR mouse wheel: button 64 = scroll up, 65 = scroll down
      const button = lines > 0 ? 65 : 64
      const count = Math.abs(lines)
      const scrolledUp = lines < 0

      for (let i = 0; i < count; i++) {
        sendMessageRef.current({
          type: 'terminal-input',
          sessionId: currentSessionId,
          data: `\x1b[<${button};${col};${row}M`
        })
      }

      // Only enter copy-mode when scrolling UP (into history), not when scrolling down
      if (scrolledUp) {
        setTmuxCopyMode(true)
      }

      return scrolledUp
    }

    const resetTouchState = () => {
      lastTouchY = null
      velocity = 0
      accumulatedDelta = 0
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

    const maybeClearStaleSelection = () => {
      if (!isiOS || !lastSelectionInsideRef.current) return
      if (!hasActiveSelection()) {
        clearIOSSelectionRef.current?.()
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      stopMomentum()
      maybeClearStaleSelection()

      // Skip if edge swiping (opening drawer) or drawer is open
      if (isEdgeSwipingRef.current || isDrawerOpen) {
        resetTouchState()
        return
      }

      if (isSelectingTextRef.current) {
        resetTouchState()
        return
      }

      if (e.touches.length === 1) {
        const touch = e.touches[0]
        touchStartPos = { x: touch.clientX, y: touch.clientY }
        touchStartTime = performance.now()
        hasMoved = false
        lastTouchY = touch.clientY
        lastTouchTime = touchStartTime
        velocity = 0
        accumulatedDelta = 0
        lineHeightPx = resolveLineHeight()

        // Enable textarea on touch start so iOS long-press paste menu works
        enableTextarea()
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || lastTouchY === null) return
      maybeClearStaleSelection()

      // Skip if edge swiping (opening drawer) or drawer is open
      if (isEdgeSwipingRef.current || isDrawerOpen) {
        resetTouchState()
        return
      }

      if (isSelectingTextRef.current || hasActiveSelection()) {
        resetTouchState()
        return
      }

      e.preventDefault()
      e.stopPropagation()

      const now = performance.now()
      const touch = e.touches[0]
      const x = touch.clientX
      const y = touch.clientY

      const dx = Math.abs(x - touchStartPos.x)
      const dy = Math.abs(y - touchStartPos.y)
      if (!hasMoved && (dx > TAP_MOVE_THRESHOLD || dy > TAP_MOVE_THRESHOLD)) {
        hasMoved = true
        disableTextareaIfIdle()
      }

      const deltaY = lastTouchY - y
      const deltaTime = now - lastTouchTime
      lastTouchY = y
      lastTouchTime = now

      if (deltaTime > 0) {
        const instantVelocity = deltaY / deltaTime
        velocity = velocity * 0.7 + instantVelocity * 0.3
      }

      accumulatedDelta += deltaY
      const threshold = Math.max(6, lineHeightPx * 0.6)
      const scrollEvents = Math.trunc(accumulatedDelta / threshold)
      if (scrollEvents !== 0) {
        sendScrollToTmux(scrollEvents)
        accumulatedDelta -= scrollEvents * threshold
      }
    }

    const handleTouchEnd = (e: TouchEvent) => {
      const endVelocity = velocity
      const touchDuration = performance.now() - touchStartTime
      resetTouchState()

      // Skip if edge swiping (opening drawer) or drawer is open - let document handler process
      if (isEdgeSwipingRef.current || isDrawerOpen) {
        return
      }

      const activeSelection = hasActiveSelection()
      if (isSelectingTextRef.current && !activeSelection) {
        clearIOSSelectionRef.current?.()
      }

      // If selecting text, let iOS handle the tap naturally to dismiss selection
      // Don't preventDefault - that breaks iOS selection dismissal
      // We'll swallow the synthetic mouse event instead to protect tmux
      if (isSelectingTextRef.current || activeSelection) {
        if (inTmuxCopyModeRef.current) {
          swallowNextMouseRef.current = true
        }
        return
      }

      if (!hasMoved) {
        if (isiOS && touchDuration >= LONG_PRESS_MS) return
        // If in copy-mode, prevent tap from reaching xterm.js (which would send click to tmux and exit copy-mode)
        if (inTmuxCopyModeRef.current) {
          e.preventDefault()
          e.stopPropagation()
          swallowNextMouseRef.current = true
          return
        }
        focusTerminalInput()
        return
      }

      const minVelocity = 0.12 // pixels per ms
      if (Math.abs(endVelocity) > minVelocity) {
        let currentVelocity = endVelocity
        let lastFrameTime = performance.now()

        const animateMomentum = () => {
          const now = performance.now()
          const deltaTime = now - lastFrameTime
          lastFrameTime = now

          const distance = currentVelocity * deltaTime
          accumulatedDelta += distance
          const threshold = Math.max(6, lineHeightPx * 0.6)
          const scrollEvents = Math.trunc(accumulatedDelta / threshold)
          if (scrollEvents !== 0) {
            sendScrollToTmux(scrollEvents)
            accumulatedDelta -= scrollEvents * threshold
          }

          currentVelocity *= Math.pow(0.95, deltaTime / 16.67)

          if (Math.abs(currentVelocity) > 0.02) {
            momentumAnimationId = requestAnimationFrame(animateMomentum)
          } else {
            momentumAnimationId = null
          }
        }

        momentumAnimationId = requestAnimationFrame(animateMomentum)
      }
    }

    // Swallow synthetic mouse events after iOS selection dismissal to protect tmux
    const handleMouseDown = (e: MouseEvent) => {
      if (swallowNextMouseRef.current) {
        e.preventDefault()
        e.stopPropagation()
        swallowNextMouseRef.current = false
      }
    }

    const startOptions: AddEventListenerOptions = { passive: true, capture: true }
    const moveOptions: AddEventListenerOptions = { passive: false, capture: true }
    const endOptions: AddEventListenerOptions = { passive: false, capture: true } // Need passive: false to preventDefault in copy-mode
    const mouseOptions: AddEventListenerOptions = { capture: true }
    container.addEventListener('touchstart', handleTouchStart, startOptions)
    container.addEventListener('touchmove', handleTouchMove, moveOptions)
    container.addEventListener('touchend', handleTouchEnd, endOptions)
    container.addEventListener('mousedown', handleMouseDown, mouseOptions)

    return () => {
      container.removeEventListener('touchstart', handleTouchStart, startOptions)
      container.removeEventListener('touchmove', handleTouchMove, moveOptions)
      container.removeEventListener('touchend', handleTouchEnd, endOptions)
      container.removeEventListener('mousedown', handleMouseDown, mouseOptions)
      // Re-enable textarea on cleanup
      const cleanupTextarea = getTextarea()
      if (cleanupTextarea) {
        cleanupTextarea.disabled = false
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- use session?.id and refs to avoid re-running on unrelated changes
  }, [session?.id, containerRef, terminalRef, isiOS, isMobileLayout, isDrawerOpen, fontSize, lineHeight])

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

  // Enter text mode: exit copy-mode and focus input (for keyboard button)
  const handleEnterTextMode = useCallback(() => {
    if (session && inTmuxCopyModeRef.current) {
      sendMessage({ type: 'tmux-cancel-copy-mode', sessionId: session.id })
      setTmuxCopyMode(false)
    }
    const container = containerRef.current
    if (!container) return
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (textarea) {
      textarea.removeAttribute('disabled')
      textarea.focus()
    }
  }, [session, sendMessage, containerRef, inTmuxCopyModeRef, setTmuxCopyMode])

  const isKeyboardVisible = useCallback(() => {
    if (typeof document === 'undefined') return false
    const container = containerRef.current
    if (!container) return false
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (textarea && document.activeElement === textarea) {
      return true
    }

    const activeElement = document.activeElement
    const inputActive =
      typeof HTMLInputElement !== 'undefined' && activeElement instanceof HTMLInputElement
    const textareaActive =
      typeof HTMLTextAreaElement !== 'undefined' && activeElement instanceof HTMLTextAreaElement
    if (inputActive || textareaActive) {
      return false
    }
    if (activeElement && (activeElement as HTMLElement).isContentEditable) {
      return false
    }

    return !!document.documentElement?.classList?.contains('keyboard-visible')
  }, [containerRef])

  useEffect(() => {
    if (!isiOS) return
    const container = containerRef.current
    if (!container) return

    const a11yRoot = container.querySelector('.xterm-accessibility') as HTMLElement | null
    const a11yTree = container.querySelector('.xterm-accessibility-tree') as HTMLElement | null
    if (!a11yRoot || !a11yTree) return

    const updatePointerEvents = () => {
      const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
      const keyboardVisible = textarea ? document.activeElement === textarea : false
      if (keyboardVisible && !isSelectingTextRef.current) {
        a11yRoot.style.pointerEvents = 'none'
        a11yTree.style.pointerEvents = 'none'
      } else {
        a11yRoot.style.removeProperty('pointer-events')
        a11yTree.style.removeProperty('pointer-events')
      }
    }

    updatePointerEvents()

    document.addEventListener('focusin', updatePointerEvents)
    document.addEventListener('focusout', updatePointerEvents)
    return () => {
      document.removeEventListener('focusin', updatePointerEvents)
      document.removeEventListener('focusout', updatePointerEvents)
    }
  }, [containerRef, isiOS, isSelectingText])

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
          {/* Kill session button - desktop only, left of session name */}
          {session && (
            <button
              onClick={() => setShowEndConfirm(true)}
              className="hidden md:flex h-7 w-7 items-center justify-center rounded bg-danger/10 border border-danger/30 text-danger hover:bg-danger/20 active:scale-95 transition-all shrink-0"
              title={`Kill session (${modDisplay}X)`}
              aria-label="Kill session"
            >
              <XCloseIcon width={16} height={16} />
            </button>
          )}
          {session ? (
            <div className="flex items-baseline gap-3 min-w-0">
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
                  {session.agentSessionName || session.name}
                </span>
              )}
              <span className={`text-xs shrink-0 ${statusClass[session.status]}`}>
                {statusText[session.status]}
              </span>
            </div>
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

          {/* Kill session button - mobile only (desktop has it on left) */}
          {session && (
            <button
              onClick={() => setShowEndConfirm(true)}
              className="flex md:hidden h-7 w-7 items-center justify-center rounded bg-danger/10 border border-danger/30 text-danger hover:bg-danger/20 active:scale-95 transition-all"
              title={`Kill session (${modDisplay}X)`}
              aria-label="Kill session"
            >
              <XCloseIcon width={16} height={16} />
            </button>
          )}

          {/* More menu - mobile only (desktop has settings in sidebar header) */}
          {session && (
            <div className="relative md:hidden" ref={moreMenuRef}>
              <button
                onClick={() => setShowMoreMenu(!showMoreMenu)}
                className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all"
                title="More options"
                aria-label="More options"
              >
                <DotsVerticalIcon width={16} height={16} />
              </button>

              {showMoreMenu && (
                <div className="absolute right-0 top-full mt-1 z-20 min-w-[140px] rounded-md border border-border bg-elevated shadow-lg py-1">
                  <button
                    onClick={handleStartRename}
                    className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
                  >
                    <Edit05Icon width={14} height={14} />
                    Rename
                  </button>
                  <button
                    onClick={() => {
                      onOpenSettings()
                      setShowMoreMenu(false)
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
                  >
                    <Settings01Icon width={14} height={14} />
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
        <div className="relative overflow-hidden bg-elevated border-b border-border md:hidden">
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
            className="absolute bottom-8 left-1/2 z-20 flex h-10 px-4 items-center justify-center gap-1.5 rounded-full bg-blue-600/90 text-white shadow-lg hover:bg-blue-600 active:scale-95 transition-all"
            style={{ transform: 'translateX(-50%)' }}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
            <span className="text-sm font-medium">Jump to bottom</span>
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
          onEnterTextMode={handleEnterTextMode}
        />
      )}

      {/* Mobile session drawer */}
      {(isMobileLayout || isiOS) && (
        <SessionDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          sessions={sessions}
          inactiveSessions={inactiveSessions}
          selectedSessionId={session?.id ?? null}
          onSelect={onSelectSession}
          onRename={onRenameSession}
          onResume={onResumeSession}
          onSetPinned={onSetPinned}
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
              Kill "{session.agentSessionName || session.name}"? The process will be terminated. Conversation history is preserved in logs.
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
