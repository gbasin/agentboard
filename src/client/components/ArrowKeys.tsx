/**
 * ArrowKeys - Tap-to-open arrow key cluster for mobile terminal navigation.
 * Tapping the trigger shows ↑ ← ↓ → floating above the key deck so the deck
 * never reflows. Tap an arrow for one press, hold it to repeat like a
 * keyboard key. Tap the trigger again, or anywhere on the terminal, to close.
 *
 * The cluster is positioned absolutely against the `.terminal-controls`
 * container rather than the viewport: on iOS the app root is a transformed,
 * visual-viewport-sized element, so `position: fixed` maths against
 * window.innerHeight lands in the wrong place once the soft keyboard is up.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { MoveIcon } from '@untitledui-icons/react/line'

interface ArrowKeysProps {
  onSendKey: (key: string) => void
  disabled?: boolean
  onRefocus?: () => void
  isKeyboardVisible?: () => boolean
  /** Changes when the attached session changes; any held repeat stops. */
  sessionKey?: string | null
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
const LIFT = 10 // px between the deck and the cluster
const MARGIN = 8 // px kept from the container edges
const CLICK_SUPPRESS_MS = 700 // a click this soon after a pointerdown is the browser's synthesized one
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
 * Horizontal centre of the cluster, in the container's coordinate space,
 * clamped so the pad stays inside the container. A container narrower than
 * the pad centres it.
 */
export function getPadLeft(
  trigger: { left: number; width: number },
  container: { left: number; width: number }
): number {
  const centerX = trigger.left - container.left + trigger.width / 2
  const minX = MARGIN + PAD_WIDTH / 2
  const maxX = container.width - MARGIN - PAD_WIDTH / 2
  if (minX > maxX) return container.width / 2
  return Math.max(minX, Math.min(maxX, centerX))
}

