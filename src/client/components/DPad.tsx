/**
 * DPad - Virtual joystick for mobile terminal navigation and scrolling
 * Tap to toggle between cursor mode (arrow keys) and scroll mode (tmux scroll)
 * Long press to activate joystick, drag in any direction to send keys/scroll
 */

import { useState, useRef, useCallback, useEffect, type TouchEvent } from 'react'
import { MoveIcon } from '@untitledui-icons/react/line'

export type DPadMode = 'cursor' | 'scroll'

interface DPadProps {
  onSendKey: (key: string) => void
  onSendScroll?: (direction: 'up' | 'down') => void
  disabled?: boolean
  onRefocus?: () => void
  isKeyboardVisible?: () => boolean
}

// Arrow key escape sequences
const ARROW_KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
} as const

export type Direction = keyof typeof ARROW_KEYS | null

const LONG_PRESS_DELAY = 150 // ms to trigger joystick
const REPEAT_INITIAL_DELAY = 250 // ms before auto-repeat starts
const REPEAT_INTERVAL_MIN = 400 // ms between keys at max distance (fast)
const REPEAT_INTERVAL_MAX = 1500 // ms between keys at min distance (slow)
const DEAD_ZONE = 15 // pixels from center before direction registers
const JOYSTICK_RADIUS = 70 // visual radius of joystick
const TAP_MAX_DURATION = 200 // ms - taps shorter than this toggle mode

function triggerHaptic(intensity: number = 10) {
  if ('vibrate' in navigator) {
    navigator.vibrate(intensity)
  }
}

// Calculate direction and distance from center point
export function getDirectionAndDistance(
  dx: number,
  dy: number
): { direction: Direction; distance: number } {
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance < DEAD_ZONE) return { direction: null, distance: 0 }

  const angle = Math.atan2(dy, dx) * (180 / Math.PI)

  // Divide into 4 quadrants: -45 to 45 = right, 45 to 135 = down, etc.
  let direction: Direction
  if (angle >= -45 && angle < 45) direction = 'right'
  else if (angle >= 45 && angle < 135) direction = 'down'
  else if (angle >= -135 && angle < -45) direction = 'up'
  else direction = 'left'

  return { direction, distance }
}

// Calculate repeat interval based on distance (further = faster)
export function getRepeatInterval(distance: number): number {
  const maxDistance = JOYSTICK_RADIUS - 20
  const normalizedDistance = Math.min(distance / maxDistance, 1)
  // Interpolate: at distance 0 -> MAX interval (slow), at max distance -> MIN interval (fast)
  return REPEAT_INTERVAL_MAX - normalizedDistance * (REPEAT_INTERVAL_MAX - REPEAT_INTERVAL_MIN)
}

// Scroll icon - vertical double arrows
const ScrollIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="7 4 12 0 17 4" />
    <line x1="12" y1="0" x2="12" y2="24" />
    <polyline points="7 20 12 24 17 20" />
  </svg>
)

