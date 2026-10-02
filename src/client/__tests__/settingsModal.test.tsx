import { describe, expect, test } from 'bun:test'
import { act } from 'react-test-renderer'
import SettingsModal from '../components/SettingsModal'
import { useSettingsStore } from '../stores/settingsStore'
import { LAST_PAGE_STORAGE_KEY } from '../components/settings/lastPage'
import {
  byRole, globalAny, openPage, render, row, rowSwitch, searchInput, setPhone, tab, textOf,
  setupSettingsDialogTests,
} from './settingsDialogHarness'

setupSettingsDialogTests()

describe('SettingsModal shell', () => {
  test('renders nothing when closed', async () => {
    const renderer = await render({ isOpen: false })
    expect(renderer.toJSON()).toBeNull()
  })

  test('is a labelled modal dialog with page tabs', async () => {
    const renderer = await render()
    const dialog = byRole(renderer.root, 'dialog')[0]
    expect(dialog.props['aria-modal']).toBe('true')
    expect(dialog.props['aria-labelledby']).toBe('settings-title')
    const tabs = byRole(renderer.root, 'tab')
    expect(tabs.map((node) => node.props.children)).toEqual([
      'New sessions', 'Session list', 'Appearance', 'Terminal', 'Notifications',
    ])
    expect(tab(renderer.root, 'New sessions').props['aria-selected']).toBe(true)
    expect(byRole(renderer.root, 'tabpanel')[0].props['aria-labelledby']).toBe('settings-tab-new-sessions')
  })

  test('has no Save or Cancel buttons', async () => {
    const renderer = await render()
    const labels = renderer.root.findAllByType('button').map((node) => node.props.children)
    expect(labels).not.toContain('Save')
    expect(labels).not.toContain('Cancel')
  })

  test('close button calls onClose', async () => {
    let closed = 0
    const renderer = await render({ onClose: () => { closed += 1 } })
    const close = renderer.root.find((node) => node.props['aria-label'] === 'Close settings')
    act(() => close.props.onClick())
    expect(closed).toBe(1)
  })

  test('backdrop click closes only when the press started on the backdrop', async () => {
    let closed = 0
    const renderer = await render({ onClose: () => { closed += 1 } })
    const backdrop = renderer.root.findAll((node) => node.type === 'div')[0]
    const self = { id: 'backdrop' }
    act(() => {
      backdrop.props.onMouseDown({ target: { id: 'inner' }, currentTarget: self })
      backdrop.props.onClick({ target: self, currentTarget: self })
    })
    expect(closed).toBe(0)
    act(() => {
      backdrop.props.onMouseDown({ target: self, currentTarget: self })
      backdrop.props.onClick({ target: self, currentTarget: self })
    })
    expect(closed).toBe(1)
  })

  test('remembers the last page across openings', async () => {
    const renderer = await render()
    await openPage(renderer, 'Appearance')
    expect(globalAny.localStorage?.getItem(LAST_PAGE_STORAGE_KEY)).toBe('appearance')
    act(() => renderer.update(<SettingsModal isOpen={false} onClose={() => {}} />))
    await act(async () => {
      renderer.update(<SettingsModal isOpen onClose={() => {}} />)
      await Promise.resolve()
    })
    expect(tab(renderer.root, 'Appearance').props['aria-selected']).toBe(true)
    expect(row(renderer.root, 'theme')).toBeTruthy()
  })

  test('arrow keys move between pages', async () => {
    const renderer = await render()
    await act(async () => {
      tab(renderer.root, 'New sessions').props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
    })
    expect(tab(renderer.root, 'Session list').props['aria-selected']).toBe(true)
    await act(async () => {
      tab(renderer.root, 'Session list').props.onKeyDown({ key: 'End', preventDefault: () => {} })
    })
    expect(tab(renderer.root, 'Notifications').props['aria-selected']).toBe(true)
    await act(async () => {
      tab(renderer.root, 'Notifications').props.onKeyDown({ key: 'x', preventDefault: () => {} })
    })
    expect(tab(renderer.root, 'Notifications').props['aria-selected']).toBe(true)
  })
})

