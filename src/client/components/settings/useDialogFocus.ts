/**
 * Focus lifecycle for the settings dialog.
 *
 * useSuspendTerminalInput: while the dialog is mounted the xterm helper
 * textarea is disabled so the terminal can't capture keystrokes. On unmount
 * focus returns to the element that opened the dialog; the textarea is
 * re-enabled after a short delay (and focused only when nothing else got
 * focus back, e.g. the dialog was opened from the terminal by shortcut).
 *
 * useFocusTrap: Escape closes (unless a control consumed it with
 * preventDefault), Tab wraps inside the panel, and focus that escapes the
 * panel is pulled back.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { getFocusable, nextTrapTarget } from './focusTrap'

const TEXTAREA_SELECTOR = '.xterm-helper-textarea'
const REENABLE_DELAY_MS = 300

// Module-level so reopening within the delay cancels a pending re-enable
// that would otherwise unlock the terminal while the dialog is open again.
let reenableTimer: ReturnType<typeof setTimeout> | null = null

function focusableElement(el: Element | null): HTMLElement | null {
  if (!el || typeof document === 'undefined' || el === document.body) return null
  return typeof (el as HTMLElement).focus === 'function' ? (el as HTMLElement) : null
}

export function useSuspendTerminalInput(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
    if (reenableTimer) {
      clearTimeout(reenableTimer)
      reenableTimer = null
    }
    const opener = focusableElement(document.activeElement)
    const textarea = document.querySelector<HTMLTextAreaElement>(TEXTAREA_SELECTOR)
    if (textarea) {
      textarea.blur()
      textarea.setAttribute('disabled', 'true')
    }

    return () => {
      const restoreOpener = opener !== null && opener !== textarea && opener.isConnected
      if (restoreOpener) opener.focus()
      reenableTimer = setTimeout(() => {
        reenableTimer = null
        const current = document.querySelector<HTMLTextAreaElement>(TEXTAREA_SELECTOR)
        if (!current) return
        current.removeAttribute('disabled')
        if (!restoreOpener) current.focus()
      }, REENABLE_DELAY_MS)
    }
  }, [])
}

export function useFocusTrap(panelRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const active = document.activeElement as HTMLElement | null
      const target = nextTrapTarget(getFocusable(panel), active, event.shiftKey)
      if (target) {
        event.preventDefault()
        target.focus()
      }
    }

    const handleFocusIn = (event: FocusEvent) => {
      const panel = panelRef.current
      const target = event.target as Node | null
      if (panel && target && !panel.contains(target)) panel.focus()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('focusin', handleFocusIn)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('focusin', handleFocusIn)
    }
  }, [panelRef])
}
