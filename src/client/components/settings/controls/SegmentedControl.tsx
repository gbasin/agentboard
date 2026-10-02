/**
 * SegmentedControl - a radio group drawn as joined square segments. The
 * selected segment gets a quiet raised fill and primary text (accent is
 * reserved for switches and focus rings). Total height matches the other
 * controls: 32px desktop, 44px phone. Roving tabindex: Tab enters on
 * the selected segment, arrow keys move and select, Home/End jump.
 */
import { useRef, type KeyboardEvent } from 'react'
import { cn } from '../../../utils/cn'

export interface SegmentOption<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  labelledBy: string
  describedBy?: string
  /** Stretch segments to fill the available width. */
  fill?: boolean
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labelledBy,
  describedBy,
  fill = false,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value))

  const select = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    refs.current[index]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    select(next)
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cn('flex border border-border bg-base p-[2px]', fill ? 'w-full' : 'w-max max-w-full')}
    >
      {options.map((option, index) => {
        const checked = index === selectedIndex
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => select(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'h-[26px] max-md:h-[38px] min-w-0 whitespace-nowrap px-3 text-[12px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              fill && 'flex-1',
              checked
                ? 'bg-hover text-primary shadow-[inset_0_0_0_1px_var(--border)]'
                : 'text-muted hover:text-primary'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
