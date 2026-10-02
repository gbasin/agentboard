/**
 * Theme store. `theme` is the user's choice (synced across devices) and may
 * be 'system', which each device resolves against `prefers-color-scheme`.
 * Consumers that need a concrete palette read `useResolvedTheme()`.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'

export type ResolvedTheme = 'dark' | 'light'
export type Theme = ResolvedTheme | 'system'

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

function querySystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true
  }
  return window.matchMedia(DARK_SCHEME_QUERY).matches
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light'
  return theme
}

interface ThemeState {
  theme: Theme
  /** Current OS preference; kept fresh by `initSystemThemeListener`. */
  systemDark: boolean
  setTheme: (theme: Theme) => void
  setSystemDark: (dark: boolean) => void
  /** Flip to the explicit opposite of the currently resolved theme. */
  toggleTheme: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      systemDark: querySystemDark(),
      setTheme: (theme) => set({ theme }),
      setSystemDark: (dark) => set({ systemDark: dark }),
      toggleTheme: () => {
        const { theme, systemDark } = get()
        set({ theme: resolveTheme(theme, systemDark) === 'dark' ? 'light' : 'dark' })
      },
    }),
    {
      name: 'agentboard-theme',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ theme: state.theme }),
    }
  )
)

export function getResolvedTheme(): ResolvedTheme {
  const { theme, systemDark } = useThemeStore.getState()
  return resolveTheme(theme, systemDark)
}

export function useResolvedTheme(): ResolvedTheme {
  return useThemeStore((state) => resolveTheme(state.theme, state.systemDark))
}

/**
 * Track OS colour-scheme changes so 'system' follows them live. Returns an
 * unsubscribe function; a no-op where matchMedia is unavailable.
 */
export function initSystemThemeListener(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const query = window.matchMedia(DARK_SCHEME_QUERY)
  const onChange = (event: MediaQueryListEvent) => {
    useThemeStore.getState().setSystemDark(event.matches)
  }
  useThemeStore.getState().setSystemDark(query.matches)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

// Terminal theme configurations for xterm.js
export const terminalThemes: Record<ResolvedTheme, Record<string, string>> = {
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
