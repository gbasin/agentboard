import { describe, expect, test } from 'bun:test'
import {
  SYNCED_SETTINGS_KEYS,
  isSyncedSettingsKey,
  isValidSyncedSetting,
} from '../syncedSettings'

describe('synced sidebarAnchor', () => {
  test('is a synced key', () => {
    expect(SYNCED_SETTINGS_KEYS).toContain('sidebarAnchor')
    expect(isSyncedSettingsKey('sidebarAnchor')).toBe(true)
  })

  test('accepts only top or bottom', () => {
    expect(isValidSyncedSetting('sidebarAnchor', 'top')).toBe(true)
    expect(isValidSyncedSetting('sidebarAnchor', 'bottom')).toBe(true)
    for (const value of ['middle', '', null, undefined, 1, true, ['top']]) {
      expect(isValidSyncedSetting('sidebarAnchor', value)).toBe(false)
    }
  })
})
