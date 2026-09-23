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
