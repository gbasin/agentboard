import { useLayoutEffect, useRef, type RefObject } from 'react'

function escapeAttrValue(value: string): string {
  return typeof CSS !== 'undefined'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

function px(value: string): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Scroll `row` the minimum amount to be fully visible inside `container`
 * ('nearest' semantics), honoring CSS scroll-padding (e.g. the list's
 * scroll-pt-10 under its sticky filter bar).
 *
 * Unlike scrollIntoView this only writes to the container — it can never
 * scroll ancestor scrollers or the window. Rects for the row and container
 * share the same ancestor transform, so the difference is correct even
 * inside a translated off-screen drawer (where scrollIntoView miscomputes
 * on iOS Safari). That lets callers scroll before the container is visible,
 * so a drawer opens already positioned instead of snapping after landing.
 */
function scrollRowIntoView(container: HTMLElement, row: Element) {
  const style = getComputedStyle(container)
  const containerRect = container.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()

  let top: number | undefined
  let left: number | undefined

  if (container.scrollHeight > container.clientHeight) {
    const padTop = px(style.scrollPaddingTop)
    const padBottom = px(style.scrollPaddingBottom)
    const rowTop = rowRect.top - containerRect.top + container.scrollTop
    const rowBottom = rowTop + rowRect.height
    const viewTop = container.scrollTop + padTop
    const viewBottom = container.scrollTop + container.clientHeight - padBottom
    if (rowTop < viewTop) {
      top = rowTop - padTop
    } else if (rowBottom > viewBottom) {
      top = rowBottom - container.clientHeight + padBottom
    }
  }

  if (container.scrollWidth > container.clientWidth) {
    const padLeft = px(style.scrollPaddingLeft)
    const padRight = px(style.scrollPaddingRight)
    const rowLeft = rowRect.left - containerRect.left + container.scrollLeft
    const rowRight = rowLeft + rowRect.width
    const viewLeft = container.scrollLeft + padLeft
    const viewRight = container.scrollLeft + container.clientWidth - padRight
    if (rowLeft < viewLeft) {
      left = rowLeft - padLeft
    } else if (rowRight > viewRight) {
      left = rowRight - container.clientWidth + padRight
    }
  }

  if (top !== undefined || left !== undefined) {
    // 'instant' overrides any CSS scroll-behavior so rapid keyboard cycling
    // never trails a scroll animation.
    container.scrollTo({ top, left, behavior: 'instant' })
  }
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
 *
 * `active` should be false while the container is conceptually hidden
 * (e.g. a closed mobile drawer). The pending scroll is held and re-armed to
 * the current selection when `active` flips back to true, so reopening
 * always lands on the selection. The scroll itself runs in a layout effect
 * before paint, so the drawer is already positioned on its first visible
 * frame — no post-landing snap.
 */
export function useScrollToSelection<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  selectedId: string | null,
  canTarget?: (id: string) => boolean,
  active = true
) {
  const pendingIdRef = useRef<string | null>(selectedId)

  useLayoutEffect(() => {
    pendingIdRef.current = selectedId
  }, [selectedId, active])

  // No dep array: re-check after every render while a scroll is pending so
  // rows that mount after the selection change still get scrolled to.
  useLayoutEffect(() => {
    if (!active) return
    const targetId = pendingIdRef.current
    if (!targetId) return
    if (canTarget && !canTarget(targetId)) {
      pendingIdRef.current = null
      return
    }
    const container = containerRef.current
    const node = container?.querySelector(
      `[data-session-id="${escapeAttrValue(targetId)}"]`
    )
    if (container && node) {
      scrollRowIntoView(container, node)
      pendingIdRef.current = null
    }
  })
}