export default function ArrowKeys({
  onSendKey,
  disabled = false,
  onRefocus,
  isKeyboardVisible,
  sessionKey = null,
}: ArrowKeysProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [padLeft, setPadLeft] = useState(0)
  const [heldDirection, setHeldDirection] = useState<ArrowDirection | null>(null)
  const clusterId = useId()

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const wasKeyboardVisibleRef = useRef(false)
  const repeatDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const heldRef = useRef<ArrowDirection | null>(null)
  const activePointerRef = useRef<number | null>(null)
  // Time of the last pointerdown we handled. Browsers follow a touch with a
  // synthesized click (detail is 0 in some engines, so it is not a reliable
  // discriminator); clicks shortly after a handled pointerdown are ignored,
  // and only keyboard / assistive-technology clicks get through.
  const lastPointerDownRef = useRef(0)
  // Latest props, read by timers so a held repeat never uses a stale sender
  // (the sender is bound to a session) or fires after the controls disable.
  const onSendKeyRef = useRef(onSendKey)
  const disabledRef = useRef(disabled)
  onSendKeyRef.current = onSendKey
  disabledRef.current = disabled

  const clearTimers = useCallback(() => {
    if (repeatDelayRef.current) {
      clearTimeout(repeatDelayRef.current)
      repeatDelayRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
    heldRef.current = null
    activePointerRef.current = null
  }, [])

  const stopRepeat = useCallback(() => {
    clearTimers()
    setHeldDirection(null)
  }, [clearTimers])

  const close = useCallback(() => {
    stopRepeat()
    setIsOpen(false)
    if (wasKeyboardVisibleRef.current) {
      onRefocus?.()
    }
  }, [stopRepeat, onRefocus])

  const measure = useCallback(() => {
    const trigger = triggerRef.current
    const rect = trigger?.getBoundingClientRect?.()
    const containerRect = trigger?.closest?.('.terminal-controls')?.getBoundingClientRect?.()
    if (!rect || !containerRect) {
      setPadLeft(PAD_WIDTH / 2 + MARGIN)
      return
    }
    setPadLeft(getPadLeft(rect, containerRect))
  }, [])

  const open = useCallback(() => {
    wasKeyboardVisibleRef.current = isKeyboardVisible?.() ?? false
    measure()
    setIsOpen(true)
  }, [isKeyboardVisible, measure])

  const toggle = useCallback(() => {
    if (disabled) return
    triggerHaptic()
    if (isOpen) {
      close()
    } else {
      open()
    }
  }, [disabled, isOpen, close, open])

  const handleTriggerPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Keep focus (and the soft keyboard) where it is.
      e.preventDefault()
      lastPointerDownRef.current = Date.now()
      toggle()
    },
    [toggle]
  )

  const isSynthesizedClick = useCallback(
    () => Date.now() - lastPointerDownRef.current < CLICK_SUPPRESS_MS,
    []
  )

  // Keyboard and assistive-technology activation arrives as a click with no
  // preceding pointerdown.
  const handleTriggerClick = useCallback(
    (_e: ReactMouseEvent) => {
      if (isSynthesizedClick()) return
      toggle()
    },
    [isSynthesizedClick, toggle]
  )

  const send = useCallback((direction: ArrowDirection) => {
    if (disabledRef.current) return
    onSendKeyRef.current(ARROW_KEYS[direction])
  }, [])

  const press = useCallback(
    (direction: ArrowDirection) => {
      clearTimers()
      heldRef.current = direction
      setHeldDirection(direction)
      triggerHaptic(8)
      send(direction)
      repeatDelayRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          if (heldRef.current !== direction) return
          triggerHaptic(5)
          send(direction)
        }, REPEAT_INTERVAL)
      }, REPEAT_INITIAL_DELAY)
    },
    [clearTimers, send]
  )

  const handleArrowPointerDown = useCallback(
    (direction: ArrowDirection) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      e.preventDefault()
      // One finger at a time: a second finger must not stop or replace the
      // held arrow.
      if (activePointerRef.current !== null) return
      // Keep receiving pointer events for this press even if the finger
      // drifts off the key, so release always stops the repeat.
      e.currentTarget.setPointerCapture?.(e.pointerId)
      lastPointerDownRef.current = Date.now()
      press(direction)
      activePointerRef.current = e.pointerId
    },
    [disabled, press]
  )

  const handleArrowRelease = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      if (activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return
      stopRepeat()
    },
    [stopRepeat]
  )

  const handleArrowClick = useCallback(
    (direction: ArrowDirection) => (_e: ReactMouseEvent) => {
      if (disabled || isSynthesizedClick()) return
      triggerHaptic(8)
      send(direction)
    },
    [disabled, isSynthesizedClick, send]
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

  // A session switch mid-hold must not keep repeating into the new session.
  const previousSessionKeyRef = useRef(sessionKey)
  useEffect(() => {
    if (previousSessionKeyRef.current !== sessionKey) {
      previousSessionKeyRef.current = sessionKey
      stopRepeat()
    }
  }, [sessionKey, stopRepeat])

  // Follow the trigger if the horizontally scrollable deck scrolls while open.
  useEffect(() => {
    if (!isOpen) return
    const deck = triggerRef.current?.parentElement
    if (!deck?.addEventListener) return
    deck.addEventListener('scroll', measure, { passive: true })
    return () => deck.removeEventListener('scroll', measure)
  }, [isOpen, measure])

  // Clean up timers on unmount (no state updates here).
  useEffect(() => clearTimers, [clearTimers])

  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        aria-label="Arrow keys"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={isOpen ? clusterId : undefined}
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
        onClick={handleTriggerClick}
        disabled={disabled}
      >
        <MoveIcon width={20} height={20} />
      </button>

      {isOpen && (
        <>
          {/* Transparent backdrop over everything above the key deck: a tap
              there closes the cluster. It starts at the deck's top edge so
              Enter/Esc/Tab stay live, and there is no dimming so a menu being
              navigated stays readable. Positioned against .terminal-controls,
              which is `relative`, so it escapes the deck's overflow clipping. */}
          <div
            data-testid="arrow-keys-backdrop"
            className="absolute left-0 right-0 z-40"
            style={{ bottom: '100%', height: '100vh', touchAction: 'none' }}
            onPointerDown={handleBackdropPointerDown}
          />

          {/* Arrow cluster, floating above the deck */}
          <div
            id={clusterId}
            role="group"
            aria-label="Arrow key cluster"
            className="absolute z-50 select-none rounded-2xl bg-black/40 backdrop-blur-md border-2 border-white/20"
            style={{
              left: padLeft,
              bottom: `calc(100% + ${LIFT}px)`,
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
                  onClick={handleArrowClick(direction)}
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
