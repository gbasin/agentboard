/**
 * Focus-trap helpers for the settings dialog, kept DOM-light so they can be
 * unit tested with plain objects. The dialog wires them to document keydown
 * (Tab wraps inside the panel) and focusin (focus that escapes is pulled
 * back to the panel).
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Tabbable elements inside `root`, in DOM order. */
export function getFocusable(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && el.tabIndex !== -1
  )
}

/**
 * Where Tab should move focus to keep it inside the trap, or null to let the
 * browser handle it. Wraps at both ends; focus outside the list goes to the
 * first (or, with Shift, the last) element.
 */
export function nextTrapTarget<T>(
  focusable: readonly T[],
  active: T | null,
  shift: boolean
): T | null {
  if (focusable.length === 0) return null
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const index = active === null ? -1 : focusable.indexOf(active)
  if (index === -1) return shift ? last : first
  if (shift && index === 0) return last
  if (!shift && index === focusable.length - 1) return first
  return null
}
