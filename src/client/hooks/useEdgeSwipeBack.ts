/** Single-finger, left-edge navigation shared by drill-in pages and the drawer. */
import { useEffect, useRef, type RefObject } from 'react'

interface EdgeSwipeOptions {
  enabled: boolean
  onBack: () => void
  targetRef?: RefObject<HTMLElement | null>
  edgeThresholdPx?: number
  swipeDistancePx?: number
  swipeRatio?: number
}

export function useEdgeSwipeBack({
  enabled, onBack, targetRef, edgeThresholdPx = 30, swipeDistancePx = 50, swipeRatio = 1.5,
}: EdgeSwipeOptions) {
  const swiping = useRef(false)
  const callback = useRef(onBack)
  callback.current = onBack

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    const surface = targetRef?.current
    if (targetRef && !surface) return
    const target = surface ?? document
    let start: { x: number; y: number; id: number } | null = null
    const reset = () => { start = null; swiping.current = false }
    // A document-level gesture belongs to the terminal only when no modal
    // owns the foreground. A scoped gesture must originate in its own dialog.
    const ownsGesture = (event: TouchEvent) => {
      const modal = document.querySelector('[aria-modal="true"], [data-suspends-terminal]')
      if (!surface) return !modal
      return event.target instanceof Element && event.target.closest('[role="dialog"]') === surface
    }
    const begin = (event: TouchEvent) => {
      reset()
      if (event.touches.length !== 1 || !ownsGesture(event)) return
      const touch = event.touches[0]
      const left = surface?.getBoundingClientRect().left ?? 0
      if (touch.clientX < left || touch.clientX > left + edgeThresholdPx) return
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier }
      swiping.current = true
    }
    const move = (event: TouchEvent) => {
      if (!start) return
      const touch = event.touches[0]
      if (event.touches.length !== 1 || touch.identifier !== start.id ||
          Math.abs(touch.clientY - start.y) > Math.max(10, Math.abs(touch.clientX - start.x))) reset()
    }
    const end = (event: TouchEvent) => {
      const origin = start
      reset()
      if (!origin || event.touches.length || !ownsGesture(event)) return
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === origin.id)
      if (!touch) return
      const dx = touch.clientX - origin.x
      const dy = Math.abs(touch.clientY - origin.y)
      if (dx >= swipeDistancePx && dx > dy * swipeRatio) callback.current()
    }
    // Cast only at the EventTarget boundary; both targets emit TouchEvents.
    const handlers = { touchstart: begin, touchmove: move, touchend: end, touchcancel: reset }
    for (const [name, handler] of Object.entries(handlers)) target.addEventListener(name, handler as EventListener, { passive: true })
    return () => {
      reset()
      for (const [name, handler] of Object.entries(handlers)) target.removeEventListener(name, handler as EventListener)
    }
  }, [enabled, targetRef, edgeThresholdPx, swipeDistancePx, swipeRatio])

  return swiping
}
