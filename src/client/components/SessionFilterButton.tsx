/**
 * SessionFilterButton - the session list's single filter control: a funnel
 * icon button that opens one menu with a Hosts section (only when remote
 * hosts exist) and a Projects section.
 *
 * Nothing ticked means no filter: every session shows. The menu says so in
 * a pinned summary line ("Showing all. Tick to narrow."), which becomes the
 * selection count once anything is ticked, and ends with a pinned "Show all"
 * action that clears both sections in one click. Only the checklists scroll,
 * so a long project list never pushes the summary or "Show all" out of view.
 *
 * Idle it is a plain funnel. With any filter value set the funnel turns
 * accent-colored and carries a count badge (project + host values); the
 * tooltip names what is filtered. A separate pulsing dot (bottom-right, the
 * approval color) flags a filtered-out session that needs input; clicking it
 * clears the project filters, as the old project dropdown's dot did.
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

/** Shown atop the menu when nothing is ticked (no filter applies). */
export const FILTER_IDLE_HINT = 'Showing all. Tick to narrow.'

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
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const summaryId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    if (!document.addEventListener || !document.removeEventListener) return
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (target && containerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
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
          onClick={() => setOpen((value) => !value)}
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
          aria-describedby={summaryId}
          className={`absolute left-2 right-2 z-20 ${
            placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          } flex max-h-[min(26rem,calc(100dvh-7rem))] flex-col overflow-hidden rounded border border-border bg-surface p-1.5 text-xs shadow-lg`}
        >
          {/* Pinned: what the filter does right now. */}
          <div
            id={summaryId}
            data-testid="filter-summary"
            aria-live="polite"
            className="shrink-0 text-balance px-2 pb-1 pt-1 text-[11px] leading-snug text-muted"
          >
            {isActive ? `${activeCount} selected` : FILTER_IDLE_HINT}
          </div>
          {/* Only the checklists scroll; the summary and Show all stay put. */}
          <div data-testid="filter-options" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {showHosts && (
              <FilterChecklist
                heading="Hosts"
                emptyLabel="No hosts"
                options={hosts}
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
            <FilterChecklist
              heading="Projects"
              emptyLabel="No projects"
              options={projects}
              selected={selectedProjects}
              onSelect={onSelectProjects}
              labelFor={projectLabel}
              titleFor={(path) => path}
            />
          </div>
          <div className="my-1 h-px shrink-0 bg-border" />
          <button
            type="button"
            role="menuitem"
            disabled={!isActive}
            onClick={() => {
              onSelectProjects([])
              onSelectHosts([])
            }}
            className="shrink-0 rounded px-2 py-1.5 text-left text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent"
          >
            Show all
          </button>
        </div>
      )}
    </div>
  )
}
