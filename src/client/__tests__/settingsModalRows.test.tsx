import { describe, expect, test } from 'bun:test'
import { act, type ReactTestInstance } from 'react-test-renderer'
import { DEFAULT_PROJECT_DIR, useSettingsStore } from '../stores/settingsStore'
import { useThemeStore } from '../stores/themeStore'
import {
  fetchCalls, installFetch, openPage, radio, render, row, rowSwitch, textOf,
  setupSettingsDialogTests,
} from './settingsDialogHarness'

setupSettingsDialogTests()

describe('SettingsModal instant apply', () => {
  test('session list controls write to the store immediately', async () => {
    const renderer = await render()
    await openPage(renderer, 'Session list')
    act(() => radio(renderer.root, 'Oldest first').props.onClick())
    expect(useSettingsStore.getState().sessionSortDirection).toBe('asc')
    act(() => radio(renderer.root, 'Bottom').props.onClick())
    expect(useSettingsStore.getState().sidebarAnchor).toBe('bottom')
    expect(radio(renderer.root, 'Bottom').props['aria-checked']).toBe(true)
    act(() => rowSwitch(renderer.root, 'show-project-name').props.onCheckedChange(false))
    expect(useSettingsStore.getState().showProjectName).toBe(false)
    act(() => rowSwitch(renderer.root, 'show-last-user-message').props.onCheckedChange(false))
    expect(useSettingsStore.getState().showLastUserMessage).toBe(false)
  })

  test('sort direction shows only for Created order', async () => {
    const renderer = await render()
    await openPage(renderer, 'Session list')
    expect(row(renderer.root, 'sort-direction')).toBeTruthy()
    act(() => radio(renderer.root, 'Status').props.onClick())
    expect(useSettingsStore.getState().sessionSortMode).toBe('status')
    expect(renderer.root.findAll((node) => node.props['data-setting-row'] === 'sort-direction')).toHaveLength(0)
    expect(textOf(row(renderer.root, 'sort-order'))).toContain('re-sort by status')
    act(() => radio(renderer.root, 'Manual').props.onClick())
    expect(textOf(row(renderer.root, 'sort-order'))).toContain('Drag sessions')
    act(() => radio(renderer.root, 'Created').props.onClick())
    expect(textOf(row(renderer.root, 'sort-order'))).toContain('order they were created')
  })

  test('segmented control arrow keys select the next option', async () => {
    const renderer = await render()
    await openPage(renderer, 'Session list')
    act(() => radio(renderer.root, 'Created').props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} }))
    expect(useSettingsStore.getState().sessionSortMode).toBe('status')
    act(() => radio(renderer.root, 'Status').props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} }))
    expect(useSettingsStore.getState().sessionSortMode).toBe('created')
    act(() => radio(renderer.root, 'Created').props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} }))
    expect(useSettingsStore.getState().sessionSortMode).toBe('manual')
    act(() => radio(renderer.root, 'Manual').props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} }))
    expect(useSettingsStore.getState().sessionSortMode).toBe('created')
    act(() => radio(renderer.root, 'Created').props.onKeyDown({ key: 'End', preventDefault: () => {} }))
    expect(useSettingsStore.getState().sessionSortMode).toBe('manual')
    act(() => radio(renderer.root, 'Manual').props.onKeyDown({ key: 'Home', preventDefault: () => {} }))
    expect(useSettingsStore.getState().sessionSortMode).toBe('created')
    act(() => radio(renderer.root, 'Created').props.onKeyDown({ key: 'a', preventDefault: () => {} }))
    expect(useSettingsStore.getState().sessionSortMode).toBe('created')
  })

  test('appearance controls apply live', async () => {
    const renderer = await render()
    await openPage(renderer, 'Appearance')
    act(() => radio(renderer.root, 'System').props.onClick())
    expect(useThemeStore.getState().theme).toBe('system')

    const increase = renderer.root.find((node) => node.props['aria-label'] === 'Increase font size')
    act(() => increase.props.onClick())
    expect(useSettingsStore.getState().fontSize).toBe(14)
    const decrease = renderer.root.find((node) => node.props['aria-label'] === 'Decrease font size')
    act(() => decrease.props.onClick())
    act(() => decrease.props.onClick())
    expect(useSettingsStore.getState().fontSize).toBe(12)

    const lineHeight = renderer.root.find((node) => node.type === 'input' && node.props.id === 'settings-line-height-control')
    act(() => lineHeight.props.onChange({ target: { value: '1.2000000000000002' } }))
    expect(useSettingsStore.getState().lineHeight).toBe(1.2)
    act(() => lineHeight.props.onChange({ target: { value: 'nope' } }))
    expect(useSettingsStore.getState().lineHeight).toBe(1.2)
    const spacing = renderer.root.find((node) => node.type === 'input' && node.props.id === 'settings-letter-spacing-control')
    act(() => spacing.props.onChange({ target: { value: '2' } }))
    expect(useSettingsStore.getState().letterSpacing).toBe(2)

    const family = renderer.root.find((node) => node.type === 'select' && node.props.id === 'settings-font-family-control')
    act(() => family.props.onChange({ target: { value: 'custom' } }))
    expect(useSettingsStore.getState().fontOption).toBe('custom')
    const custom = renderer.root.find((node) => node.type === 'input' && node.props.id === 'settings-custom-font-family-control')
    act(() => custom.props.onChange({ target: { value: '  "Fira Code"  ' } }))
    act(() => custom.props.onBlur())
    expect(useSettingsStore.getState().customFontFamily).toBe('"Fira Code"')
  })

  test('terminal page: WebGL and shortcut modifier apply live', async () => {
    const renderer = await render()
    await openPage(renderer, 'Terminal')
    act(() => rowSwitch(renderer.root, 'webgl').props.onCheckedChange(false))
    expect(useSettingsStore.getState().useWebGL).toBe(false)
    act(() => radio(renderer.root, '⌘⇧').props.onClick())
    expect(useSettingsStore.getState().shortcutModifier).toBe('cmd-shift')
    const desc = renderer.root.find((node) => node.props.id === 'settings-shortcut-modifier-desc')
    expect(textOf(desc)).toContain('⌘⇧')
    expect(textOf(desc)).toContain('1-9 [ ] N X ,')
  })

  test('notification switches write and prime audio; test buttons play', async () => {
    const renderer = await render()
    await openPage(renderer, 'Notifications')
    act(() => rowSwitch(renderer.root, 'sound-permission').props.onCheckedChange(true))
    act(() => rowSwitch(renderer.root, 'sound-idle').props.onCheckedChange(true))
    expect(useSettingsStore.getState().soundOnPermission).toBe(true)
    expect(useSettingsStore.getState().soundOnIdle).toBe(true)
    act(() => rowSwitch(renderer.root, 'sound-idle').props.onCheckedChange(false))
    expect(useSettingsStore.getState().soundOnIdle).toBe(false)
    for (const label of ['Test permission sound', 'Test idle sound']) {
      const button = renderer.root.find((node) => node.props['aria-label'] === label)
      expect(() => act(() => button.props.onClick())).not.toThrow()
    }
  })
})

