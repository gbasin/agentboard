import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'

export type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark',
      setTheme: (theme) => set({ theme }),
      toggleTheme: () =>
        set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
    }),
    {
      name: 'agentboard-theme',
      storage: createJSONStorage(() => safeStorage),
    }
  )
)

// Terminal theme configurations for xterm.js
export const terminalThemes = {
  dark: {
    background: '#2d2d2d',
    foreground: '#d4d4d4',
    cursor: '#3b82f6',
    cursorAccent: '#2d2d2d',
    selectionBackground: 'rgba(59, 130, 246, 0.35)',
    selectionForeground: '#ffffff',
    black: '#808080',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d4d4d4',
    brightBlack: '#a0a0a0',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde047',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#fafafa',
    foreground: '#171717',
    cursor: '#2563eb',
    cursorAccent: '#fafafa',
    selectionBackground: 'rgba(37, 99, 235, 0.2)',
    selectionForeground: '#000000',
    black: '#171717',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#f5f5f5',
    brightBlack: '#737373',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#ffffff',
  },
}
