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

  const keyboardHeight = win.innerHeight - viewport.height
  doc.documentElement.style.setProperty(
    '--keyboard-inset',
    `${Math.max(0, keyboardHeight)}px`
  )

  // Toggle class for CSS-based safe area handling
  if (keyboardHeight > KEYBOARD_THRESHOLD) {
    doc.documentElement.classList.add('keyboard-visible')
  } else {
    doc.documentElement.classList.remove('keyboard-visible')
  }

  return true
}

export function clearKeyboardInset(doc: Document) {
  doc.documentElement.style.removeProperty('--keyboard-inset')
  doc.documentElement.classList.remove('keyboard-visible')
}

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const updateViewport = () => {
      updateKeyboardInset({ viewport, win: window, doc: document })
    }

    // Initial update
    updateViewport()

    // Listen for viewport changes (keyboard show/hide, zoom, scroll)
    viewport.addEventListener('resize', updateViewport)
    viewport.addEventListener('scroll', updateViewport)

    return () => {
      viewport.removeEventListener('resize', updateViewport)
      viewport.removeEventListener('scroll', updateViewport)
      clearKeyboardInset(document)
    }
  }, [])
}
