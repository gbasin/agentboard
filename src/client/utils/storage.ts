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