export default function DPad({
  onSendKey,
  onSendScroll,
  disabled = false,
  onRefocus,
  isKeyboardVisible,
}: DPadProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [mode, setMode] = useState<DPadMode>('cursor')
  const [activeDirection, setActiveDirection] = useState<Direction>(null)
  const [joystickCenter, setJoystickCenter] = useState({ x: 0, y: 0 })
  const [knobOffset, setKnobOffset] = useState({ x: 0, y: 0 })

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)
  const touchStartTimeRef = useRef(0)
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wasKeyboardVisibleRef = useRef(false)
  const currentDirectionRef = useRef<Direction>(null)
  const currentDistanceRef = useRef(0)
  const modeRef = useRef<DPadMode>('cursor')

  // Keep modeRef in sync
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  // Clean up all timers
  const clearAllTimers = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])

  // Stop auto-repeat
  const stopKeyRepeat = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])

  // Schedule next repeat based on current distance and mode
  const scheduleNextRepeat = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
    const interval = getRepeatInterval(currentDistanceRef.current)
    repeatIntervalRef.current = setTimeout(() => {
      if (currentDirectionRef.current) {
        triggerHaptic(5)
        if (modeRef.current === 'scroll') {
          if (direction === 'up' || direction === 'down') {
            onSendScroll?.(direction)
          }
        } else {
          onSendKey(ARROW_KEYS[direction])
        }
        scheduleNextRepeat(direction)
      }
    }, interval) as unknown as ReturnType<typeof setInterval>
  }, [onSendKey, onSendScroll])

  // Start sending a direction with auto-repeat
  const startDirection = useCallback((direction: Direction, distance: number) => {
    if (!direction || disabled) return

    // In scroll mode, ignore left/right
    if (modeRef.current === 'scroll' && (direction === 'left' || direction === 'right')) {
      return
    }

    currentDistanceRef.current = distance
    triggerHaptic(8)

    if (modeRef.current === 'scroll') {
      onSendScroll?.(direction as 'up' | 'down')
    } else {
      onSendKey(ARROW_KEYS[direction])
    }

    // Clear any existing repeat timers
    stopKeyRepeat()

    // Start auto-repeat after initial delay
    repeatTimerRef.current = setTimeout(() => {
      scheduleNextRepeat(direction)
    }, REPEAT_INITIAL_DELAY)
  }, [disabled, onSendKey, onSendScroll, stopKeyRepeat, scheduleNextRepeat])

  // Update direction based on finger position
  const updateDirection = useCallback((clientX: number, clientY: number) => {
    const dx = clientX - joystickCenter.x
    const dy = clientY - joystickCenter.y

    // Clamp knob position to joystick radius
    const rawDistance = Math.sqrt(dx * dx + dy * dy)
    const clampedDistance = Math.min(rawDistance, JOYSTICK_RADIUS - 20)
    const scale = rawDistance > 0 ? clampedDistance / rawDistance : 0

    setKnobOffset({ x: dx * scale, y: dy * scale })

    const { direction: newDirection, distance } = getDirectionAndDistance(dx, dy)

    // Always update distance for repeat rate adjustment
    currentDistanceRef.current = distance

    if (newDirection !== currentDirectionRef.current) {
      currentDirectionRef.current = newDirection
      setActiveDirection(newDirection)
      stopKeyRepeat()
      if (newDirection) {
        startDirection(newDirection, distance)
      }
    }
  }, [joystickCenter, stopKeyRepeat, startDirection])

  // Close the joystick
  const closeJoystick = useCallback(() => {
    setIsOpen(false)
    setActiveDirection(null)
    setKnobOffset({ x: 0, y: 0 })
    stopKeyRepeat()
    currentDirectionRef.current = null

    if (wasKeyboardVisibleRef.current) {
      onRefocus?.()
    }
  }, [stopKeyRepeat, onRefocus])

  // Handle touch start on trigger button
  const handleTriggerTouchStart = useCallback((e: TouchEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()

    const touch = e.touches[0]
    wasKeyboardVisibleRef.current = isKeyboardVisible?.() ?? false
    longPressFiredRef.current = false
    touchStartTimeRef.current = performance.now()

    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true
      triggerHaptic(15)
      // Position joystick centered above the touch point
      setJoystickCenter({ x: touch.clientX, y: touch.clientY - 80 })
      setKnobOffset({ x: 0, y: 0 })
      setIsOpen(true)
    }, LONG_PRESS_DELAY)
  }, [disabled, isKeyboardVisible])

  // Handle touch move
  const handleTouchMove = useCallback((e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (!isOpen) return

    const touch = e.touches[0]
    updateDirection(touch.clientX, touch.clientY)
  }, [isOpen, updateDirection])

  // Handle touch end
  const handleTouchEnd = useCallback((e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    if (isOpen) {
      closeJoystick()
    } else if (!longPressFiredRef.current) {
      // Short tap — toggle mode
      const tapDuration = performance.now() - touchStartTimeRef.current
      if (tapDuration < TAP_MAX_DURATION) {
        triggerHaptic(10)
        setMode(prev => prev === 'cursor' ? 'scroll' : 'cursor')
      }
    }
  }, [isOpen, closeJoystick])

  // Handle touch cancel
  const handleTouchCancel = useCallback((e: TouchEvent) => {
    e.preventDefault()
    clearAllTimers()
    closeJoystick()
  }, [clearAllTimers, closeJoystick])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearAllTimers()
    }
  }, [clearAllTimers])

  // Direction arrow indicators
  const directionArrows = [
    { dir: 'up' as const, angle: -90, label: '↑' },
    { dir: 'right' as const, angle: 0, label: '→' },
    { dir: 'down' as const, angle: 90, label: '↓' },
    { dir: 'left' as const, angle: 180, label: '←' },
  ]

  const isScrollMode = mode === 'scroll'

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        aria-label={isScrollMode ? 'Scroll mode (tap to switch to cursor)' : 'Cursor mode (tap to switch to scroll)'}
        className={`
          terminal-key
          flex items-center justify-center
          h-11 min-w-[2.75rem] px-2.5
          text-sm font-medium
          rounded-md
          active:scale-95
          transition-all duration-75
          select-none
          ${disabled ? 'opacity-50' : ''}
          ${isOpen ? 'scale-95' : ''}
          ${isScrollMode
            ? 'bg-accent/20 text-accent border border-accent/40'
            : 'bg-surface border border-border text-secondary active:bg-hover'}
        `}
        style={{ touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
        onTouchStart={handleTriggerTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        disabled={disabled}
      >
        {isScrollMode ? ScrollIcon : <MoveIcon width={20} height={20} />}
      </button>

      {/* Joystick overlay - renders in portal position */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{ touchAction: 'none' }}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
        >
          {/* Semi-transparent backdrop */}
          <div className="absolute inset-0 bg-black/20" />

          {/* Joystick container */}
          <div
            className="absolute"
            style={{
              left: joystickCenter.x,
              top: joystickCenter.y,
              transform: 'translate(-50%, -50%)',
            }}
          >
            {/* Outer ring */}
            <div
              className="relative rounded-full bg-black/40 backdrop-blur-md border-2 border-white/20"
              style={{
                width: JOYSTICK_RADIUS * 2,
                height: JOYSTICK_RADIUS * 2,
              }}
            >
              {/* Direction indicators */}
              {directionArrows.map(({ dir, angle, label }) => {
                const isHorizontal = dir === 'left' || dir === 'right'
                const dimmed = isScrollMode && isHorizontal
                return (
                  <div
                    key={dir}
                    className={`
                      absolute text-2xl font-bold
                      transition-all duration-75
                      ${dimmed
                        ? 'text-white/15'
                        : activeDirection === dir
                          ? 'text-accent scale-125'
                          : 'text-white/60'}
                    `}
                    style={{
                      left: '50%',
                      top: '50%',
                      transform: `
                        translate(-50%, -50%)
                        rotate(${angle}deg)
                        translateX(${JOYSTICK_RADIUS - 25}px)
                        rotate(${-angle}deg)
                      `,
                    }}
                  >
                    {label}
                  </div>
                )
              })}

              {/* Center knob */}
              <div
                className={`
                  absolute w-12 h-12 rounded-full
                  bg-white/90 shadow-lg
                  border-2 transition-colors duration-75
                  ${activeDirection ? 'border-accent bg-accent/20' : 'border-white/40'}
                `}
                style={{
                  left: '50%',
                  top: '50%',
                  transform: `translate(calc(-50% + ${knobOffset.x}px), calc(-50% + ${knobOffset.y}px))`,
                }}
              >
                {/* Knob inner detail */}
                <div className="absolute inset-2 rounded-full bg-white/50" />
              </div>
            </div>

            {/* Direction label */}
            {activeDirection && (
              <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-white text-sm font-medium bg-black/50 px-3 py-1 rounded-full">
                {isScrollMode ? `SCROLL ${activeDirection.toUpperCase()}` : activeDirection.toUpperCase()}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
