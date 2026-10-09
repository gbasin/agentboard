/**
 * SessionDrawer - Mobile slide-out drawer for session list
 * Slides in from left side, covers ~75% of screen width
 * Close by: tap backdrop, press Escape, or swipe left
 * Footer holds New Session and, when wired, the Session recovery entry point
 * (the mobile counterpart of the desktop sidebar's clock button).
 */

import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'motion/react'
import type {
  AgentSession,
  Session,
  SubscribeServerMessage,
} from '@shared/types'
import SessionList from './SessionList'
import { RecoveryNotice } from './history/RecoveryNotice'
import { ClockRewindIcon } from './icons'
import { ICON_SIZE, mobileButtonClass } from './controlStyles'

interface SessionDrawerProps {
  isOpen: boolean
  onClose: () => void
  sessions: Session[]
  hibernatingSessions?: AgentSession[]
  historySessions?: AgentSession[]
  selectedSessionId: string | null
  selectedHibernatingSessionId?: string | null
  onSelect: (sessionId: string) => void
  onSelectHibernating?: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onResume?: (sessionId: string) => void
  onHibernate?: (sessionId: string) => void
  onMoveToHistory?: (sessionId: string) => void
  onNewSession: () => boolean | void
  /** Opens the Session recovery panel; adds the footer button and notice. */
  onOpenHistory?: () => void
  /** Lets the recovery notice refresh on library-changed events. */
  subscribe?: SubscribeServerMessage
  loading: boolean
  error: string | null
}

export default function SessionDrawer({
  isOpen,
  onClose,
  sessions,
  hibernatingSessions = [],
  historySessions = [],
  selectedSessionId,
  selectedHibernatingSessionId = null,
  onSelect,
  onSelectHibernating,
  onRename,
  onResume,
  onHibernate,
  onMoveToHistory,
  onNewSession,
  onOpenHistory,
  subscribe,
  loading,
  error,
}: SessionDrawerProps) {
  const prefersReducedMotion = useReducedMotion()
  const drawerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Lock body scroll while the drawer is open (vaul-style): fixing body
  // position prevents iOS Safari from scrolling/rubber-banding the page
  // behind the drawer; scrollY is restored on close.
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return
    const { body } = document
    const scrollY = window.scrollY
    const prev = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    return () => {
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.width = prev.width
      window.scrollTo(0, scrollY)
    }
  }, [isOpen])

  // Handle Escape key to close
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  // Focus management - focus drawer when open, return focus when closed
  useEffect(() => {
    if (isOpen) {
      // Store current focus
      previousFocusRef.current = document.activeElement as HTMLElement
      // Focus the drawer
      drawerRef.current?.focus({ preventScroll: true })
    } else if (previousFocusRef.current) {
      // Return focus to previous element
      previousFocusRef.current.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [isOpen])

  // Swipe left to close drawer
  useEffect(() => {
    if (!isOpen) return

    const drawer = drawerRef.current
    if (!drawer) return

    const SWIPE_DISTANCE = 50 // min horizontal swipe distance
    const SWIPE_RATIO = 1.5 // horizontal distance must be > vertical * ratio

    let touchStartX = 0
    let touchStartY = 0

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0]
      touchStartX = touch.clientX
      touchStartY = touch.clientY
    }

    const handleTouchEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0]
      const deltaX = touchStartX - touch.clientX // positive = swipe left
      const deltaY = Math.abs(touch.clientY - touchStartY)

      // Check if swipe was primarily horizontal (leftward) and far enough
      if (deltaX >= SWIPE_DISTANCE && deltaX > deltaY * SWIPE_RATIO) {
        if ('vibrate' in navigator) navigator.vibrate(10)
        onClose()
      }
    }

    drawer.addEventListener('touchstart', handleTouchStart, { passive: true })
    drawer.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      drawer.removeEventListener('touchstart', handleTouchStart)
      drawer.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isOpen, onClose])

  // Handle session selection - close drawer after selecting
  const handleSelect = (sessionId: string) => {
    onSelect(sessionId)
    onClose()
  }

  const handleSelectHibernating = (sessionId: string) => {
    onSelectHibernating?.(sessionId)
    onClose()
  }

  // The recovery panel (z-40) sits below the drawer (z-50), so close first.
  const handleOpenHistory = onOpenHistory
    ? () => {
        onClose()
        onOpenHistory()
      }
    : undefined

  // Inline styles for reduced motion
  const transitionStyle = prefersReducedMotion
    ? { transition: 'none' }
    : undefined

  return (
    <>
      {/* Backdrop */}
      <div
        className={`session-drawer-backdrop ${isOpen ? 'open' : ''}`}
        style={transitionStyle}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        className={`session-drawer ${isOpen ? 'open' : ''}`}
        style={transitionStyle}
        role="dialog"
        aria-modal="true"
        aria-label="Session list"
        tabIndex={-1}
      >
        <SessionList
          sessions={sessions}
          hibernatingSessions={hibernatingSessions}
          historySessions={historySessions}
          selectedSessionId={selectedSessionId}
          selectedHibernatingSessionId={selectedHibernatingSessionId}
          onSelect={handleSelect}
          onSelectHibernating={handleSelectHibernating}
          onRename={onRename}
          onResume={onResume}
          onHibernate={onHibernate}
          onMoveToHistory={onMoveToHistory}
          scrollSelectionActive={isOpen}
          onNewSession={() => {
            if (onNewSession() !== false) onClose()
          }}
          loading={loading}
          error={error}
          notice={
            handleOpenHistory && (
              <RecoveryNotice onOpen={handleOpenHistory} subscribe={subscribe} />
            )
          }
        />

        {/* New session (and session recovery) buttons at bottom */}
        <div
          className="flex shrink-0 gap-2 border-t border-border px-2 pt-2"
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0.5rem))' }}
        >
          <button
            onClick={() => {
              if (onNewSession() !== false) onClose()
            }}
            className="btn btn-primary min-h-[44px] flex-1 py-2 text-sm"
          >
            New Session
          </button>
          {handleOpenHistory && (
            <button
              type="button"
              onClick={handleOpenHistory}
              className={mobileButtonClass('neutral')}
              title="Session recovery"
              aria-label="Session recovery"
            >
              <ClockRewindIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} />
            </button>
          )}
        </div>
      </div>
    </>
  )
}
