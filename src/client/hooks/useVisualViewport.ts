/**
 * useVisualViewport - Handles mobile keyboard appearance by tracking visual viewport
 * Sets CSS custom property --keyboard-inset for bottom offset when keyboard is open
 */

import { useEffect } from 'react'

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const updateViewport = () => {
      // Calculate the keyboard height (difference between layout and visual viewport)
      const keyboardHeight = window.innerHeight - viewport.height

      // Set CSS custom property for keyboard offset
      document.documentElement.style.setProperty(
        '--keyboard-inset',
        `${Math.max(0, keyboardHeight)}px`
      )
    }

    // Initial update
    updateViewport()

    // Listen for viewport changes (keyboard show/hide, zoom, scroll)
    viewport.addEventListener('resize', updateViewport)
    viewport.addEventListener('scroll', updateViewport)

    return () => {
      viewport.removeEventListener('resize', updateViewport)
      viewport.removeEventListener('scroll', updateViewport)
      document.documentElement.style.removeProperty('--keyboard-inset')
    }
  }, [])
}
