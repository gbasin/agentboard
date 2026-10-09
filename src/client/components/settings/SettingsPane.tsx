/**
 * Right-hand content of the settings dialog: one page's rows, or search
 * results grouped under their page names (fully interactive), or an empty
 * state when nothing matches.
 */
import { useMemo } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { groupByPage, rowsForPage, searchRows } from './registry'
import { RowList, isRowVisible } from './SettingRow'
import { getPageLabel, type SettingsPageId } from './types'

export function PageView({ page, showTitle }: { page: SettingsPageId; showTitle: boolean }) {
  const rows = useMemo(() => rowsForPage(page), [page])
  return (
    <section aria-labelledby={showTitle ? `settings-page-${page}-title` : undefined}>
      {showTitle && (
        <h3 id={`settings-page-${page}-title`} className="pb-1 text-[18px] font-semibold leading-tight text-primary">
          {getPageLabel(page)}
        </h3>
      )}
      <RowList rows={rows} />
    </section>
  )
}

export function SearchResults({ query }: { query: string }) {
  const matches = useMemo(() => searchRows(query), [query])
  // Re-evaluated on store changes so a row hidden by its visibleWhen (e.g.
  // sort direction outside Created) doesn't count as a match.
  const anyVisible = useSettingsStore((state) => matches.some((row) => isRowVisible(row, state)))
  const groups = useMemo(() => groupByPage(matches), [matches])

  if (!anyVisible) {
    return (
      <div role="status" className="flex flex-col items-center gap-1 py-16 text-center">
        <p className="text-[14px] text-primary">No settings match “{query.trim()}”</p>
        <p className="text-[12px] text-muted">Try a different word, like “font” or “sound”.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <GroupSection key={group.page} label={group.label} rows={group.rows} />
      ))}
    </div>
  )
}

function GroupSection({ label, rows }: { label: string; rows: ReturnType<typeof searchRows> }) {
  const anyVisible = useSettingsStore((state) => rows.some((row) => isRowVisible(row, state)))
  if (!anyVisible) return null
  return (
    <section aria-label={label}>
      <h3 className="border-b border-border pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        {label}
      </h3>
      <RowList rows={rows} />
    </section>
  )
}
