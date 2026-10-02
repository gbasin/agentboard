/**
 * Settings page navigation and search box.
 *
 * Desktop: a vertical tablist (automatic activation: arrow keys move focus
 * and switch page; Home/End jump). Phone: a full-width list of pages that
 * drill in on tap, arrow keys moving focus between them.
 */
import { forwardRef, useRef, type KeyboardEvent } from 'react'
import { cn } from '../../utils/cn'
import { ICON_SIZE } from '../controlStyles'
import { ChevronRightIcon } from '../icons'
import { SETTINGS_PAGES, type SettingsPageId } from './types'

export function tabId(page: SettingsPageId): string {
  return `settings-tab-${page}`
}

/** Index to move to for a navigation key, or null if the key isn't one. */
export function navKeyTarget(key: string, index: number, count: number): number | null {
  if (key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

interface SettingsNavProps {
  variant: 'tabs' | 'list'
  /** Current page; null while search results are showing. */
  current: SettingsPageId | null
  onSelect: (page: SettingsPageId) => void
  panelId?: string
}

export function SettingsNav({ variant, current, onSelect, panelId }: SettingsNavProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const focusIndex = Math.max(0, SETTINGS_PAGES.findIndex((page) => page.id === current))

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = navKeyTarget(event.key, index, SETTINGS_PAGES.length)
    if (next === null) return
    event.preventDefault()
    refs.current[next]?.focus()
    if (variant === 'tabs') onSelect(SETTINGS_PAGES[next].id)
  }

  if (variant === 'list') {
    return (
      <nav aria-label="Settings pages">
        <ul className="divide-y divide-border border-y border-border">
          {SETTINGS_PAGES.map((page, index) => (
            <li key={page.id}>
              <button
                ref={(el) => {
                  refs.current[index] = el
                }}
                type="button"
                data-page-id={page.id}
                onClick={() => onSelect(page.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 text-left text-[15px] text-primary active:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                {page.label}
                <ChevronRightIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="text-muted" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </nav>
    )
  }

  return (
    <div role="tablist" aria-orientation="vertical" aria-label="Settings pages" className="flex flex-col gap-px">
      {SETTINGS_PAGES.map((page, index) => {
        const selected = page.id === current
        return (
          <button
            key={page.id}
            ref={(el) => {
              refs.current[index] = el
            }}
            id={tabId(page.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onSelect(page.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'flex h-[32px] w-full items-center border-l-2 px-3 text-left text-[13px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              selected
                ? 'border-primary bg-hover font-medium text-primary'
                : 'border-transparent text-secondary hover:text-primary'
            )}
          >
            {page.label}
          </button>
        )
      })}
    </div>
  )
}

interface SettingsSearchProps {
  value: string
  onChange: (value: string) => void
  className?: string
}

/** Filter box. Escape clears a non-empty query instead of closing the dialog. */
export const SettingsSearch = forwardRef<HTMLInputElement, SettingsSearchProps>(function SettingsSearch(
  { value, onChange, className },
  ref
) {
  return (
    <div className={className}>
      <label htmlFor="settings-search" className="sr-only">
        Search settings
      </label>
      <input
        ref={ref}
        id="settings-search"
        type="search"
        value={value}
        placeholder="Search settings"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault()
            onChange('')
          }
        }}
        className="input h-[32px] px-2 py-0 text-[13px] max-md:h-[44px] max-md:text-[16px] focus-visible:ring-2 focus-visible:ring-accent/40"
      />
    </div>
  )
})
