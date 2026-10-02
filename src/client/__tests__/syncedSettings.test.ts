import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const globalAny = globalThis as typeof globalThis & {
  window?: { localStorage: Storage }
  localStorage?: Storage
  fetch?: typeof fetch
}

const originalWindow = globalAny.window
const originalLocalStorage = globalAny.localStorage
const originalFetch = globalAny.fetch

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
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

const storage = createStorage()
globalAny.localStorage = storage
globalAny.window = { localStorage: storage } as typeof window

const fetchCalls: { body: { settings: Record<string, unknown> } }[] = []
const fetchMock = mock((_input: unknown, init?: { body?: string }) => {
  fetchCalls.push({ body: JSON.parse(init?.body ?? '{}') })
  return Promise.resolve(new Response('{"settings":{}}', { status: 200 }))
})
globalAny.fetch = fetchMock as unknown as typeof fetch

const { useThemeStore } = await import('../stores/themeStore')
const { useSettingsStore } = await import('../stores/settingsStore')
const { applySyncedSettings, initSyncedSettings } = await import('../syncedSettings')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let cleanup: (() => void) | null = null

beforeEach(() => {
  fetchCalls.length = 0
  fetchMock.mockClear()
  useThemeStore.setState({ theme: 'dark' })
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sidebarAnchor: 'top',
    projectFilters: [],
    recentPaths: [],
    lastProjectPath: null,
  })
  // setState writes via zustand persist — clear AFTER resetting state so
  // tests start as a "fresh" client (no persisted localStorage entries).
  storage.clear()
  cleanup = initSyncedSettings()
})

afterEach(() => {
  cleanup?.()
  cleanup = null
})

afterAll(() => {
  globalAny.window = originalWindow
  globalAny.localStorage = originalLocalStorage
  globalAny.fetch = originalFetch
})

describe('applySyncedSettings', () => {
  test('applies theme to themeStore', () => {
    applySyncedSettings({ theme: 'light' })
    expect(useThemeStore.getState().theme).toBe('light')
  })

  test('applies settings keys to settingsStore', () => {
    applySyncedSettings({
      sessionSortMode: 'manual',
      projectFilters: ['/proj/a'],
      lastProjectPath: '/proj/b',
    })
    const state = useSettingsStore.getState()
    expect(state.sessionSortMode).toBe('manual')
    expect(state.projectFilters).toEqual(['/proj/a'])
    expect(state.lastProjectPath).toBe('/proj/b')
  })

  test('ignores unknown keys and invalid values', () => {
    applySyncedSettings({
      theme: 'neon',
      bogusKey: 1,
      sessionSortMode: 'sideways',
      recentPaths: ['/ok'],
    } as never)
    expect(useThemeStore.getState().theme).toBe('dark')
    const state = useSettingsStore.getState() as unknown as Record<string, unknown>
    expect(state.bogusKey).toBeUndefined()
    expect(state.sessionSortMode).toBe('created')
    expect(state.recentPaths).toEqual(['/ok'])
  })
})

describe('sidebarAnchor sync', () => {
  test('applies a valid remote anchor and ignores invalid ones', () => {
    applySyncedSettings({ sidebarAnchor: 'bottom' })
    expect(useSettingsStore.getState().sidebarAnchor).toBe('bottom')

    applySyncedSettings({ sidebarAnchor: 'middle' } as never)
    expect(useSettingsStore.getState().sidebarAnchor).toBe('bottom')
  })

  test('pushes a local anchor change to the server', async () => {
    useSettingsStore.getState().setSidebarAnchor('bottom')
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].body.settings).toEqual({ sidebarAnchor: 'bottom' })
  })
})

