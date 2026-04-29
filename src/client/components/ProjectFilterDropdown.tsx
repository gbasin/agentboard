import { useEffect, useId, useMemo, useRef, useState } from 'react'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import FolderIcon from '@untitledui-icons/react/line/esm/FolderIcon'
import { getDisambiguatedProjectNames, getPathLeaf } from '../utils/sessionLabel'

interface ProjectFilterDropdownProps {
  projects: string[]
  selectedProjects: string[]
  onSelect: (projects: string[]) => void
  hasHiddenPermissions: boolean
}

export default function ProjectFilterDropdown({
  projects,
  selectedProjects,
  onSelect,
  hasHiddenPermissions,
}: ProjectFilterDropdownProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const displayNames = useMemo(() => getDisambiguatedProjectNames(projects), [projects])
  const selectedSet = useMemo(() => new Set(selectedProjects), [selectedProjects])
  const showDot = hasHiddenPermissions && selectedProjects.length > 0
  const selectedTitle = useMemo(() => {
    if (selectedProjects.length === 0) return 'All Projects'
    return selectedProjects
      .map((path) => displayNames.get(path) ?? getPathLeaf(path) ?? path)
      .join(', ')
  }, [displayNames, selectedProjects])
  const selectedLabel = useMemo(() => {
    if (selectedProjects.length === 0) return 'All Projects'
    if (selectedProjects.length === 1) {
      const path = selectedProjects[0]
      return displayNames.get(path) ?? getPathLeaf(path) ?? path
    }
    return `${selectedProjects.length} projects`
  }, [displayNames, selectedProjects])

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

  const toggleProject = (path: string) => {
    const next = new Set(selectedSet)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    const ordered = projects.filter((project) => next.has(project))
    onSelect(ordered)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Filter by project"
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 max-w-[11rem] items-center gap-1.5 rounded border border-border bg-base px-2 text-[11px] text-primary hover:bg-hover focus:border-accent focus:outline-none"
        title={selectedTitle}
      >
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate leading-none">{selectedLabel}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute left-0 z-20 mt-1 w-60 max-w-[calc(100vw-1.5rem)] rounded border border-border bg-surface p-2 text-xs shadow-lg"
        >
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-primary hover:bg-hover">
            <input
              type="checkbox"
              checked={selectedProjects.length === 0}
              onChange={() => onSelect([])}
              className="h-3.5 w-3.5 accent-approval"
            />
            <span>All Projects</span>
          </label>
          <div className="my-2 h-px bg-border" />
          {projects.length === 0 ? (
            <div className="px-2 py-1 text-muted">No projects</div>
          ) : (
            <div className="max-h-48 overflow-y-auto pr-1">
              {projects.map((path) => {
                const label = displayNames.get(path) ?? getPathLeaf(path) ?? path
                return (
                  <label
                    key={path}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-primary hover:bg-hover"
                    title={path}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(path)}
                      onChange={() => toggleProject(path)}
                      className="h-3.5 w-3.5 accent-approval"
                    />
                    <span className="truncate">{label}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}
      {showDot && (
        <button
          type="button"
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-approval pulse-approval ring-2 ring-elevated"
          title="Hidden sessions need attention"
          aria-label="Clear project filters"
          onClick={(event) => {
            event.stopPropagation()
            onSelect([])
          }}
        >
          <span className="sr-only">Clear project filters</span>
        </button>
      )}
    </div>
  )
}
