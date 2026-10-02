/**
 * Settings dialog model: the pages and the row definition every setting is
 * registered with. Pages are not hand-laid; each renders the rows from the
 * registry (registry.ts) whose `page` matches, and search filters the same
 * list, so a row is defined exactly once.
 */
import type { ComponentType } from 'react'
import type { useSettingsStore } from '../../stores/settingsStore'

export type SettingsPageId =
  | 'new-sessions'
  | 'session-list'
  | 'appearance'
  | 'terminal'
  | 'notifications'

export interface SettingsPage {
  id: SettingsPageId
  label: string
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'new-sessions', label: 'New sessions' },
  { id: 'session-list', label: 'Session list' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'notifications', label: 'Notifications' },
]

export function isSettingsPageId(value: unknown): value is SettingsPageId {
  return SETTINGS_PAGES.some((page) => page.id === value)
}

export function getPageLabel(id: SettingsPageId): string {
  return SETTINGS_PAGES.find((page) => page.id === id)?.label ?? id
}

/**
 * 'desktop': only affects the desktop layout (still shown on phones).
 * 'device': stored in this browser only, not synced to other devices.
 */
export type RowTag = 'desktop' | 'device'

/** DOM ids a row hands its control so labels and descriptions associate. */
export interface RowIds {
  control: string
  label: string
  description: string
}

export interface RowControlProps {
  ids: RowIds
}

export type SettingsState = ReturnType<typeof useSettingsStore.getState>

export interface SettingsRowDef {
  id: string
  page: SettingsPageId
  label: string
  /** Static description: shown by default and matched by search. */
  description: string
  /** Extra search terms that appear in neither label nor description. */
  keywords?: readonly string[]
  tags?: readonly RowTag[]
  /**
   * 'inline': control beside the label (default). 'wide': control drops
   * below the label on phones. 'block': control always spans the full width.
   */
  layout?: 'inline' | 'wide' | 'block'
  /** Hide the row (on its page and in search) unless this returns true. */
  visibleWhen?: (state: SettingsState) => boolean
  /** Replaces the static description when it depends on current values. */
  Description?: ComponentType
  Control: ComponentType<RowControlProps>
}
