import { useEffect, useId, useMemo, useRef, useState } from 'react'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import type { SessionStatus } from '@shared/types'

const STATUS_OPTIONS: { value: SessionStatus; label: string; dotClass: string }[] = [
    { value: 'working', label: 'Working', dotClass: 'bg-green-500' },
    { value: 'waiting', label: 'Waiting', dotClass: 'bg-zinc-400' },
    { value: 'permission', label: 'Permission', dotClass: 'bg-amber-500' },
    { value: 'unknown', label: 'Unknown', dotClass: 'bg-zinc-400' },
]

interface StatusFilterDropdownProps {
    selectedStatuses: SessionStatus[]
    onSelect: (statuses: SessionStatus[]) => void
}

export default function StatusFilterDropdown({
    selectedStatuses,
    onSelect,
}: StatusFilterDropdownProps) {
    const [open, setOpen] = useState(false)
    const menuId = useId()
    const containerRef = useRef<HTMLDivElement>(null)
    const selectedSet = useMemo(() => new Set(selectedStatuses), [selectedStatuses])

    const selectedTitle = useMemo(() => {
        if (selectedStatuses.length === 0) return 'All Status'
        return selectedStatuses
            .map((s) => STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s)
            .join(', ')
    }, [selectedStatuses])

    const selectedLabel = useMemo(() => {
        if (selectedStatuses.length === 0) return 'All Status'
        if (selectedStatuses.length === 1) {
            return STATUS_OPTIONS.find((o) => o.value === selectedStatuses[0])?.label ?? selectedStatuses[0]
        }
        return `${selectedStatuses.length} statuses`
    }, [selectedStatuses])

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

    const toggleStatus = (status: SessionStatus) => {
        const next = new Set(selectedSet)
        if (next.has(status)) {
            next.delete(status)
        } else {
            next.add(status)
        }
        const ordered = STATUS_OPTIONS
            .map((o) => o.value)
            .filter((v) => next.has(v))
        onSelect(ordered)
    }

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                aria-label="Filter by status"
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
                    className="absolute right-0 z-20 mt-1 w-44 rounded border border-border bg-surface p-2 text-xs shadow-lg"
                >
                    <label
                        role="menuitemcheckbox"
                        aria-checked={selectedStatuses.length === 0}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-primary hover:bg-hover"
                    >
                        <input
                            type="checkbox"
                            checked={selectedStatuses.length === 0}
                            onChange={() => onSelect([])}
                            className="h-3.5 w-3.5 accent-approval"
                        />
                        <span>All Status</span>
                    </label>
                    <div className="my-2 h-px bg-border" />
                    <div className="max-h-48 overflow-y-auto pr-1">
                        {STATUS_OPTIONS.map((option) => (
                            <label
                                key={option.value}
                                role="menuitemcheckbox"
                                aria-checked={selectedSet.has(option.value)}
                                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-primary hover:bg-hover"
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedSet.has(option.value)}
                                    onChange={() => toggleStatus(option.value)}
                                    className="h-3.5 w-3.5 accent-approval"
                                />
                                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${option.dotClass}`} />
                                <span className="truncate">{option.label}</span>
                            </label>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
