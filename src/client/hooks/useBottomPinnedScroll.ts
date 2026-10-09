import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** Distance (px) from the bottom that still counts as "at the bottom". */
const PIN_TOLERANCE_PX = 2

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_TOLERANCE_PX
}

/**
 * Keep a scroll container pinned to its bottom edge, chat-log style — used by
 * the bottom-anchored desktop sidebar, whose first rows sit at the bottom.
 *
 * - When `enabled` turns on (or on mount), the container jumps to the bottom.
 * - While the user is at the bottom, content growing or shrinking (a row
 *   added or removed, a section expanded) keeps it at the bottom.
 * - Once the user scrolls up, it stays where they put it until they return
 *   to the bottom.
 *
 * Re-pinning runs in a layout effect (before paint, so a new row never
 * flashes the list off the bottom) and from a ResizeObserver on `contentRef`
 * and the container for size changes that happen outside a React commit.
 * Call this BEFORE useScrollToSelection in the same component: layout effects run in
 * declaration order, so a selection scroll in the same commit wins.
 *
 * Disabled, it does nothing — the top-anchored list is untouched.
 */
export function useBottomPinnedScroll<C extends HTMLElement, I extends HTMLElement>(
  containerRef: RefObject<C | null>,
  contentRef: RefObject<I | null>,
  enabled: boolean
) {
  const pinnedRef = useRef(true)
  // Keyed on both heights: the viewport shrinking (a banner appearing above
  // the list, a window resize) moves the bottom edge just like new content.
  const lastSizeRef = useRef<string | null>(null)

  const repin = () => {
    const el = containerRef.current
    if (!el) return
    const size = `${el.scrollHeight}:${el.clientHeight}`
    if (size === lastSizeRef.current) return
    lastSizeRef.current = size
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }
  const repinRef = useRef(repin)
  repinRef.current = repin

  // Enabling (mount or a settings flip) opens the list at the bottom.
  useLayoutEffect(() => {
    lastSizeRef.current = null
    if (!enabled) return
    pinnedRef.current = true
    repinRef.current()
  }, [enabled])

  // No dep array: re-check after every commit; cheap when height is unchanged.
  useLayoutEffect(() => {
    if (enabled) repinRef.current()
  })

  useEffect(() => {
    if (!enabled) return
    const el = containerRef.current
    if (!el || typeof el.addEventListener !== 'function') return
    const onScroll = () => {
      pinnedRef.current = isAtBottom(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [enabled, containerRef])

  useEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => repinRef.current())
    observer.observe(content)
    // The container too: it resizes without a SessionList commit when a
    // sibling (e.g. the recovery notice) or the window changes size.
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [enabled, contentRef, containerRef])
}
