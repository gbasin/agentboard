import { afterEach, describe, expect, test } from 'bun:test'
import { safeStorage, createTabStorage } from '../utils/storage'

const globalAny = globalThis as any
const originalLocalStorage = globalAny.localStorage

afterEach(() => {
  if (originalLocalStorage === undefined) {
    delete globalAny.localStorage
  } else {
    globalAny.localStorage = originalLocalStorage
  }
})

function createStorage() {
  const store = new Map<string, string>()
  return {
    store,
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    } as Storage,
  }
}

describe('safeStorage', () => {
  test('uses memory storage when localStorage is missing', () => {
    delete globalAny.localStorage

    safeStorage.setItem('memory-key', 'value')
    expect(safeStorage.getItem('memory-key')).toBe('value')

    safeStorage.removeItem('memory-key')
    expect(safeStorage.getItem('memory-key')).toBeNull()
  })

  test('uses localStorage when available', () => {
    const { storage, store } = createStorage()
    globalAny.localStorage = storage

    safeStorage.setItem('local-key', 'local-value')
    expect(store.get('local-key')).toBe('local-value')
    expect(safeStorage.getItem('local-key')).toBe('local-value')

    safeStorage.removeItem('local-key')
    expect(store.has('local-key')).toBe(false)
  })

  test('falls back to memory storage on localStorage errors', () => {
    globalAny.localStorage = {
      getItem: () => {
        throw new Error('read-failed')
      },
      setItem: () => {
        throw new Error('write-failed')
      },
      removeItem: () => {
        throw new Error('remove-failed')
      },
    } as unknown as Storage

    safeStorage.setItem('fallback-key', 'fallback')
    expect(safeStorage.getItem('fallback-key')).toBe('fallback')

    safeStorage.removeItem('fallback-key')
    expect(safeStorage.getItem('fallback-key')).toBeNull()
  })
})

describe('createTabStorage', () => {
  test('first getItem reads from localStorage (hydration)', () => {
    const { storage, store } = createStorage()
    store.set('key', 'from-localstorage')
    globalAny.localStorage = storage

    const tab = createTabStorage()
    expect(tab.getItem('key')).toBe('from-localstorage')
  })

  test('after hydration, getItem reads from in-memory (ignores localStorage)', () => {
    const { storage, store } = createStorage()
    store.set('key', 'initial')
    globalAny.localStorage = storage

    const tab = createTabStorage()
    // Hydration read
    tab.getItem('key')

    // External localStorage change (simulating another tab writing)
    store.set('key', 'changed-by-other-tab')

    // Should still return the in-memory value, not the updated localStorage
    expect(tab.getItem('key')).toBe('initial')
  })

  test('setItem writes to both in-memory and localStorage', () => {
    const { storage, store } = createStorage()
    globalAny.localStorage = storage

    const tab = createTabStorage()
    // Trigger hydration
    tab.getItem('key')

    tab.setItem('key', 'new-value')
    // In-memory read
    expect(tab.getItem('key')).toBe('new-value')
    // localStorage also updated
    expect(store.get('key')).toBe('new-value')
  })

  test('removeItem clears both in-memory and localStorage', () => {
    const { storage, store } = createStorage()
    store.set('key', 'value')
    globalAny.localStorage = storage

    const tab = createTabStorage()
    // Hydrate then remove
    tab.getItem('key')
    tab.removeItem('key')

    expect(tab.getItem('key')).toBeNull()
    expect(store.has('key')).toBe(false)
  })

  test('returns null gracefully when localStorage is unavailable', () => {
    delete globalAny.localStorage

    const tab = createTabStorage()
    expect(tab.getItem('missing')).toBeNull()
  })
})
