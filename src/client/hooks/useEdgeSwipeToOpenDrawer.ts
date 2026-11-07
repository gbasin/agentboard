import { type MutableRefObject } from 'react'
import { useEdgeSwipeBack } from './useEdgeSwipeBack'

interface UseEdgeSwipeOptions {
  enabled: boolean
  isOpen: boolean
  onOpen: () => void
  edgeThresholdPx?: number
  swipeDistancePx?: number
  swipeRatio?: number
}

/**
 * Detects swipe gestures from the left edge of the screen to open a drawer.
 * Returns a ref that tracks whether an edge swipe is in progress.
 */
export function useEdgeSwipeToOpenDrawer({
  enabled,
  isOpen,
  onOpen,
  edgeThresholdPx = 30,
  swipeDistancePx = 50,
  swipeRatio = 1.5,
}: UseEdgeSwipeOptions): MutableRefObject<boolean> {
  return useEdgeSwipeBack({
    enabled: enabled && !isOpen,
    onBack: onOpen,
    edgeThresholdPx,
    swipeDistancePx,
    swipeRatio,
  })
}
