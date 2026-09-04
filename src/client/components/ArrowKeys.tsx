/**
 * ArrowKeys - Tap-to-open arrow key cluster for mobile terminal navigation.
 * Tapping the trigger shows ↑ ← ↓ → floating above the key deck so the deck
 * never reflows. Tap an arrow for one press, hold it to repeat like a
 * keyboard key. Tap the trigger again, or anywhere outside, to close.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { MoveIcon } from '@untitledui-icons/react/line'

interface ArrowKeysProps {
  onSendKey: (key: string) => void
  disabled?: boolean
  onRefocus?: () => void
  isKeyboardVisible?: () => boolean
}

// Arrow key escape sequences
export const ARROW_KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
} as const

export type ArrowDirection = keyof typeof ARROW_KEYS

export const REPEAT_INITIAL_DELAY = 400 // ms held before auto-repeat starts
export const REPEAT_INTERVAL = 100 // ms between repeats while held

const CELL = 44 // px, matches the key deck's touch targets
const GAP = 6
const PADDING = 8
const LIFT = 10 // px between the trigger and the cluster
const MARGIN = 8 // px kept from the viewport edges
export const PAD_WIDTH = 3 * CELL + 2 * GAP + 2 * PADDING
export const PAD_HEIGHT = 2 * CELL + GAP + 2 * PADDING

const ARROW_LABELS: Record<ArrowDirection, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
}

// Inverted-T layout, like a keyboard: ↑ on top, ← ↓ → below.
// Grid areas: row 1 = [empty, up, empty], row 2 = [left, down, right]
const GRID_AREA: Record<ArrowDirection, string> = {
  up: '1 / 2 / 2 / 3',
  left: '2 / 1 / 3 / 2',
  down: '2 / 2 / 3 / 3',
  right: '2 / 3 / 3 / 4',
}
function triggerHaptic(intensity: number = 10) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(intensity)
  }
}

/**
 * Where to draw the cluster so it sits centered above the trigger, and how
 * tall the tap-outside backdrop may be. The backdrop stops at the top of the
 * key deck so Enter, Esc, Tab and the rest stay pressable while the arrows
 * are up (menu navigation needs both).
 */
export function getPadPosition(
  trigger: { left: number; top: number; width: number },
  deckTop: number,
  viewport: { width: number; height: number }
): { left: number; bottom: number; backdropHeight: number } {
  const centerX = trigger.left + trigger.width / 2
  const minX = MARGIN + PAD_WIDTH / 2
  const maxX = viewport.width - MARGIN - PAD_WIDTH / 2
  const left = Math.max(minX, Math.min(maxX, centerX))
  const bottom = viewport.height - deckTop + LIFT
  return { left, bottom, backdropHeight: Math.max(0, deckTop) }
}

