/**
 * Remembers the last settings page viewed, per browser (not synced): the
 * desktop dialog reopens on it. Phones always open on the page list.
 */
import { safeStorage } from '../../utils/storage'
import { isSettingsPageId, type SettingsPageId } from './types'

export const LAST_PAGE_STORAGE_KEY = 'agentboard-settings-page'
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'new-sessions'

export function loadLastPage(): SettingsPageId {
  const stored = safeStorage.getItem(LAST_PAGE_STORAGE_KEY)
  return isSettingsPageId(stored) ? stored : DEFAULT_SETTINGS_PAGE
}

export function saveLastPage(page: SettingsPageId): void {
  safeStorage.setItem(LAST_PAGE_STORAGE_KEY, page)
}
