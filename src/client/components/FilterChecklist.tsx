/**
 * FilterChecklist - one section of the session filter menu: a heading and a
 * multi-select checkbox per option. Nothing ticked means no filter on this
 * dimension; the menu's shared "Clear" action clears every section.
 * Selections are reported in `options` order, as the old per-dimension
 * dropdowns did.
 *
 * `visibleOptions` (default: all of `options`) is the subset the menu's
 * search currently shows; toggling still works against the full list, so a
 * hidden selection is never dropped.
 */

import { useId } from 'react'

interface FilterChecklistProps {
  heading: string
  emptyLabel: string
  options: string[]
  /** Rows to render (a subset of options, in options order). */
  visibleOptions?: string[]
  selected: string[]
  onSelect: (next: string[]) => void
  labelFor: (option: string) => string
  titleFor?: (option: string) => string
  /** Short trailing note for an option (e.g. "offline"), or null. */
  noteFor?: (option: string) => string | null
}

const rowClass =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-primary hover:bg-hover'
const checkboxClass = 'h-3.5 w-3.5 shrink-0 accent-approval'

export default function FilterChecklist({
  heading,
  emptyLabel,
  options,
  visibleOptions = options,
  selected,
  onSelect,
  labelFor,
  titleFor,
  noteFor,
}: FilterChecklistProps) {
  const headingId = useId()
  const selectedSet = new Set(selected)

  const toggle = (option: string) => {
    const next = new Set(selectedSet)
    if (next.has(option)) {
      next.delete(option)
    } else {
      next.add(option)
    }
    onSelect(options.filter((value) => next.has(value)))
  }

  return (
    <div role="group" aria-labelledby={headingId} className="shrink-0 pb-1">
      <div
        id={headingId}
        className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted"
      >
        {heading}
      </div>
      {options.length === 0 ? (
        <div className="px-2 py-1 text-muted">{emptyLabel}</div>
      ) : (
        visibleOptions.map((option) => {
          const note = noteFor?.(option) ?? null
          return (
            <label
              key={option}
              role="menuitemcheckbox"
              aria-checked={selectedSet.has(option)}
              className={rowClass}
              title={titleFor?.(option)}
            >
              <input
                type="checkbox"
                checked={selectedSet.has(option)}
                onChange={() => toggle(option)}
                className={checkboxClass}
              />
              <span className="min-w-0 truncate">{labelFor(option)}</span>
              {note && (
                <span className="ml-auto shrink-0 text-[10px] uppercase text-danger">{note}</span>
              )}
            </label>
          )
        })
      )}
    </div>
  )
}
