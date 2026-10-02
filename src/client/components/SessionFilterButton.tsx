/**
 * SessionFilterButton - the session list's single filter control: a funnel
 * icon button that opens one menu with a Hosts section (only when remote
 * hosts exist) and a Projects section.
 *
 * The menu is a plain checklist, as in Linear or GitHub: nothing ticked
 * means no filter, and the funnel (accent color, count badge) shows when a
 * filter applies. A pinned header row holds the menu's title and, only
 * while a filter is active, a "Clear" action that empties both sections;
 * the row is always there, so the menu does not jump when Clear appears.
 *
 * Past FILTER_SEARCH_THRESHOLD options a pinned search field narrows the
 * rows (case-insensitive substring of the displayed label; ticked rows stay
 * visible so a selection is never hidden). Escape clears the search first
 * and closes the menu on a second press. The field takes focus on open
 * only for fine pointers, so a phone keyboard does not pop up uninvited.
 * Only the checklists scroll; the header and search stay put.
 *
 * Idle the trigger is a plain funnel. With any filter value set the funnel
 * turns accent-colored and carries a count badge (project + host values);
 * the tooltip names what is filtered. A separate pulsing dot (bottom-right,
 * the approval color) flags a filtered-out session that needs input;
 * clicking it clears the project filters, as the old project dropdown's dot
 * did.
 *
 * The menu is positioned against the filter bar (the nearest positioned
 * ancestor; this component adds none), spanning the bar's width, so it
 * never overflows a narrow sidebar or the mobile drawer.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { HostStatus } from '@shared/types'
import { getDisambiguatedProjectNames, getPathLeaf } from '../utils/sessionLabel'
import { ICON_SIZE, TOUCH_TARGET_CLASS, iconButtonClass } from './controlStyles'
import { FilterFunnel02Icon } from './icons'
import FilterChecklist from './FilterChecklist'

/** The search field shows when hosts + projects exceed this many options. */
export const FILTER_SEARCH_THRESHOLD = 8

/**
 * Case-insensitive substring match of a displayed label against the typed
 * query. Plain string matching: the query is never interpreted as a pattern.
 */
export function matchesFilterQuery(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || label.toLowerCase().includes(needle)
}

/** True on touch-first devices, where focusing a field opens the keyboard. */
function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
}

interface SessionFilterButtonProps {
  projects: string[]
  selectedProjects: string[]
  onSelectProjects: (projects: string[]) => void
  /** Hosts to offer; the Hosts section renders only when showHosts is true. */
  hosts: string[]
  selectedHosts: string[]
  onSelectHosts: (hosts: string[]) => void
  hostStatuses?: HostStatus[]
  showHosts: boolean
  /** A session hidden by the project filter is waiting for input. */
  hasHiddenPermissions: boolean
  /** 'up' opens the menu above the bar (bottom-anchored sidebar). */
  placement?: 'down' | 'up'
}

