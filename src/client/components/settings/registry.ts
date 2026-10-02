/**
 * The settings row registry: every row the dialog can show, in page order,
 * plus the queries the dialog runs over it (rows for a page, search grouped
 * by page). Visibility is applied by RowList at render time.
 */
import { appearanceRows } from './rows/appearanceRows'
import { newSessionRows } from './rows/newSessionRows'
import { notificationRows } from './rows/notificationRows'
import { sessionListRows } from './rows/sessionListRows'
import { terminalRows } from './rows/terminalRows'
import { SETTINGS_PAGES, type SettingsPageId, type SettingsRowDef } from './types'

export const SETTINGS_ROWS: readonly SettingsRowDef[] = [
  ...newSessionRows,
  ...sessionListRows,
  ...appearanceRows,
  ...terminalRows,
  ...notificationRows,
]

export function rowsForPage(
  page: SettingsPageId,
  rows: readonly SettingsRowDef[] = SETTINGS_ROWS
): SettingsRowDef[] {
  return rows.filter((row) => row.page === page)
}

function haystack(row: SettingsRowDef): string {
  return [row.label, row.description, ...(row.keywords ?? [])].join(' ').toLowerCase()
}

/**
 * Rows whose label, description or keywords contain every whitespace-
 * separated term of `query` (case-insensitive). Empty query matches nothing.
 */
export function searchRows(
  query: string,
  rows: readonly SettingsRowDef[] = SETTINGS_ROWS
): SettingsRowDef[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  return rows.filter((row) => {
    const text = haystack(row)
    return terms.every((term) => text.includes(term))
  })
}

export interface RowGroup {
  page: SettingsPageId
  label: string
  rows: SettingsRowDef[]
}

/** Group rows under their page, in page order, dropping empty pages. */
export function groupByPage(rows: readonly SettingsRowDef[]): RowGroup[] {
  return SETTINGS_PAGES.map((page) => ({
    page: page.id,
    label: page.label,
    rows: rows.filter((row) => row.page === page.id),
  })).filter((group) => group.rows.length > 0)
}
