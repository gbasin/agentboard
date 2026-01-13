/**
 * SessionDrawer - Mobile slide-out drawer for session list
 * Slides in from left side, covers ~75% of screen width
 * Close by: tap backdrop, press Escape, or swipe left
 */

import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'motion/react'
import type { Session } from '@shared/types'
import SessionList from './SessionList'

interface SessionDrawerProps {
  isOpen: boolean
  onClose: () => void
  sessions: Session[]
  selectedSessionId: string | null
  onSelect: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onNewSession: () => void
  loading: boolean
  error: string | null
}

export default function SessionDrawer({
  isOpen,
  onClose,
  sessions,
  selectedSessionId,
  onSelect,
  onRename,
  onNewSession,
  loading,
  error,
}: SessionDrawerProps) {
  const prefersReducedMotion = useReducedMotion()
  const drawerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

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
      drawerRef.current?.focus()
    } else if (previousFocusRef.current) {
      // Return focus to previous element
      previousFocusRef.current.focus()
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
          selectedSessionId={selectedSessionId}
          onSelect={handleSelect}
          onRename={onRename}
          loading={loading}
          error={error}
        />

        {/* New session button at bottom */}
        <div className="shrink-0 border-t border-border p-2">
          <button
            onClick={() => {
              onNewSession()
              onClose()
            }}
            className="btn btn-primary w-full py-2 text-sm"
          >
            New Session
          </button>
        </div>
      </div>
    </>
  )
}
