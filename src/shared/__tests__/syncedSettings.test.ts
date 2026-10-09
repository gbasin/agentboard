import { describe, expect, test } from 'bun:test'
import {
  SYNCED_SETTINGS_KEYS,
  isSyncedSettingsKey,
  isValidSyncedSetting,
  type SyncedSettingsKey,
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

describe('synced theme', () => {
  test('accepts dark, light and system only', () => {
    expect(isValidSyncedSetting('theme', 'dark')).toBe(true)
    expect(isValidSyncedSetting('theme', 'light')).toBe(true)
    expect(isValidSyncedSetting('theme', 'system')).toBe(true)
    for (const value of ['auto', '', null, undefined, 0, true]) {
      expect(isValidSyncedSetting('theme', value)).toBe(false)
    }
  })
})

describe('synced boolean prefs', () => {
  const keys: SyncedSettingsKey[] = [
    'showProjectName',
    'showLastUserMessage',
    'showSessionIdPrefix',
    'soundOnPermission',
    'soundOnIdle',
  ]

  test.each(keys)('%s is a synced key accepting only booleans', (raw) => {
    const key = raw as SyncedSettingsKey
    expect(SYNCED_SETTINGS_KEYS).toContain(key)
    expect(isSyncedSettingsKey(key)).toBe(true)
    expect(isValidSyncedSetting(key, true)).toBe(true)
    expect(isValidSyncedSetting(key, false)).toBe(true)
    for (const value of ['true', 1, 0, null, undefined, {}]) {
      expect(isValidSyncedSetting(key, value)).toBe(false)
    }
  })
})
