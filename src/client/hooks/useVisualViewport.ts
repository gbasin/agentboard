/**
 * useVisualViewport - Handles mobile keyboard appearance by tracking visual viewport
 * Sets CSS custom property --keyboard-inset for bottom offset when keyboard is open
 * Also toggles 'keyboard-visible' class on html element for CSS safe area handling
 */

import { useEffect } from 'react'

// Threshold to consider keyboard as "visible" (accounts for minor viewport adjustments)
const KEYBOARD_THRESHOLD = 100

export function updateKeyboardInset({
  viewport,
  win,
  doc,
}: {
  viewport: VisualViewport | null | undefined
  win: Window
  doc: Document
}): boolean {
  if (!viewport) {
    return false
  }

  const offsetTop = Math.max(0, viewport.offsetTop || 0)
  const offsetLeft = Math.max(0, viewport.offsetLeft || 0)
  const keyboardHeight = win.innerHeight - (viewport.height + offsetTop)
  const clampedKeyboardHeight = Math.max(0, keyboardHeight)
  const viewportHeight = Math.max(0, viewport.height || 0)
  const viewportWidth = Math.max(0, viewport.width || 0)
  doc.documentElement.style.setProperty(
    '--keyboard-inset',
    `${clampedKeyboardHeight}px`
  )
  doc.documentElement.style.setProperty(
    '--viewport-offset-top',
    `${offsetTop}px`
  )
  doc.documentElement.style.setProperty(
    '--viewport-offset-left',
    `${offsetLeft}px`
  )
  doc.documentElement.style.setProperty(
    '--visual-viewport-height',
    `${viewportHeight}px`
  )
  doc.documentElement.style.setProperty(
    '--visual-viewport-width',
    `${viewportWidth}px`
  )

  // Toggle class for CSS-based safe area handling
  if (clampedKeyboardHeight > KEYBOARD_THRESHOLD) {
    doc.documentElement.classList.add('keyboard-visible')
  } else {
    doc.documentElement.classList.remove('keyboard-visible')
  }

  return true
}

export function clearKeyboardInset(doc: Document) {
  doc.documentElement.style.removeProperty('--keyboard-inset')
  doc.documentElement.style.removeProperty('--viewport-offset-top')
  doc.documentElement.style.removeProperty('--viewport-offset-left')
  doc.documentElement.style.removeProperty('--visual-viewport-height')
  doc.documentElement.style.removeProperty('--visual-viewport-width')
  doc.documentElement.classList.remove('keyboard-visible')
}

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    let rafId: number | null = null
    let pollTimer: number | null = null

    const isTextInputActive = () => {
      const active = document.activeElement
      if (!active) return false
      const tagName = (active as HTMLElement).tagName?.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea') {
        return true
      }
      return Boolean((active as HTMLElement).isContentEditable)
    }

    const updateViewport = () => {
      updateKeyboardInset({ viewport, win: window, doc: document })
    }

    const startRafBurst = () => {
      if (typeof window.requestAnimationFrame !== 'function') {
        updateViewport()
        return
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
      }
      const start = performance.now()
      const tick = () => {
        updateViewport()
        if (performance.now() - start < 1500) {
          rafId = window.requestAnimationFrame(tick)
        } else {
          rafId = null
        }
      }
      rafId = window.requestAnimationFrame(tick)
    }

    const pollTick = () => {
      if (!isTextInputActive()) {
        stopPolling()
        return
      }
      updateViewport()
    }

    const startPolling = () => {
      if (pollTimer !== null || typeof window.setInterval !== 'function') return
      pollTimer = window.setInterval(pollTick, 250)
      pollTick()
    }

    const stopPolling = () => {
      if (pollTimer === null || typeof window.clearInterval !== 'function') return
      window.clearInterval(pollTimer)
      pollTimer = null
    }

    const syncActiveState = () => {
      if (isTextInputActive()) {
        startRafBurst()
        startPolling()
        updateViewport()
      } else {
        stopPolling()
      }
    }

    const handleFocusIn = () => {
      syncActiveState()
    }

    const handleFocusOut = () => {
      syncActiveState()
    }

    const handleOrientationChange = () => {
      startRafBurst()
    }

    // Initial update
    updateViewport()
    syncActiveState()

    // Listen for viewport changes (keyboard show/hide, zoom, scroll)
    viewport.addEventListener('resize', updateViewport)
    viewport.addEventListener('scroll', updateViewport)
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', updateViewport)
      window.addEventListener('orientationchange', handleOrientationChange)
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('focusin', handleFocusIn)
      document.addEventListener('focusout', handleFocusOut)
      document.addEventListener('focus', handleFocusIn, true)
      document.addEventListener('blur', handleFocusOut, true)
    }

    return () => {
      viewport.removeEventListener('resize', updateViewport)
      viewport.removeEventListener('scroll', updateViewport)
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', updateViewport)
        window.removeEventListener('orientationchange', handleOrientationChange)
      }
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('focusin', handleFocusIn)
        document.removeEventListener('focusout', handleFocusOut)
        document.removeEventListener('focus', handleFocusIn, true)
        document.removeEventListener('blur', handleFocusOut, true)
      }
      if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId)
      }
      stopPolling()
      clearKeyboardInset(document)
    }
  }, [])
}
