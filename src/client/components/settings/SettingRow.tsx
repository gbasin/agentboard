/**
 * Row primitives for the settings dialog. SettingRow lays out one registry
 * row: label (14px primary) and description (12px muted) on the left with
 * min-w-0, the control on the right with a real gap. RowList renders rows
 * separated by hairline dividers, skipping rows whose visibleWhen fails.
 */
import { useSettingsStore } from '../../stores/settingsStore'
import { cn } from '../../utils/cn'
import type { RowIds, RowTag, SettingsRowDef } from './types'

const TAG_LABEL: Record<RowTag, string> = {
  desktop: 'Desktop',
  device: 'This device',
}

const TAG_TITLE: Record<RowTag, string> = {
  desktop: 'Only affects the desktop layout',
  device: 'Stored in this browser only; not synced to other devices',
}

export function RowTagBadge({ tag }: { tag: RowTag }) {
  return (
    <span
      title={TAG_TITLE[tag]}
      className="shrink-0 border border-border px-1 py-px text-[10px] uppercase leading-none tracking-wide text-muted"
    >
      {TAG_LABEL[tag]}
    </span>
  )
}

export function rowIds(rowId: string): RowIds {
  const base = `settings-${rowId}`
  return { control: `${base}-control`, label: `${base}-label`, description: `${base}-desc` }
}

export function SettingRow({ row }: { row: SettingsRowDef }) {
  const ids = rowIds(row.id)
  const layout = row.layout ?? 'inline'
  const { Control, Description } = row

  return (
    <div
      data-setting-row={row.id}
      className={cn(
        'flex gap-x-6 gap-y-3 py-4',
        layout === 'block' && 'flex-col',
        layout === 'wide' && 'items-center max-md:flex-col max-md:items-stretch',
        layout === 'inline' && 'items-center'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label id={ids.label} htmlFor={ids.control} className="text-[14px] leading-snug text-primary">
            {row.label}
          </label>
          {row.tags?.map((tag) => <RowTagBadge key={tag} tag={tag} />)}
        </div>
        <div id={ids.description} className="mt-1 text-[12px] leading-snug text-muted text-pretty">
          {Description ? <Description /> : row.description}
        </div>
      </div>
      <div className={cn('flex min-w-0 items-center gap-2', layout === 'inline' ? 'shrink-0' : 'max-w-full')}>
        <Control ids={ids} />
      </div>
    </div>
  )
}

/** True when the row should render for the given settings state. */
export function isRowVisible(row: SettingsRowDef, state: ReturnType<typeof useSettingsStore.getState>): boolean {
  return row.visibleWhen ? row.visibleWhen(state) : true
}

export function RowList({ rows }: { rows: readonly SettingsRowDef[] }) {
  // Subscribe to exactly the visibility outcome so unrelated store writes
  // don't re-render the whole list.
  const visibleKey = useSettingsStore((state) =>
    rows.map((row) => (isRowVisible(row, state) ? '1' : '0')).join('')
  )
  const visible = rows.filter((_, index) => visibleKey[index] === '1')
  return (
    <div className="divide-y divide-border">
      {visible.map((row) => (
        <SettingRow key={row.id} row={row} />
      ))}
    </div>
  )
}