export default function SessionFilterButton({
  projects,
  selectedProjects,
  onSelectProjects,
  hosts,
  selectedHosts,
  onSelectHosts,
  hostStatuses = [],
  showHosts,
  hasHiddenPermissions,
  placement = 'down',
}: SessionFilterButtonProps) {
  const [open, setOpenState] = useState(false)
  const [query, setQuery] = useState('')
  const menuId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Read by the document keydown listener without re-subscribing per key.
  const queryRef = useRef(query)
  queryRef.current = query
  // Closing (or reopening) always starts from an empty search.
  const setOpen = (next: boolean) => {
    setOpenState(next)
    setQuery('')
  }
  const displayNames = useMemo(() => getDisambiguatedProjectNames(projects), [projects])
  const statusMap = useMemo(
    () => new Map(hostStatuses.map((status) => [status.host, status])),
    [hostStatuses]
  )
  const projectLabel = (path: string) => displayNames.get(path) ?? getPathLeaf(path) ?? path

  const activeCount = selectedProjects.length + selectedHosts.length
  const isActive = activeCount > 0
  const showDot = hasHiddenPermissions && selectedProjects.length > 0

  let title = 'Filter'
  if (isActive) {
    const parts: string[] = []
    if (selectedProjects.length > 0) {
      parts.push(`Projects: ${selectedProjects.map(projectLabel).join(', ')}`)
    }
    if (selectedHosts.length > 0) parts.push(`Hosts: ${selectedHosts.join(', ')}`)
    title = `Filtered by ${parts.join('; ')}`
  }
  const ariaLabel = isActive
    ? `Filter, ${activeCount} active filter${activeCount === 1 ? '' : 's'}`
    : 'Filter'

  const optionCount = projects.length + (showHosts ? hosts.length : 0)
  const showSearch = optionCount > FILTER_SEARCH_THRESHOLD
  const activeQuery = showSearch ? query : ''
  const searching = activeQuery.trim() !== ''
  // Ticked rows always stay visible, so a selection is never hidden.
  const narrow = (options: string[], selected: string[], labelFor: (option: string) => string) => {
    if (!searching) return options
    const keep = new Set(selected)
    return options.filter((option) => keep.has(option) || matchesFilterQuery(labelFor(option), activeQuery))
  }
  const visibleHosts = showHosts ? narrow(hosts, selectedHosts, (host) => host) : []
  const visibleProjects = narrow(projects, selectedProjects, projectLabel)
  // While searching, a section with no matching rows is left out entirely.
  const renderHosts = showHosts && (!searching || visibleHosts.length > 0)
  const renderProjects = !searching || visibleProjects.length > 0

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    if (!document.addEventListener || !document.removeEventListener) return
    const close = () => {
      setOpenState(false)
      setQuery('')
    }
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (target && containerRef.current?.contains(target)) return
      close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // First Escape clears the search text; the next one closes the menu.
      if (queryRef.current !== '') {
        setQuery('')
        return
      }
      close()
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('touchstart', handlePointer, { passive: true })
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('touchstart', handlePointer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // Desktop: typing goes straight to the search. Touch: no uninvited keyboard.
  useEffect(() => {
    if (open && !isCoarsePointer()) searchRef.current?.focus()
  }, [open])

  return (
    // Deliberately not `relative`: the menu positions against the filter bar.
    <div ref={containerRef} className="flex shrink-0">
      <span className="relative inline-flex">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={ariaLabel}
          title={title}
          onClick={() => setOpen(!open)}
          // 44px touch target on coarse pointers (mobile drawer).
          className={`${iconButtonClass(isActive ? 'active' : 'neutral')} ${TOUCH_TARGET_CLASS}`}
        >
          <FilterFunnel02Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
          {isActive && (
            <span
              data-testid="filter-count-badge"
              aria-hidden="true"
              className="pointer-events-none absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white"
            >
              {activeCount}
            </span>
          )}
        </button>
        {showDot && (
          <button
            type="button"
            data-testid="hidden-attention-dot"
            className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full bg-approval pulse-approval ring-2 ring-elevated"
            title="Hidden sessions need attention"
            aria-label="Clear project filters"
            onClick={(event) => {
              event.stopPropagation()
              onSelectProjects([])
            }}
          >
            <span className="sr-only">Clear project filters</span>
          </button>
        )}
      </span>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Filter sessions"
          className={`absolute left-2 right-2 z-20 ${
            placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          } flex max-h-[min(26rem,calc(100dvh-7rem))] flex-col overflow-hidden rounded border border-border bg-surface p-1.5 text-xs shadow-lg`}
        >
          {/* Pinned header: always present, so Clear appearing never shifts rows. */}
          <div
            data-testid="filter-header"
            className="flex h-[26px] shrink-0 items-center justify-between gap-2 [@media(pointer:coarse)]:h-[44px]"
          >
            <span className="truncate pl-2 text-[11px] font-medium text-secondary">
              Filter
            </span>
            {isActive && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelectProjects([])
                  onSelectHosts([])
                }}
                // Full row height: 26px on desktop, 44x44 on coarse pointers.
                className="h-full shrink-0 rounded px-2 text-accent hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [@media(pointer:coarse)]:min-w-[44px]"
              >
                Clear
              </button>
            )}
          </div>
          {showSearch && (
            <div className="shrink-0 px-1 pb-1 pt-0.5">
              <input
                ref={searchRef}
                type="search"
                aria-label="Search filters"
                placeholder="Search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                // 16px on touch devices keeps iOS from zooming on focus.
                className="w-full rounded border border-border bg-base px-2 py-1 text-xs text-primary placeholder:text-muted focus:border-accent focus:outline-none [@media(pointer:coarse)]:text-[16px]"
              />
            </div>
          )}
          {/* Only the checklists scroll; the header and search stay put. */}
          <div data-testid="filter-options" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {renderHosts && (
              <FilterChecklist
                heading="Hosts"
                emptyLabel="No hosts"
                options={hosts}
                visibleOptions={visibleHosts}
                selected={selectedHosts}
                onSelect={onSelectHosts}
                labelFor={(host) => host}
                titleFor={(host) => {
                  const status = statusMap.get(host)
                  return status?.error ? `${host}: ${status.error}` : host
                }}
                noteFor={(host) => {
                  const status = statusMap.get(host)
                  return status && !status.ok ? 'offline' : null
                }}
              />
            )}
            {renderProjects && (
              <FilterChecklist
                heading="Projects"
                emptyLabel="No projects"
                options={projects}
                visibleOptions={visibleProjects}
                selected={selectedProjects}
                onSelect={onSelectProjects}
                labelFor={projectLabel}
                titleFor={(path) => path}
              />
            )}
            {!renderHosts && !renderProjects && (
              <div data-testid="filter-no-matches" className="px-2 py-1.5 text-muted">
                No matches
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
