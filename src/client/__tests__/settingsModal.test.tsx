import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import SettingsModal from '../components/SettingsModal'
import { Switch } from '../components/Switch'
import { LAST_PAGE_STORAGE_KEY } from '../components/settings/lastPage'
import {
  DEFAULT_PRESETS,
  DEFAULT_PROJECT_DIR,
  useSettingsStore,
} from '../stores/settingsStore'
import { useThemeStore } from '../stores/themeStore'

const globalAny = globalThis as typeof globalThis & {
  localStorage?: Storage
  window?: unknown
}

const originalLocalStorage = globalAny.localStorage
const originalWindow = globalAny.window
const originalFetch = globalThis.fetch

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

interface FetchCall {
  url: string
  method: string
  body: string | null
}

let fetchCalls: FetchCall[] = []
const mounted: TestRenderer.ReactTestRenderer[] = []
let serverValues: Record<string, unknown> = {}

function installFetch(handler?: (call: FetchCall) => Response | Promise<Response> | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    }
    fetchCalls.push(call)
    const custom = handler?.(call)
    if (custom) return custom
    const name = call.url.replace('/api/settings/', '')
    const payload = name === 'history-max-age-hours'
      ? { hours: serverValues[name] ?? 24 }
      : { enabled: serverValues[name] ?? true }
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
}

function setPhone(isPhone: boolean) {
  globalAny.window = {
    matchMedia: () => ({
      matches: isPhone,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  }
}

beforeEach(() => {
  globalAny.localStorage = createStorage()
  fetchCalls = []
  serverValues = {}
  installFetch()
  useSettingsStore.setState({
    defaultProjectDir: '/projects',
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'codex',
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    sidebarAnchor: 'top',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    useWebGL: true,
    fontSize: 13,
    lineHeight: 1,
    letterSpacing: 0,
    fontOption: 'jetbrains-mono',
    customFontFamily: '',
    shortcutModifier: 'auto',
    soundOnPermission: false,
    soundOnIdle: false,
  })
  useThemeStore.setState({ theme: 'dark' })
})

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  globalAny.localStorage = originalLocalStorage
  globalAny.window = originalWindow
  globalThis.fetch = originalFetch
  useSettingsStore.setState({
    defaultProjectDir: DEFAULT_PROJECT_DIR,
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'claude',
  })
})

async function render(props: { isOpen?: boolean; onClose?: () => void } = {}) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <SettingsModal isOpen={props.isOpen ?? true} onClose={props.onClose ?? (() => {})} />
    )
    await Promise.resolve()
  })
  mounted.push(renderer)
  // Let server-setting fetches resolve.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return renderer
}

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  return node.children.map((child) => textOf(child as ReactTestInstance | string)).join('')
}

const byRole = (root: ReactTestInstance, role: string) =>
  root.findAll((node) => typeof node.type === 'string' && node.props.role === role)

function tab(root: ReactTestInstance, label: string) {
  const found = byRole(root, 'tab').find((node) => node.props.children === label)
  if (!found) throw new Error(`Expected tab ${label}`)
  return found
}

function radio(root: ReactTestInstance, label: string) {
  const found = byRole(root, 'radio').find((node) => node.props.children === label)
  if (!found) throw new Error(`Expected radio ${label}`)
  return found
}

function row(root: ReactTestInstance, id: string) {
  const found = root.findAll((node) => node.props['data-setting-row'] === id)
  if (found.length === 0) throw new Error(`Expected row ${id}`)
  return found[0]
}

function rowSwitch(root: ReactTestInstance, id: string) {
  return row(root, id).findByType(Switch)
}

async function openPage(renderer: TestRenderer.ReactTestRenderer, label: string) {
  await act(async () => {
    tab(renderer.root, label).props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const searchInput = (root: ReactTestInstance) => root.find((node) => node.props.id === 'settings-search')

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
    act(() => useSettingsStore.setState({ defaultProjectDir: '/remote' }))
    expect(dirInput(renderer.root).props.value).toBe('/typing')
    // Escape reverts the draft to the latest stored value.
    act(() => dirInput(renderer.root).props.onKeyDown({ key: 'Escape', preventDefault: () => {} }))
    expect(dirInput(renderer.root).props.value).toBe('/remote')
    // An untouched field follows the store.
    act(() => useSettingsStore.setState({ defaultProjectDir: '/again' }))
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