describe('push on local change', () => {
  test('pushes theme change to the server', async () => {
    useThemeStore.getState().setTheme('light')
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].body.settings.theme).toBe('light')
  })

  test('pushes settings change and batches multiple keys', async () => {
    useSettingsStore.getState().setProjectFilters(['/x'])
    useSettingsStore.getState().setSessionSortMode('manual')
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].body.settings).toEqual({
      projectFilters: ['/x'],
      sessionSortMode: 'manual',
    })
  })

  test('a broadcast inside the debounce window does not revert a local change', async () => {
    useSettingsStore.getState().setSidebarAnchor('bottom')
    // Another browser changed theme; its full-state broadcast still carries
    // this browser's old anchor.
    applySyncedSettings({ theme: 'light', sidebarAnchor: 'top' })
    expect(useThemeStore.getState().theme).toBe('light')
    expect(useSettingsStore.getState().sidebarAnchor).toBe('bottom')
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
    // (The local write persisted state, so the push may also seed other
    // server-absent keys; what matters is the anchor it carries.)
    expect(fetchCalls[0].body.settings.sidebarAnchor).toBe('bottom')
    // The server's rebroadcast of the pushed value is an echo, not a push.
    applySyncedSettings({ theme: 'light', sidebarAnchor: 'bottom' })
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
  })

  test('changing back to the server value inside the window cancels the push', async () => {
    applySyncedSettings({ sidebarAnchor: 'top' })
    useSettingsStore.getState().setSidebarAnchor('bottom')
    useSettingsStore.getState().setSidebarAnchor('top')
    await sleep(300)
    expect(fetchCalls.length).toBe(0)
    expect(useSettingsStore.getState().sidebarAnchor).toBe('top')
  })

  test('a broadcast while the PUT is in flight does not revert the local value', async () => {
    let resolvePut!: () => void
    globalAny.fetch = ((_input: unknown, init?: { body?: string }) => {
      fetchCalls.push({ body: JSON.parse(init?.body ?? '{}') })
      return new Promise<Response>((resolve) => {
        resolvePut = () => resolve(new Response('{"settings":{}}', { status: 200 }))
      })
    }) as unknown as typeof fetch
    useSettingsStore.getState().setSessionSortMode('manual')
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
    // Stale full-state broadcast lands before the PUT is answered.
    applySyncedSettings({ sessionSortMode: 'created' })
    expect(useSettingsStore.getState().sessionSortMode).toBe('manual')
    resolvePut()
    await sleep(0)
    // Once settled, broadcasts apply again.
    applySyncedSettings({ sessionSortMode: 'status' })
    expect(useSettingsStore.getState().sessionSortMode).toBe('status')
    globalAny.fetch = fetchMock as unknown as typeof fetch
  })

  test('a failed PUT forgets the optimistic mark so a later change back still pushes', async () => {
    applySyncedSettings({ sidebarAnchor: 'top' })
    globalAny.fetch = ((_input: unknown, init?: { body?: string }) => {
      fetchCalls.push({ body: JSON.parse(init?.body ?? '{}') })
      return Promise.resolve(new Response('{}', { status: 500 }))
    }) as unknown as typeof fetch
    // The rejected push also logs to the server; count only settings PUTs.
    const pushes = () => fetchCalls.filter((c) => c.body.settings)
    useSettingsStore.getState().setSidebarAnchor('bottom')
    await sleep(300)
    expect(pushes().length).toBe(1)
    // Local keeps the user's choice; the server still holds 'top'.
    expect(useSettingsStore.getState().sidebarAnchor).toBe('bottom')
    // Flip away and back to 'bottom' quickly: this must push again.
    useSettingsStore.getState().setSidebarAnchor('top')
    useSettingsStore.getState().setSidebarAnchor('bottom')
    await sleep(300)
    expect(pushes().length).toBe(2)
    expect(pushes()[1].body.settings.sidebarAnchor).toBe('bottom')
    globalAny.fetch = fetchMock as unknown as typeof fetch
  })

  test('a concurrent remote write held back during the PUT is adopted when it settles', async () => {
    let resolvePut!: () => void
    globalAny.fetch = ((_input: unknown, init?: { body?: string }) => {
      fetchCalls.push({ body: JSON.parse(init?.body ?? '{}') })
      return new Promise<Response>((resolve) => {
        resolvePut = () => resolve(new Response('{"settings":{}}', { status: 200 }))
      })
    }) as unknown as typeof fetch
    useSettingsStore.getState().setSessionSortMode('manual')
    await sleep(300)
    // Another browser wrote 'status' after our PUT was accepted; its
    // broadcast arrives before our HTTP response does.
    applySyncedSettings({ sessionSortMode: 'status' })
    expect(useSettingsStore.getState().sessionSortMode).toBe('manual')
    resolvePut()
    await sleep(0)
    expect(useSettingsStore.getState().sessionSortMode).toBe('status')
    await sleep(300)
    // Adopting the server's value is not a local change: nothing pushes
    // sessionSortMode again (veteran seeding of other keys may run).
    expect(fetchCalls.slice(1).some((c) => 'sessionSortMode' in (c.body.settings ?? {}))).toBe(false)
    globalAny.fetch = fetchMock as unknown as typeof fetch
  })

  test('a later change inside the window replaces the pending value', async () => {
    useSettingsStore.getState().setSessionSortMode('manual')
    useSettingsStore.getState().setSessionSortMode('status')
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].body.settings).toEqual({ sessionSortMode: 'status' })
  })

  test('applies and pushes list details and sounds', async () => {
    applySyncedSettings({ showSessionIdPrefix: true, soundOnIdle: true })
    expect(useSettingsStore.getState().showSessionIdPrefix).toBe(true)
    expect(useSettingsStore.getState().soundOnIdle).toBe(true)
    await sleep(300)
    expect(fetchCalls.length).toBe(0)

    useSettingsStore.getState().setSoundOnPermission(true)
    useSettingsStore.getState().setShowProjectName(false)
    await sleep(300)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].body.settings).toEqual({
      soundOnPermission: true,
      showProjectName: false,
    })
  })

  test('applies a system theme', () => {
    applySyncedSettings({ theme: 'system' })
    expect(useThemeStore.getState().theme).toBe('system')
  })

  test('does not push non-synced keys', async () => {
    useSettingsStore.getState().setFontSize(20)
    useSettingsStore.getState().setSidebarWidth(300)
    await sleep(300)
    expect(fetchCalls.length).toBe(0)
  })

  test('does not echo applied remote values back', async () => {
    applySyncedSettings({ theme: 'light', sessionSortMode: 'manual' })
    await sleep(300)
    // Seeding may push other absent keys only if this client is a veteran;
    // storage is empty here, so no push at all.
    expect(fetchCalls.length).toBe(0)
  })
})

