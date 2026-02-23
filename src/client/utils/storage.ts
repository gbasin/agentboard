import type { StateStorage } from 'zustand/middleware'

function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value)
    },
    removeItem: (key) => {
      store.delete(key)
    },
  }
}

const memoryStorage = createMemoryStorage()

export const safeStorage: StateStorage = {
  getItem: (key) => {
    if (typeof localStorage === 'undefined') {
      return memoryStorage.getItem(key)
    }
    try {
      return localStorage.getItem(key)
    } catch {
      return memoryStorage.getItem(key)
    }
  },
  setItem: (key, value) => {
    if (typeof localStorage === 'undefined') {
      memoryStorage.setItem(key, value)
      return
    }
    try {
      localStorage.setItem(key, value)
    } catch {
      memoryStorage.setItem(key, value)
    }
  },
  removeItem: (key) => {
    if (typeof localStorage === 'undefined') {
      memoryStorage.removeItem(key)
      return
    }
    try {
      localStorage.removeItem(key)
    } catch {
      memoryStorage.removeItem(key)
    }
  },
}

/**
 * Single-key tab-scoped storage adapter for Zustand persist.
 *
 * Reads from localStorage once on hydration (good default for new tabs
 * and iOS PWA relaunches). After that, reads from an in-memory Map so
 * each browser tab maintains independent state. Writes always update
 * both in-memory and localStorage (keeping the global default fresh).
 *
 * This adapter is intentionally scoped to one persist key per instance.
 * Reusing one instance for multiple keys is unsupported.
 */
export function createTabStorage(expectedKey: string): StateStorage {
  const mem = new Map<string, string>()
  let hydrated = false

  const assertExpectedKey = (key: string) => {
    const metaEnv = (import.meta as { env?: { DEV?: boolean } }).env
    const isDev =
      typeof metaEnv?.DEV === 'boolean'
        ? metaEnv.DEV
        : typeof process !== 'undefined'
          ? process.env.NODE_ENV !== 'production'
          : false

    if (isDev && key !== expectedKey) {
      throw new Error(
        `createTabStorage("${expectedKey}") received unexpected key "${key}". ` +
          'Create a dedicated tab storage instance per persist key.'
      )
    }
  }

  return {
    getItem(key: string): string | null {
      assertExpectedKey(key)
      if (hydrated) return mem.get(key) ?? null
      hydrated = true
      // safeStorage is synchronous (defined above) — assertion is safe
      const value = safeStorage.getItem(key) as string | null
      if (value !== null) mem.set(key, value)
      return value
    },
    setItem(key: string, value: string) {
      assertExpectedKey(key)
      mem.set(key, value)
      safeStorage.setItem(key, value)
    },
    removeItem(key: string) {
      assertExpectedKey(key)
      mem.delete(key)
      safeStorage.removeItem(key)
    },
  }
}