describe('SettingsModal text fields', () => {
  const dirInput = (root: ReactTestInstance) =>
    root.find((node) => node.type === 'input' && node.props.id === 'settings-default-project-dir-control')

  test('commits on blur, trimmed, falling back to the default when empty', async () => {
    const renderer = await render()
    act(() => dirInput(renderer.root).props.onChange({ target: { value: '  /code  ' } }))
    expect(useSettingsStore.getState().defaultProjectDir).toBe('/projects')
    act(() => dirInput(renderer.root).props.onBlur())
    expect(useSettingsStore.getState().defaultProjectDir).toBe('/code')
    act(() => dirInput(renderer.root).props.onChange({ target: { value: '   ' } }))
    act(() => dirInput(renderer.root).props.onKeyDown({ key: 'Enter', preventDefault: () => {} }))
    expect(useSettingsStore.getState().defaultProjectDir).toBe(DEFAULT_PROJECT_DIR)
  })

  test('a broadcast does not clobber the field being edited', async () => {
    const renderer = await render()
    act(() => dirInput(renderer.root).props.onChange({ target: { value: '/typing' } }))
    act(() => { useSettingsStore.setState({ defaultProjectDir: '/remote' }) })
    expect(dirInput(renderer.root).props.value).toBe('/typing')
    // Escape reverts the draft to the latest stored value.
    act(() => dirInput(renderer.root).props.onKeyDown({ key: 'Escape', preventDefault: () => {} }))
    expect(dirInput(renderer.root).props.value).toBe('/remote')
    // An untouched field follows the store.
    act(() => { useSettingsStore.setState({ defaultProjectDir: '/again' }) })
    expect(dirInput(renderer.root).props.value).toBe('/again')
  })
})