export default function ArrowKeys({
  onSendKey,
  disabled = false,
  onRefocus,
  isKeyboardVisible,
}: ArrowKeysProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [padPosition, setPadPosition] = useState({ left: 0, bottom: 0, backdropHeight: 0 })
  const [heldDirection, setHeldDirection] = useState<ArrowDirection | null>(null)

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const wasKeyboardVisibleRef = useRef(false)
  const repeatDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const heldRef = useRef<ArrowDirection | null>(null)

  const stopRepeat = useCallback(() => {
    if (repeatDelayRef.current) {
      clearTimeout(repeatDelayRef.current)
      repeatDelayRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
    heldRef.current = null
    setHeldDirection(null)
  }, [])

  const close = useCallback(() => {
    stopRepeat()
    setIsOpen(false)
    if (wasKeyboardVisibleRef.current) {
      onRefocus?.()
    }
  }, [stopRepeat, onRefocus])

  const open = useCallback(() => {
    wasKeyboardVisibleRef.current = isKeyboardVisible?.() ?? false
    const rect = triggerRef.current?.getBoundingClientRect?.()
    const deckRect = triggerRef.current?.closest?.('.terminal-controls')?.getBoundingClientRect?.()
    const viewport =
      typeof window !== 'undefined'
        ? { width: window.innerWidth, height: window.innerHeight }
        : { width: 0, height: 0 }
    const trigger = rect
      ? { left: rect.left, top: rect.top, width: rect.width }
      : { left: viewport.width / 2, top: viewport.height, width: 0 }
    const deckTop = deckRect?.top ?? trigger.top
    setPadPosition(getPadPosition(trigger, deckTop, viewport))
    setIsOpen(true)
  }, [isKeyboardVisible])

  const handleTriggerPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (disabled) return
      // Keep focus (and the soft keyboard) where it is.
      e.preventDefault()
      triggerHaptic()
      if (isOpen) {
        close()
      } else {
        open()
      }
    },
    [disabled, isOpen, close, open]
  )

  const press = useCallback(
    (direction: ArrowDirection) => {
      stopRepeat()
      heldRef.current = direction
      setHeldDirection(direction)
      triggerHaptic(8)
      onSendKey(ARROW_KEYS[direction])
      repeatDelayRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          if (heldRef.current !== direction) return
          triggerHaptic(5)
          onSendKey(ARROW_KEYS[direction])
        }, REPEAT_INTERVAL)
      }, REPEAT_INITIAL_DELAY)
    },
    [onSendKey, stopRepeat]
  )

  const handleArrowPointerDown = useCallback(
    (direction: ArrowDirection) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      e.preventDefault()
      // Keep receiving pointer events for this press even if the finger
      // drifts off the key, so release always stops the repeat.
      e.currentTarget.setPointerCapture?.(e.pointerId)
      press(direction)
    },
    [disabled, press]
  )

  const handleArrowRelease = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      stopRepeat()
    },
    [stopRepeat]
  )

  const handleBackdropPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      close()
    },
    [close]
  )

  // Close if the controls become disabled while open.
  useEffect(() => {
    if (disabled && isOpen) {
      close()
    }
  }, [disabled, isOpen, close])

  // Clean up timers on unmount.
  useEffect(() => stopRepeat, [stopRepeat])

  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        aria-label="Arrow keys"
        aria-expanded={isOpen}
        className={`
          terminal-key
          flex items-center justify-center
          size-[44px] p-0
          text-sm font-medium
          border rounded-md
          active:scale-95
          transition-transform duration-75
          select-none
          ${disabled ? 'opacity-50' : ''}
          ${isOpen
            ? 'bg-accent/20 text-accent border-accent/40'
            : 'bg-surface border-border text-secondary active:bg-hover'}
        `}
        style={{ touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
        onPointerDown={handleTriggerPointerDown}
        disabled={disabled}
      >
        <MoveIcon width={20} height={20} />
      </button>

      {isOpen && (
        <>
          {/* Transparent backdrop over the terminal: a tap there closes the
              cluster. It stops above the key deck so Enter/Esc/Tab stay live,
              and there is no dimming so a menu being navigated stays readable. */}
          <div
            data-testid="arrow-keys-backdrop"
            className="fixed left-0 right-0 top-0 z-40"
            style={{ height: padPosition.backdropHeight, touchAction: 'none' }}
            onPointerDown={handleBackdropPointerDown}
          />

          {/* Arrow cluster, floating above the trigger */}
          <div
            role="group"
            aria-label="Arrow key cluster"
            className="fixed z-50 select-none rounded-2xl bg-black/40 backdrop-blur-md border-2 border-white/20"
            style={{
              left: padPosition.left,
              bottom: padPosition.bottom,
              transform: 'translateX(-50%)',
              padding: PADDING,
              touchAction: 'none',
              WebkitTouchCallout: 'none',
              WebkitUserSelect: 'none',
            }}
          >
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(3, ${CELL}px)`,
                gridTemplateRows: `repeat(2, ${CELL}px)`,
                gap: GAP,
              }}
            >
              {(Object.keys(ARROW_KEYS) as ArrowDirection[]).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  aria-label={`Arrow ${direction}`}
                  className={`
                    flex items-center justify-center
                    rounded-lg text-xl font-bold
                    select-none transition-all duration-75
                    ${heldDirection === direction
                      ? 'bg-accent text-white scale-110'
                      : 'bg-white/90 text-gray-800'}
                  `}
                  style={{
                    gridArea: GRID_AREA[direction],
                    touchAction: 'none',
                    WebkitTouchCallout: 'none',
                    WebkitUserSelect: 'none',
                  }}
                  onPointerDown={handleArrowPointerDown(direction)}
                  onPointerUp={handleArrowRelease}
                  onPointerCancel={handleArrowRelease}
                  onLostPointerCapture={handleArrowRelease}
                  disabled={disabled}
                >
                  {ARROW_LABELS[direction]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
