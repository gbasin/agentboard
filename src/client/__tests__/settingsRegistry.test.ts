import { describe, expect, test } from 'bun:test'
import {
  SETTINGS_ROWS,
  groupByPage,
  rowsForPage,
  searchRows,
} from '../components/settings/registry'
import { navKeyTarget, tabId } from '../components/settings/SettingsNav'
import { rowIds } from '../components/settings/SettingRow'
import {
  SETTINGS_PAGES,
  getPageLabel,
  isSettingsPageId,
} from '../components/settings/types'

const ids = (rows: { id: string }[]) => rows.map((row) => row.id)

describe('settings registry', () => {
  test('row ids are unique and every page has rows', () => {
    const all = ids([...SETTINGS_ROWS])
    expect(new Set(all).size).toBe(all.length)
    for (const page of SETTINGS_PAGES) {
      expect(rowsForPage(page.id).length).toBeGreaterThan(0)
    }
  })

  test('pages hold the specified rows in order', () => {
    expect(ids(rowsForPage('new-sessions'))).toEqual(['default-project-dir', 'command-presets'])
    expect(ids(rowsForPage('session-list'))).toEqual([
      'sort-order', 'sort-direction', 'sidebar-anchor', 'show-project-name',
      'show-last-user-message', 'show-session-id-prefix', 'history-lookback', 'prefer-window-name',
    ])
    expect(ids(rowsForPage('appearance'))).toEqual([
      'theme', 'font-family', 'custom-font-family', 'font-size', 'line-height', 'letter-spacing',
    ])
    expect(ids(rowsForPage('terminal'))).toEqual(['webgl', 'mouse-mode', 'terminal-colors', 'shortcut-modifier'])
    expect(ids(rowsForPage('notifications'))).toEqual(['sound-permission', 'sound-idle'])
  })

  test('tags: desktop-only and this-device rows', () => {
    const tagged = (tag: 'desktop' | 'device') =>
      SETTINGS_ROWS.filter((row) => row.tags?.includes(tag)).map((row) => row.id).sort()
    expect(tagged('desktop')).toEqual(['shortcut-modifier', 'sidebar-anchor'])
    expect(tagged('device')).toEqual([
      'custom-font-family', 'font-family', 'font-size', 'letter-spacing',
      'line-height', 'shortcut-modifier', 'webgl',
    ])
  })

  test('numeric rows state their default', () => {
    for (const id of ['font-size', 'line-height', 'letter-spacing', 'history-lookback']) {
      const row = SETTINGS_ROWS.find((candidate) => candidate.id === id)
      expect(row?.description).toMatch(/Default -?[\d.]+/)
    }
  })

  test('visibility rules', () => {
    const find = (id: string) => SETTINGS_ROWS.find((row) => row.id === id)!
    const state = (patch: Record<string, unknown>) => patch as never
    expect(find('sort-direction').visibleWhen?.(state({ sessionSortMode: 'created' }))).toBe(true)
    expect(find('sort-direction').visibleWhen?.(state({ sessionSortMode: 'status' }))).toBe(false)
    expect(find('custom-font-family').visibleWhen?.(state({ fontOption: 'custom' }))).toBe(true)
    expect(find('custom-font-family').visibleWhen?.(state({ fontOption: 'system' }))).toBe(false)
  })
})

describe('searchRows', () => {
  test('matches label, description and keywords, case-insensitively', () => {
    expect(ids(searchRows('WEBGL'))).toEqual(['webgl'])
    expect(ids(searchRows('fuzzy'))).toEqual(['webgl'])
    expect(ids(searchRows('dark mode'))).toEqual(['theme'])
    expect(ids(searchRows('chime'))).toEqual(['sound-idle'])
  })

  test('every term must match', () => {
    expect(ids(searchRows('font size'))).toEqual(['font-size'])
    expect(searchRows('font zebra')).toEqual([])
  })

  test('an empty query matches nothing', () => {
    expect(searchRows('')).toEqual([])
    expect(searchRows('   ')).toEqual([])
  })

  test('groups results by page in page order', () => {
    const groups = groupByPage(searchRows('tmux'))
    expect(groups.map((group) => group.label)).toEqual(['Session list', 'Terminal'])
    expect(ids(groups[1].rows)).toEqual(['mouse-mode'])
  })
})

describe('settings helpers', () => {
  test('page ids and labels', () => {
    expect(isSettingsPageId('appearance')).toBe(true)
    expect(isSettingsPageId('nope')).toBe(false)
    expect(isSettingsPageId(null)).toBe(false)
    expect(getPageLabel('terminal')).toBe('Terminal')
    expect(getPageLabel('missing' as never)).toBe('missing')
    expect(tabId('terminal')).toBe('settings-tab-terminal')
  })

  test('row ids', () => {
    expect(rowIds('theme')).toEqual({
      control: 'settings-theme-control',
      label: 'settings-theme-label',
      description: 'settings-theme-desc',
    })
  })

  test('navKeyTarget wraps and jumps', () => {
    expect(navKeyTarget('ArrowDown', 4, 5)).toBe(0)
    expect(navKeyTarget('ArrowUp', 0, 5)).toBe(4)
    expect(navKeyTarget('Home', 3, 5)).toBe(0)
    expect(navKeyTarget('End', 0, 5)).toBe(4)
    expect(navKeyTarget('Enter', 0, 5)).toBeNull()
  })
})