describe('SettingsModal search', () => {
  test('shows matching rows from all pages grouped by page', async () => {
    const renderer = await render()
    await act(async () => searchInput(renderer.root).props.onChange({ target: { value: 'font' } }))
    const headings = renderer.root.findAllByType('h3').map((node) => node.props.children)
    expect(headings).toEqual(['Appearance'])
    expect(row(renderer.root, 'font-size')).toBeTruthy()
    // Hidden rows stay hidden in results (custom family only when Custom).
    expect(renderer.root.findAll((node) => node.props['data-setting-row'] === 'custom-font-family')).toHaveLength(0)
    expect(byRole(renderer.root, 'region')[0].props['aria-label']).toBe('Search results')
    // No tab is selected while results show.
    expect(byRole(renderer.root, 'tab').some((node) => node.props['aria-selected'])).toBe(false)
  })

  test('results stay interactive', async () => {
    const renderer = await render()
    await act(async () => searchInput(renderer.root).props.onChange({ target: { value: 'session id' } }))
    act(() => rowSwitch(renderer.root, 'show-session-id-prefix').props.onCheckedChange(true))
    expect(useSettingsStore.getState().showSessionIdPrefix).toBe(true)
  })

  test('shows an empty state when nothing matches', async () => {
    const renderer = await render()
    await act(async () => searchInput(renderer.root).props.onChange({ target: { value: 'zzzz' } }))
    const status = byRole(renderer.root, 'status')[0]
    expect(textOf(status)).toContain('No settings match “zzzz”')
  })

  test('Escape clears a query instead of closing', async () => {
    const renderer = await render()
    await act(async () => searchInput(renderer.root).props.onChange({ target: { value: 'sound' } }))
    let prevented = false
    await act(async () => {
      searchInput(renderer.root).props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented = true } })
    })
    expect(prevented).toBe(true)
    expect(searchInput(renderer.root).props.value).toBe('')
    prevented = false
    searchInput(renderer.root).props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented = true } })
    expect(prevented).toBe(false)
  })

  test('choosing a page clears the query', async () => {
    const renderer = await render()
    await act(async () => searchInput(renderer.root).props.onChange({ target: { value: 'sound' } }))
    await openPage(renderer, 'Terminal')
    expect(searchInput(renderer.root).props.value).toBe('')
    expect(row(renderer.root, 'webgl')).toBeTruthy()
  })
})

describe('SettingsModal phone layout', () => {
  test('opens on the page list, drills in, and goes back', async () => {
    setPhone(true)
    globalAny.localStorage?.setItem(LAST_PAGE_STORAGE_KEY, 'terminal')
    const renderer = await render()
    expect(byRole(renderer.root, 'tab')).toHaveLength(0)
    const appearance = renderer.root.find((node) => node.props['data-page-id'] === 'appearance')
    await act(async () => appearance.props.onClick())
    expect(renderer.root.find((node) => node.props.id === 'settings-title').props.children).toBe('Appearance')
    expect(row(renderer.root, 'theme')).toBeTruthy()
    const back = renderer.root.find((node) => node.props['aria-label'] === 'Back to settings')
    await act(async () => back.props.onClick())
    expect(renderer.root.find((node) => node.props.id === 'settings-title').props.children).toBe('Settings')
  })

  test('search results replace the page list', async () => {
    setPhone(true)
    const renderer = await render()
    await act(async () => searchInput(renderer.root).props.onChange({ target: { value: 'idle' } }))
    expect(renderer.root.findAll((node) => node.props['data-page-id'] === 'appearance')).toHaveLength(0)
    expect(row(renderer.root, 'sound-idle')).toBeTruthy()
  })
})
