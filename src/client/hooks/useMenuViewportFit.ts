import { useLayoutEffect, useState, type RefObject } from 'react'

export interface MenuPoint {
  x: number
  y: number
}

/**
 * Position for a `position: fixed` context menu opened at `point`. The menu
 * opens down-right from the pointer as before; if that would run past the
 * viewport's bottom or right edge it flips up / left of the pointer instead.
 * Needed by the bottom-anchored sidebar, whose first rows sit near the
 * bottom of the window. Measured in a layout effect, so the flip lands
 * before the first paint.
 */
export function useMenuViewportFit(
  menuRef: RefObject<HTMLElement | null>,
  point: MenuPoint | null
): { left: number; top: number } | null {
  const [fitted, setFitted] = useState<{ key: MenuPoint; left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!point || !menu || typeof window === 'undefined') return
    if (typeof menu.getBoundingClientRect !== 'function') return
    const { width, height } = menu.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const top =
      typeof viewportHeight === 'number' && point.y + height > viewportHeight
        ? Math.max(0, point.y - height)
        : point.y
    const left =
      typeof viewportWidth === 'number' && point.x + width > viewportWidth
        ? Math.max(0, point.x - width)
        : point.x
    setFitted({ key: point, left, top })
  }, [menuRef, point])

  if (!point) return null
  if (fitted && fitted.key === point) return { left: fitted.left, top: fitted.top }
  return { left: point.x, top: point.y }
}
