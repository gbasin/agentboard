/**
 * Focus lifecycle for the settings dialog.
 *
 * useSuspendTerminalInput: while the dialog is mounted the xterm helper
 * textarea is disabled so the terminal can't capture keystrokes. On unmount
 * the textarea is re-enabled after a short delay and focused: in a terminal
 * app the next thing the user does after closing settings is type, whatever
 * opened the dialog. Only when there is no terminal (no session selected)
 * does focus go back to the element that opened the dialog, or to the
 * button now carrying its label if a setting re-rendered it away.
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

/** The opener if still in the document, else a button with the same label. */
function findOpener(opener: HTMLElement, label: string | null): HTMLElement | null {
  if (opener.isConnected) return opener
  if (!label) return null
  const escaped = label.replace(/["\\]/g, '\\$&')
  return document.querySelector<HTMLElement>(`button[aria-label="${escaped}"]`)
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

    // A setting can re-render the opener away (e.g. the sidebar anchor
    // remounts the gear), so remember how to find its replacement.
    const openerLabel = opener?.getAttribute?.('aria-label') ?? null

    return () => {
      reenableTimer = setTimeout(() => {
        reenableTimer = null
        const current = document.querySelector<HTMLTextAreaElement>(TEXTAREA_SELECTOR)
        if (current) {
          current.removeAttribute('disabled')
          current.focus()
          return
        }
        const fallback = opener && opener !== textarea ? findOpener(opener, openerLabel) : null
        fallback?.focus()
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
