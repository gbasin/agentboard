import { useEffect, useId, useMemo, useRef, useState } from 'react'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import type { HostStatus } from '@shared/types'

interface HostFilterDropdownProps {
  hosts: string[]
  selectedHosts: string[]
  onSelect: (hosts: string[]) => void
  statuses?: HostStatus[]
}

export default function HostFilterDropdown({
  hosts,
  selectedHosts,
  onSelect,
  statuses = [],
}: HostFilterDropdownProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedSet = useMemo(() => new Set(selectedHosts), [selectedHosts])
  const statusMap = useMemo(
    () => new Map(statuses.map((status) => [status.host, status])),
    [statuses]
  )

  const selectedTitle = useMemo(() => {
    if (selectedHosts.length === 0) return 'All Hosts'
    return selectedHosts.join(', ')
  }, [selectedHosts])

  const selectedLabel = useMemo(() => {
    if (selectedHosts.length === 0) return 'All Hosts'
    if (selectedHosts.length === 1) return selectedHosts[0]
    return `${selectedHosts.length} hosts`
  }, [selectedHosts])

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

  const toggleHost = (host: string) => {
    const next = new Set(selectedSet)
    if (next.has(host)) {
      next.delete(host)
    } else {
      next.add(host)
    }
    const ordered = hosts.filter((value) => next.has(value))
    onSelect(ordered)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Filter by host"
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 max-w-[9rem] items-center gap-1 rounded border border-border bg-base px-2 text-[11px] text-primary hover:bg-hover focus:border-accent focus:outline-none"
        title={selectedTitle}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-20 mt-1 w-48 rounded border border-border bg-surface p-2 text-xs shadow-lg"
        >
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-primary hover:bg-hover">
            <input
              type="checkbox"
              checked={selectedHosts.length === 0}
              onChange={() => onSelect([])}
              className="h-3.5 w-3.5 accent-approval"
            />
            <span>All Hosts</span>
          </label>
          <div className="my-2 h-px bg-border" />
          {hosts.length === 0 ? (
            <div className="px-2 py-1 text-muted">No hosts</div>
          ) : (
            <div className="max-h-48 overflow-y-auto pr-1">
              {hosts.map((host) => {
                const status = statusMap.get(host)
                const isOffline = status ? !status.ok : false
                return (
                  <label
                    key={host}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-primary hover:bg-hover"
                    title={status?.error ? `${host}: ${status.error}` : host}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(host)}
                      onChange={() => toggleHost(host)}
                      className="h-3.5 w-3.5 accent-approval"
                    />
                    <span className="truncate">{host}</span>
                    {isOffline && (
                      <span className="ml-auto text-[10px] uppercase text-danger">offline</span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
