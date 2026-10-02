/**
 * Numeric settings controls that apply on every change: a -/+ stepper and a
 * range slider with a value readout. Both clamp to their bounds, so an
 * out-of-range value can never be written.
 */
import { cn } from '../../../utils/cn'
import { ICON_SIZE } from '../../controlStyles'
import { MinusIcon, PlusIcon } from '../../icons'
import { CONTROL_HEIGHT, CONTROL_ICON_BUTTON } from '../styles'

interface StepperProps {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  /** Accessible noun for the buttons, e.g. "font size". */
  noun: string
  labelledBy: string
  describedBy?: string
}

export function Stepper({ value, min, max, onChange, noun, labelledBy, describedBy }: StepperProps) {
  return (
    <div role="group" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex items-center">
      <button
        type="button"
        className={CONTROL_ICON_BUTTON}
        aria-label={`Decrease ${noun}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <MinusIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
      </button>
      <output
        aria-live="polite"
        className={cn(CONTROL_HEIGHT, 'flex w-10 items-center justify-center border-y border-border bg-base text-[13px] tabular-nums text-primary')}
      >
        {value}
      </output>
      <button
        type="button"
        className={CONTROL_ICON_BUTTON}
        aria-label={`Increase ${noun}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <PlusIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
      </button>
    </div>
  )
}

interface SliderProps {
  id: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format: (value: number) => string
  labelledBy: string
  describedBy?: string
}

export function Slider({ id, value, min, max, step, onChange, format, labelledBy, describedBy }: SliderProps) {
  return (
    <div className={cn(CONTROL_HEIGHT, 'flex items-center gap-3')}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-valuetext={format(value)}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value)
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)))
        }}
        className="h-1 w-28 max-md:w-36 cursor-pointer appearance-none bg-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span className="w-10 text-right text-[13px] tabular-nums text-secondary">{format(value)}</span>
    </div>
  )
}
