import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'

const DEFAULT_PROJECT_DIR = '~/Documents/GitHub'
const DEFAULT_COMMAND = 'claude'

export type SessionSortMode = 'status' | 'created'
export type SessionSortDirection = 'asc' | 'desc'

interface SettingsState {
  defaultProjectDir: string
  setDefaultProjectDir: (dir: string) => void
  defaultCommand: string
  setDefaultCommand: (cmd: string) => void
  lastProjectPath: string | null
  setLastProjectPath: (path: string) => void
  sessionSortMode: SessionSortMode
  setSessionSortMode: (mode: SessionSortMode) => void
  sessionSortDirection: SessionSortDirection
  setSessionSortDirection: (direction: SessionSortDirection) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultProjectDir: DEFAULT_PROJECT_DIR,
      setDefaultProjectDir: (dir) => set({ defaultProjectDir: dir }),
      defaultCommand: DEFAULT_COMMAND,
      setDefaultCommand: (cmd) => set({ defaultCommand: cmd }),
      lastProjectPath: null,
      setLastProjectPath: (path) => set({ lastProjectPath: path }),
      sessionSortMode: 'created',
      setSessionSortMode: (mode) => set({ sessionSortMode: mode }),
      sessionSortDirection: 'desc',
      setSessionSortDirection: (direction) =>
        set({ sessionSortDirection: direction }),
    }),
    {
      name: 'agentboard-settings',
      storage: createJSONStorage(() => safeStorage),
    }
  )
)

export { DEFAULT_PROJECT_DIR, DEFAULT_COMMAND }
