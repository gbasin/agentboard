/**
 * NumPad - Long-press triggered number pad for mobile terminal
 * Shows a 0-9 grid on long press, positioned above finger for visibility
 * Drag to select numbers, release to confirm
 */

import { useState, useRef, useCallback, useEffect, type TouchEvent } from 'react'

interface NumPadProps {
  onSendKey: (key: string) => void
  disabled?: boolean
  onRefocus?: () => void
  isKeyboardVisible?: () => boolean
}

const LONG_PRESS_DELAY = 150 // ms to trigger numpad

// Grid dimensions (must match CSS)
const CELL_WIDTH = 56 // w-14 = 3.5rem = 56px
const CELL_HEIGHT = 48 // h-12 = 3rem = 48px
const GAP = 6 // gap-1.5 = 0.375rem = 6px
const PADDING = 8 // p-2 = 0.5rem = 8px

// Total pad dimensions (including indicator text)
const INDICATOR_HEIGHT = 20 + GAP + 2 // h-5 (20px) + marginTop
const PAD_WIDTH = 3 * CELL_WIDTH + 2 * GAP + 2 * PADDING // 184px
const PAD_HEIGHT = 3 * CELL_HEIGHT + 2 * GAP + 2 * PADDING + INDICATOR_HEIGHT // ~200px

function triggerHaptic(intensity: number = 10) {
  if ('vibrate' in navigator) {
    navigator.vibrate(intensity)
  }
}

// NumPad layout: calculator-style (7-8-9 at top, 1-2-3 at bottom)
const NUM_LAYOUT = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
]

export function getNumAtPoint(
  clientX: number,
  clientY: number,
  padPosition: { x: number; y: number }
): string | null {
  // Calculate position relative to pad top-left
  const padLeft = padPosition.x - PAD_WIDTH / 2
  const padTop = padPosition.y - PAD_HEIGHT / 2

  const relX = clientX - padLeft - PADDING
  const relY = clientY - padTop - PADDING

  // Check if within grid bounds
  const gridWidth = 3 * CELL_WIDTH + 2 * GAP
  const gridHeight = 3 * CELL_HEIGHT + 2 * GAP

  if (relX < 0 || relX > gridWidth || relY < 0 || relY > gridHeight) {
    return null
  }

  // Calculate column (0-2)
  const col = Math.floor(relX / (CELL_WIDTH + GAP))
  // Calculate row (0-2)
  const row = Math.floor(relY / (CELL_HEIGHT + GAP))

  // Clamp to valid range
  if (col < 0 || col > 2 || row < 0 || row > 2) {
    return null
  }

  // Check if actually inside a cell (not in the gap)
  const cellStartX = col * (CELL_WIDTH + GAP)
  const cellStartY = row * (CELL_HEIGHT + GAP)

  if (relX > cellStartX + CELL_WIDTH || relY > cellStartY + CELL_HEIGHT) {
    return null // In the gap
  }

  const num = NUM_LAYOUT[row]?.[col]
  return num || null
}