describe('SettingsModal server settings', () => {
  test('terminal colors stays disabled until loaded, then PUTs changes', async () => {
    let resolveColors!: (response: Response) => void
    installFetch((call) => {
      if (call.url === '/api/settings/terminal-colors' && call.method === 'GET') {
        return new Promise<Response>((resolve) => { resolveColors = resolve }) as unknown as Response
      }
      return undefined
    })
    const renderer = await render()
    await openPage(renderer, 'Terminal')
    expect(rowSwitch(renderer.root, 'terminal-colors').props.disabled).toBe(true)
    await act(async () => {
      resolveColors(new Response(JSON.stringify({ enabled: false }), { status: 200 }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(rowSwitch(renderer.root, 'terminal-colors').props.checked).toBe(false)
    expect(rowSwitch(renderer.root, 'terminal-colors').props.disabled).toBe(false)
    await act(async () => {
      rowSwitch(renderer.root, 'terminal-colors').props.onCheckedChange(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fetchCalls).toContainEqual({
      url: '/api/settings/terminal-colors',
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
  })

  test('mouse mode and window names write to their endpoints', async () => {
    const renderer = await render()
    await openPage(renderer, 'Terminal')
    await act(async () => {
      rowSwitch(renderer.root, 'mouse-mode').props.onCheckedChange(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await openPage(renderer, 'Session list')
    await act(async () => {
      rowSwitch(renderer.root, 'prefer-window-name').props.onCheckedChange(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const puts = fetchCalls.filter((call) => call.method === 'PUT').map((call) => call.url)
    expect(puts).toEqual(['/api/settings/tmux-mouse-mode', '/api/settings/prefer-window-name'])
  })

  test('history lookback commits on blur, clamped, and rejects non-numbers', async () => {
    const renderer = await render()
    await openPage(renderer, 'Session list')
    const input = () => renderer.root.find((node) => node.type === 'input' && node.props.id === 'settings-history-lookback-control')
    expect(input().props.value).toBe('24')
    act(() => input().props.onChange({ target: { value: '500' } }))
    expect(fetchCalls.some((call) => call.method === 'PUT')).toBe(false)
    await act(async () => {
      input().props.onBlur()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fetchCalls.filter((call) => call.method === 'PUT')).toEqual([
      { url: '/api/settings/history-max-age-hours', method: 'PUT', body: JSON.stringify({ hours: 168 }) },
    ])
    expect(input().props.value).toBe('168')

    act(() => input().props.onChange({ target: { value: 'abc' } }))
    act(() => input().props.onBlur())
    expect(input().props['aria-invalid']).toBe(true)
    expect(input().props.value).toBe('abc')
    expect(fetchCalls.filter((call) => call.method === 'PUT')).toHaveLength(1)

    // Same value as stored: no write.
    act(() => input().props.onChange({ target: { value: '168 ' } }))
    act(() => input().props.onBlur())
    expect(fetchCalls.filter((call) => call.method === 'PUT')).toHaveLength(1)
  })
})
