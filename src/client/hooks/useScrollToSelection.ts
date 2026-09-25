import { useEffect, useRef, type RefObject } from 'react'

function escapeAttrValue(value: string): string {
  return typeof CSS !== 'undefined'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

/**
 * Keep the element marked [data-session-id=<selectedId>] scrolled into view
 * inside the given scroll container. Fires on every selection change —
 * instant, nearest edge — and retries on later renders while the target row
 * hasn't mounted yet (e.g. a persisted selection restored before sessions
 * arrive over WebSocket).
 *
 * `canTarget(id)` may veto a pending scroll — return false to drop it, e.g.
 * when the row lives in a collapsed section that renders no DOM node.
 */
export function useScrollToSelection<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  selectedId: string | null,
  canTarget?: (id: string) => boolean
) {
  const pendingIdRef = useRef<string | null>(selectedId)

  useEffect(() => {
    pendingIdRef.current = selectedId
  }, [selectedId])

  // No dep array: re-check after every render while a scroll is pending so
  // rows that mount after the selection change still get scrolled to.
  useEffect(() => {
    const targetId = pendingIdRef.current
    if (!targetId) return
    if (canTarget && !canTarget(targetId)) {
      pendingIdRef.current = null
      return
    }
    const node = containerRef.current?.querySelector(
      `[data-session-id="${escapeAttrValue(targetId)}"]`
    )
    if (node) {
      // 'instant' overrides CSS scroll-behavior (e.g. scroll-smooth on the
      // mobile strip) so rapid keyboard cycling never trails a scroll anim.
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      pendingIdRef.current = null
    }
  })
}