export default function NumPad({
  onSendKey,
  disabled = false,
  onRefocus,
  isKeyboardVisible,
}: NumPadProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeNum, setActiveNum] = useState<string | null>(null)
  const [padPosition, setPadPosition] = useState({ x: 0, y: 0 })

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasKeyboardVisibleRef = useRef(false)
  const hasSentKeyRef = useRef(false)

  // Close the numpad
  const closeNumPad = useCallback(() => {
    setIsOpen(false)
    setActiveNum(null)
    hasSentKeyRef.current = false

    if (wasKeyboardVisibleRef.current) {
      onRefocus?.()
    }
  }, [onRefocus])

  // Handle touch start on trigger button
  const handleTriggerTouchStart = useCallback((e: TouchEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()

    const touch = e.touches[0]
    wasKeyboardVisibleRef.current = isKeyboardVisible?.() ?? false
    hasSentKeyRef.current = false

    longPressTimerRef.current = setTimeout(() => {
      triggerHaptic(15)
      // Position numpad above the touch point, centered horizontally
      const margin = 10

      let x = touch.clientX
      let y = touch.clientY - 120 // Above finger

      // Clamp horizontal
      x = Math.max(margin + PAD_WIDTH / 2, Math.min(window.innerWidth - margin - PAD_WIDTH / 2, x))
      // Clamp vertical (don't go above screen)
      y = Math.max(margin + PAD_HEIGHT / 2, y)

      setPadPosition({ x, y })
      setIsOpen(true)
    }, LONG_PRESS_DELAY)
  }, [disabled, isKeyboardVisible])

  // Calculate which number is under the touch point based on grid math
  const getNumAtPointForPad = useCallback(
    (clientX: number, clientY: number): string | null =>
      getNumAtPoint(clientX, clientY, padPosition),
    [padPosition]
  )

  // Handle touch move - highlight number under finger
  const handleTouchMove = useCallback((e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (!isOpen) return

    const touch = e.touches[0]
    const num = getNumAtPointForPad(touch.clientX, touch.clientY)

    if (num !== activeNum) {
      setActiveNum(num)
      if (num) {
        triggerHaptic(5)
      }
    }
  }, [isOpen, activeNum, getNumAtPointForPad])

  // Handle touch end - send the selected number
  const handleTouchEnd = useCallback((e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    if (isOpen && activeNum && !hasSentKeyRef.current) {
      triggerHaptic(10)
      onSendKey(activeNum)
      hasSentKeyRef.current = true
    }

    closeNumPad()
  }, [isOpen, activeNum, onSendKey, closeNumPad])

  // Handle touch cancel
  const handleTouchCancel = useCallback((e: TouchEvent) => {
    e.preventDefault()
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    closeNumPad()
  }, [closeNumPad])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
    }
  }, [])

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        className={`
          terminal-key
          flex items-center justify-center
          size-[44px] p-0
          text-sm font-medium
          bg-surface border border-border rounded-md
          active:bg-hover active:scale-95
          transition-transform duration-75
          select-none
          text-secondary
          ${disabled ? 'opacity-50' : ''}
          ${isOpen ? 'bg-hover scale-95' : ''}
        `}
        style={{ touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
        onTouchStart={handleTriggerTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        disabled={disabled}
      >
        123
      </button>

      {/* NumPad overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 select-none"
          style={{
            touchAction: 'none',
            WebkitTouchCallout: 'none',
            WebkitUserSelect: 'none',
            userSelect: 'none',
          }}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
        >
          {/* Semi-transparent backdrop */}
          <div className="absolute inset-0 bg-black/20" />

          {/* NumPad container */}
          <div
            className="absolute select-none"
            style={{
              left: padPosition.x,
              top: padPosition.y,
              transform: 'translate(-50%, -50%)',
              WebkitUserSelect: 'none',
              userSelect: 'none',
            }}
          >
            {/* Pad background */}
            <div
              className="rounded-2xl bg-black/40 backdrop-blur-md border-2 border-white/20 select-none"
              style={{ padding: PADDING }}
            >
              {/* Number grid */}
              <div
                className="grid grid-cols-3 select-none"
                style={{ gap: GAP }}
              >
                {NUM_LAYOUT.flat().map((num, i) => (
                  num ? (
                    <div
                      key={i}
                      className={`
                        flex items-center justify-center
                        rounded-lg text-xl font-bold
                        select-none
                        transition-all duration-75
                        ${activeNum === num
                          ? 'bg-accent text-white scale-110'
                          : 'bg-white/90 text-gray-800'}
                      `}
                      style={{
                        width: CELL_WIDTH,
                        height: CELL_HEIGHT,
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                      }}
                    >
                      {num}
                    </div>
                  ) : (
                    <div key={i} style={{ width: CELL_WIDTH, height: CELL_HEIGHT }} />
                  )
                ))}
              </div>

              {/* Selected number indicator - fixed height to prevent layout shift */}
              <div
                className="text-center text-white text-sm font-medium select-none h-5"
                style={{ marginTop: GAP + 2 }}
              >
                {activeNum ? `Release to send "${activeNum}"` : '\u00A0'}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
