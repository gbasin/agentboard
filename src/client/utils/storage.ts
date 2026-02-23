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
 * Tab-scoped storage adapter for Zustand persist.
 *
 * Reads from localStorage once on hydration (good default for new tabs
 * and iOS PWA relaunches). After that, reads from an in-memory Map so
 * each browser tab maintains independent state. Writes always update
 * both in-memory and localStorage (keeping the global default fresh).
 */
export function createTabStorage(): StateStorage {
  const mem = new Map<string, string>()
  let hydrated = false

  return {
    getItem(key: string): string | null {
      if (hydrated) return mem.get(key) ?? null
      hydrated = true
      // safeStorage is synchronous (defined above) — assertion is safe
      const value = safeStorage.getItem(key) as string | null
      if (value !== null) mem.set(key, value)
      return value
    },
    setItem(key: string, value: string) {
      mem.set(key, value)
      safeStorage.setItem(key, value)
    },
    removeItem(key: string) {
      mem.delete(key)
      safeStorage.removeItem(key)
    },
  }
}