describe('veteran seeding', () => {
  test('seeds server-absent keys when client has persisted state', async () => {
    // Simulate a veteran: persisted stores exist locally
    storage.setItem('agentboard-theme', '{"state":{"theme":"light"},"version":0}')
    storage.setItem('agentboard-settings', '{"state":{},"version":8}')

    applySyncedSettings({ theme: 'dark' })
    await sleep(300)

    expect(fetchCalls.length).toBe(1)
    const pushed = fetchCalls[0].body.settings
    // theme is present on server (dark) — not re-seeded
    expect(pushed.theme).toBeUndefined()
    // absent settings keys are seeded from local values
    expect(pushed.sessionSortMode).toBe('created')
    expect(pushed.defaultPresetId).toBe('claude')
    expect(pushed.recentPaths).toEqual([])
  })

  test('seeds list details and sounds from a veteran client', async () => {
    storage.setItem('agentboard-settings', '{"state":{},"version":8}')
    useSettingsStore.setState({
      showProjectName: false,
      showLastUserMessage: true,
      showSessionIdPrefix: true,
      soundOnPermission: true,
      soundOnIdle: false,
    })

    applySyncedSettings({})
    await sleep(300)

    expect(fetchCalls.length).toBe(1)
    const pushed = fetchCalls[0].body.settings
    expect(pushed.showProjectName).toBe(false)
    expect(pushed.showLastUserMessage).toBe(true)
    expect(pushed.showSessionIdPrefix).toBe(true)
    expect(pushed.soundOnPermission).toBe(true)
    expect(pushed.soundOnIdle).toBe(false)
  })

  test('fresh client without persisted state does not seed', async () => {
    applySyncedSettings({})
    await sleep(300)
    expect(fetchCalls.length).toBe(0)
  })

  test('theme not seeded when its own storage entry is absent', async () => {
    // settings persisted, theme never toggled (no agentboard-theme entry)
    storage.setItem('agentboard-settings', '{"state":{},"version":8}')

    applySyncedSettings({})
    await sleep(300)

    expect(fetchCalls.length).toBe(1)
    const pushed = fetchCalls[0].body.settings
    expect(pushed.theme).toBeUndefined()
    expect(pushed.sessionSortMode).toBe('created')
  })
})
