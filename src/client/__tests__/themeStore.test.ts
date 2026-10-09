import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

type Listener = (event: { matches: boolean }) => void

const globalAny = globalThis as typeof globalThis & {
  window?: { localStorage: Storage; matchMedia?: (q: string) => unknown }
  localStorage?: Storage
}

const originalWindow = globalAny.window
const originalLocalStorage = globalAny.localStorage

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

// Fake matchMedia whose result can be flipped and whose listeners can be fired
const media = {
  matches: true,
  listeners: new Set<Listener>(),
  removed: 0,
}
function matchMedia(query: string) {
  expect(query).toBe('(prefers-color-scheme: dark)')
  return {
    get matches() {
      return media.matches
    },
    addEventListener: (_type: string, listener: Listener) => {
      media.listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: Listener) => {
      media.listeners.delete(listener)
      media.removed++
    },
  }
}
function emitSystemScheme(dark: boolean) {
  media.matches = dark
  for (const listener of media.listeners) listener({ matches: dark })
}

const storage = createStorage()
globalAny.localStorage = storage
globalAny.window = { localStorage: storage, matchMedia } as unknown as typeof window

const themeModule = await import('../stores/themeStore')
const {
  useThemeStore,
  terminalThemes,
  resolveTheme,
  getResolvedTheme,
  initSystemThemeListener,
} = themeModule

beforeEach(() => {
  storage.clear()
  media.listeners.clear()
  media.matches = true
  useThemeStore.setState({ theme: 'dark', systemDark: true })
})

afterAll(() => {
  globalAny.window = originalWindow
  globalAny.localStorage = originalLocalStorage
})

describe('useThemeStore', () => {
  test('defaults to dark theme', () => {
    expect(useThemeStore.getState().theme).toBe('dark')
  })

  test('sets theme directly', () => {
    useThemeStore.getState().setTheme('light')
    expect(useThemeStore.getState().theme).toBe('light')
    useThemeStore.getState().setTheme('system')
    expect(useThemeStore.getState().theme).toBe('system')
  })

  test('toggles between explicit themes', () => {
    useThemeStore.getState().toggleTheme()
    expect(useThemeStore.getState().theme).toBe('light')
    useThemeStore.getState().toggleTheme()
    expect(useThemeStore.getState().theme).toBe('dark')
  })

  test('toggle from system picks the opposite of the resolved theme', () => {
    useThemeStore.setState({ theme: 'system', systemDark: false })
    useThemeStore.getState().toggleTheme()
    expect(useThemeStore.getState().theme).toBe('dark')

    useThemeStore.setState({ theme: 'system', systemDark: true })
    useThemeStore.getState().toggleTheme()
    expect(useThemeStore.getState().theme).toBe('light')
  })

  test('persists only the chosen theme, not the OS preference', () => {
    useThemeStore.getState().setTheme('system')
    const persisted = JSON.parse(storage.getItem('agentboard-theme') ?? '{}')
    expect(persisted.state).toEqual({ theme: 'system' })
  })
})

describe('resolveTheme', () => {
  test('explicit themes resolve to themselves', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  test('system resolves from the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  test('getResolvedTheme reads the store', () => {
    useThemeStore.setState({ theme: 'system', systemDark: false })
    expect(getResolvedTheme()).toBe('light')
    useThemeStore.setState({ theme: 'dark' })
    expect(getResolvedTheme()).toBe('dark')
  })
})

describe('initSystemThemeListener', () => {
  test('seeds systemDark and follows OS changes until unsubscribed', () => {
    media.matches = false
    const unsubscribe = initSystemThemeListener()
    expect(useThemeStore.getState().systemDark).toBe(false)
    expect(media.listeners.size).toBe(1)

    emitSystemScheme(true)
    expect(useThemeStore.getState().systemDark).toBe(true)

    const removedBefore = media.removed
    unsubscribe()
    expect(media.listeners.size).toBe(0)
    expect(media.removed).toBe(removedBefore + 1)

    emitSystemScheme(false)
    expect(useThemeStore.getState().systemDark).toBe(true)
  })

  test('is a no-op without matchMedia', () => {
    const win = globalAny.window as unknown as Record<string, unknown>
    const saved = win.matchMedia
    win.matchMedia = undefined
    try {
      const unsubscribe = initSystemThemeListener()
      expect(media.listeners.size).toBe(0)
      unsubscribe()
    } finally {
      win.matchMedia = saved
    }
  })
})

describe('terminalThemes', () => {
  test('exposes light and dark palettes', () => {
    expect(terminalThemes.dark).toBeTruthy()
    expect(terminalThemes.light).toBeTruthy()
  })
})
