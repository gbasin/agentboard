import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'

const DEFAULT_PROJECT_DIR = '~/Documents/GitHub'
const DEFAULT_COMMAND = 'claude'
const MAX_PRESETS = 50

export type SessionSortMode = 'status' | 'created'
export type SessionSortDirection = 'asc' | 'desc'
export type ShortcutModifier = 'ctrl-option' | 'ctrl-shift' | 'cmd-option' | 'cmd-shift'

// Command preset system
export interface CommandPreset {
  id: string
  label: string
  baseCommand: string
  modifiers: string
  isBuiltIn: boolean
  agentType?: 'claude' | 'codex'
}

export const DEFAULT_PRESETS: CommandPreset[] = [
  { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
  { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
]

// Validation and helper functions
export function isValidPreset(p: unknown): p is CommandPreset {
  if (typeof p !== 'object' || p === null) return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === 'string' && obj.id.length >= 1 && obj.id.length <= 128 &&
    typeof obj.label === 'string' && obj.label.trim().length >= 1 && obj.label.length <= 64 &&
    typeof obj.baseCommand === 'string' && obj.baseCommand.trim().length >= 1 && obj.baseCommand.length <= 256 &&
    (typeof obj.modifiers === 'string' || obj.modifiers === undefined) &&
    (obj.modifiers === undefined || obj.modifiers.length <= 1024) &&
    typeof obj.isBuiltIn === 'boolean' &&
    (obj.agentType === undefined || obj.agentType === 'claude' || obj.agentType === 'codex')
  )
}

export function normalizePreset(p: CommandPreset): CommandPreset {
  return {
    ...p,
    label: p.label.trim().slice(0, 64),
    baseCommand: p.baseCommand.trim().slice(0, 256),
    modifiers: (p.modifiers || '').trim().slice(0, 1024),
  }
}

export function getFullCommand(preset: CommandPreset): string {
  const base = preset.baseCommand.trim()
  const mods = preset.modifiers.trim()
  return mods ? `${base} ${mods}` : base
}

export function generatePresetId(existing: Set<string>): string {
  const maxAttempts = 100
  for (let i = 0; i < maxAttempts; i++) {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (!existing.has(id)) return id
  }
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function resolveDefaultPresetId(
  presets: CommandPreset[],
  currentId: string
): string {
  return presets.some(p => p.id === currentId) ? currentId : presets[0]?.id || 'claude'
}

interface SettingsState {
  defaultProjectDir: string
  setDefaultProjectDir: (dir: string) => void
  defaultCommand: string
  setDefaultCommand: (cmd: string) => void
  lastProjectPath: string | null
  setLastProjectPath: (path: string) => void
  recentPaths: string[]
  addRecentPath: (path: string) => void
  sessionSortMode: SessionSortMode
  setSessionSortMode: (mode: SessionSortMode) => void
  sessionSortDirection: SessionSortDirection
  setSessionSortDirection: (direction: SessionSortDirection) => void
  useWebGL: boolean
  setUseWebGL: (enabled: boolean) => void
  lineHeight: number
  setLineHeight: (height: number) => void
  shortcutModifier: ShortcutModifier | 'auto'
  setShortcutModifier: (modifier: ShortcutModifier | 'auto') => void
  showSessionIdPrefix: boolean
  setShowSessionIdPrefix: (enabled: boolean) => void
  inactiveSessionsExpanded: boolean
  setInactiveSessionsExpanded: (expanded: boolean) => void
  // Command presets
  commandPresets: CommandPreset[]
  setCommandPresets: (presets: CommandPreset[]) => void
  defaultPresetId: string
  setDefaultPresetId: (id: string) => void
  updatePresetModifiers: (presetId: string, modifiers: string) => void
  addPreset: (preset: Omit<CommandPreset, 'id' | 'isBuiltIn'>) => void
  removePreset: (presetId: string) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      defaultProjectDir: DEFAULT_PROJECT_DIR,
      setDefaultProjectDir: (dir) => set({ defaultProjectDir: dir }),
      defaultCommand: DEFAULT_COMMAND,
      setDefaultCommand: (cmd) => set({ defaultCommand: cmd }),
      lastProjectPath: null,
      setLastProjectPath: (path) => set({ lastProjectPath: path }),
      recentPaths: [],
      addRecentPath: (path) => set((state) => ({
        recentPaths: [path, ...state.recentPaths.filter(p => p !== path)].slice(0, 5),
      })),
      sessionSortMode: 'created',
      setSessionSortMode: (mode) => set({ sessionSortMode: mode }),
      sessionSortDirection: 'desc',
      setSessionSortDirection: (direction) =>
        set({ sessionSortDirection: direction }),
      useWebGL: true,
      setUseWebGL: (enabled) => set({ useWebGL: enabled }),
      lineHeight: 1.4,
      setLineHeight: (height) => set({ lineHeight: Math.max(1.0, Math.min(2.0, height)) }),
      shortcutModifier: 'auto',
      setShortcutModifier: (modifier) => set({ shortcutModifier: modifier }),
      showSessionIdPrefix: false,
      setShowSessionIdPrefix: (enabled) => set({ showSessionIdPrefix: enabled }),
      inactiveSessionsExpanded: false,
      setInactiveSessionsExpanded: (expanded) => set({ inactiveSessionsExpanded: expanded }),
      // Command presets
      commandPresets: DEFAULT_PRESETS,
      setCommandPresets: (presets) => set({ commandPresets: presets }),
      defaultPresetId: 'claude',
      setDefaultPresetId: (id) => set({ defaultPresetId: id }),
      updatePresetModifiers: (presetId, modifiers) => {
        const { commandPresets } = get()
        const updated = commandPresets.map(p =>
          p.id === presetId ? { ...p, modifiers: modifiers.trim().slice(0, 1024) } : p
        )
        set({ commandPresets: updated })
      },
      addPreset: (preset) => {
        const { commandPresets } = get()
        if (commandPresets.length >= MAX_PRESETS) {
          console.warn('[agentboard:settings] Max presets reached')
          return
        }
        const existingIds = new Set(commandPresets.map(p => p.id))
        const newPreset: CommandPreset = {
          ...normalizePreset({ ...preset, id: '', isBuiltIn: false }),
          id: generatePresetId(existingIds),
          isBuiltIn: false,
        }
        set({ commandPresets: [...commandPresets, newPreset] })
      },
      removePreset: (presetId) => {
        const { commandPresets, defaultPresetId } = get()
        const preset = commandPresets.find(p => p.id === presetId)
        if (!preset || preset.isBuiltIn) return
        const filtered = commandPresets.filter(p => p.id !== presetId)
        const newDefault = presetId === defaultPresetId
          ? resolveDefaultPresetId(filtered, defaultPresetId)
          : defaultPresetId
        set({ commandPresets: filtered, defaultPresetId: newDefault })
      },
    }),
    {
      name: 'agentboard-settings',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Record<string, unknown>

        if (version === 0 || !Array.isArray(state.commandPresets)) {
          // Migrate from old defaultCommand to new preset system
          const oldCmd = typeof state.defaultCommand === 'string'
            ? state.defaultCommand
            : 'claude'
          const presets: CommandPreset[] = [...DEFAULT_PRESETS]
          let defaultPresetId = 'claude'

          if (oldCmd === 'codex') {
            defaultPresetId = 'codex'
          } else if (oldCmd !== 'claude') {
            const existingIds = new Set(presets.map(p => p.id))
            const customPreset: CommandPreset = {
              id: generatePresetId(existingIds),
              label: 'Migrated',
              baseCommand: oldCmd,
              modifiers: '',
              isBuiltIn: false,
            }
            presets.push(customPreset)
            defaultPresetId = customPreset.id
          }

          console.info('[agentboard:settings] Migrated from v0 to v1')
          return {
            ...state,
            commandPresets: presets,
            defaultPresetId,
            defaultCommand: oldCmd,
            recentPaths: [],
          }
        }

        // Validate existing presets
        const validPresets = (state.commandPresets as unknown[]).filter(isValidPreset)
        const hasBuiltIns = validPresets.some(p => p.id === 'claude') &&
                           validPresets.some(p => p.id === 'codex')

        if (!hasBuiltIns || validPresets.length === 0) {
          console.warn('[agentboard:settings] Invalid presets, resetting to defaults')
          return {
            ...state,
            commandPresets: DEFAULT_PRESETS,
            defaultPresetId: 'claude',
          }
        }

        // Trim to max if needed
        const trimmedPresets = validPresets.length > MAX_PRESETS
          ? [...validPresets.filter(p => p.isBuiltIn),
             ...validPresets.filter(p => !p.isBuiltIn).slice(0, MAX_PRESETS - 2)]
          : validPresets

        return {
          ...state,
          commandPresets: trimmedPresets.map(normalizePreset),
          defaultPresetId: resolveDefaultPresetId(
            trimmedPresets,
            state.defaultPresetId as string
          ),
        }
      },
    }
  )
)

export { DEFAULT_PROJECT_DIR, DEFAULT_COMMAND, MAX_PRESETS }
