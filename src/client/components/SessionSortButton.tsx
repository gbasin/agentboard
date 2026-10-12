/** Sidebar sort menu. Shares saved preferences with Settings; first is nearest the sidebar anchor. */
import { useEffect, useId, useRef } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { ICON_SIZE, TOUCH_TARGET_CLASS, iconButtonClass } from './controlStyles'
import { CheckIcon, SwitchVertical01Icon } from './icons'

const options = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'status', label: 'Needs attention', description: 'Approval requests first, then recent activity.' },
  { id: 'manual', label: 'Manual order', description: 'Drag sessions to reorder.' },
] as const

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  placement?: 'down' | 'up'
}

export default function SessionSortButton({ open, onOpenChange, placement = 'down' }: Props) {
  const mode = useSettingsStore((state) => state.sessionSortMode)
  const direction = useSettingsStore((state) => state.sessionSortDirection)
  const selected = mode === 'created' ? (direction === 'desc' ? 'newest' : 'oldest') : mode
  const label = options.find((option) => option.id === selected)!.label
  const menuId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const close = (restoreFocus = false) => {
    onOpenChange(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    itemRefs.current[options.findIndex((option) => option.id === selected)]?.focus()
  }, [open, selected])

  useEffect(() => {
    if (!open || typeof document === 'undefined' || !document.addEventListener) return
    const outside = (event: MouseEvent | TouchEvent) => {
      if (event.target && !containerRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('touchstart', outside, { passive: true })
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('touchstart', outside)
    }
  }, [open, onOpenChange])

  return (
    <div ref={containerRef} className="flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        title={`Sort: ${label}`}
        aria-label={`Sort: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`${iconButtonClass()} ${TOUCH_TARGET_CLASS}`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            onOpenChange(true)
          }
        }}
      >
        <SwitchVertical01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Sort sessions"
          className={`absolute left-2 right-2 z-20 ${placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} rounded border border-border bg-surface p-1.5 text-xs shadow-lg`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close(true)
            } else if (event.key === 'Tab') {
              close()
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
              itemRefs.current[next]?.focus()
            }
          }}
        >
          <div className="px-2 py-1.5 text-[11px] font-medium text-secondary">Sort sessions</div>
          {options.map((option, index) => (
            <button
              key={option.id}
              ref={(node) => { itemRefs.current[index] = node }}
              type="button"
              role="menuitemradio"
              aria-checked={selected === option.id}
              tabIndex={-1}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-primary hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:items-center"
              onClick={() => {
                const next = option.id === 'newest' || option.id === 'oldest'
                  ? { sessionSortMode: 'created' as const, sessionSortDirection: option.id === 'newest' ? 'desc' as const : 'asc' as const }
                  : { sessionSortMode: option.id }
                useSettingsStore.setState(next)
                close(true)
              }}
            >
              <span className="flex w-[14px] shrink-0 pt-0.5" aria-hidden="true">
                {selected === option.id && <CheckIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />}
              </span>
              <span>
                <span className="block">{option.label}</span>
                {'description' in option && <span className="mt-0.5 block text-[11px] text-secondary">{option.description}</span>}
              </span>
            </button>
          ))}
          {placement === 'up' && <div className="px-2 py-1.5 text-[11px] text-secondary">First items sit nearest the bottom controls.</div>}
        </div>
      )}
    </div>
  )
}
