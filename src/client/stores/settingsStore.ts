import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'

const DEFAULT_PROJECT_DIR = '~/Documents/GitHub'
const DEFAULT_COMMAND = 'claude'
const MAX_PRESETS = 50

// Terminal font configuration
export type FontOption = 'jetbrains-mono' | 'system' | 'custom'

export const FONT_OPTIONS: { id: FontOption; label: string; family: string }[] = [
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    family: '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "Fira Code", ui-monospace, monospace',
  },
  {
    id: 'system',
    label: 'System Default',
    family: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", "Consolas", monospace',
  },
  {
    id: 'custom',
    label: 'Custom',
    family: '', // Uses customFontFamily setting
  },
]

export function getFontFamily(fontOption: FontOption, customFontFamily: string): string {
  if (fontOption === 'custom' && customFontFamily.trim()) {
    return customFontFamily.trim()
  }
  const option = FONT_OPTIONS.find((o) => o.id === fontOption)
  return option?.family || FONT_OPTIONS[0].family
}

export type SessionSortMode = 'status' | 'created' | 'manual'
export type SessionSortDirection = 'asc' | 'desc'
export type ShortcutModifier = 'ctrl-option' | 'ctrl-shift' | 'cmd-option' | 'cmd-shift'

// Command preset system
export interface CommandPreset {
  id: string
  label: string
  command: string
  isBuiltIn: boolean
  agentType?: 'claude' | 'codex' | 'pi'
}

export const DEFAULT_PRESETS: CommandPreset[] = [
  { id: 'claude', label: 'Claude', command: 'claude', isBuiltIn: true, agentType: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex', isBuiltIn: true, agentType: 'codex' },
  { id: 'pi', label: 'Pi', command: 'pi', isBuiltIn: true, agentType: 'pi' },
]

// Validation and helper functions
export function isValidPreset(p: unknown): p is CommandPreset {
  if (typeof p !== 'object' || p === null) return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === 'string' && obj.id.length >= 1 && obj.id.length <= 128 &&
    typeof obj.label === 'string' && obj.label.trim().length >= 1 && obj.label.length <= 64 &&
    typeof obj.command === 'string' && obj.command.trim().length >= 1 && obj.command.length <= 1024 &&
    typeof obj.isBuiltIn === 'boolean' &&
    (obj.agentType === undefined || obj.agentType === 'claude' || obj.agentType === 'codex' || obj.agentType === 'pi')
  )
}

export function normalizePreset(p: CommandPreset): CommandPreset {
  return {
    ...p,
    label: p.label.trim().slice(0, 64),
    command: p.command.trim().slice(0, 1024),
  }
}

export function getFullCommand(preset: CommandPreset): string {
  return preset.command.trim()
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

// Sidebar width constraints
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 400
const SIDEBAR_DEFAULT_WIDTH = 240

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
  manualSessionOrder: string[]
  setManualSessionOrder: (order: string[]) => void
  useWebGL: boolean
  setUseWebGL: (enabled: boolean) => void
  fontSize: number
  setFontSize: (size: number) => void
  lineHeight: number
  setLineHeight: (height: number) => void
  letterSpacing: number
  setLetterSpacing: (spacing: number) => void
  fontOption: FontOption
  setFontOption: (option: FontOption) => void
  customFontFamily: string
  setCustomFontFamily: (family: string) => void
  shortcutModifier: ShortcutModifier | 'auto'
  setShortcutModifier: (modifier: ShortcutModifier | 'auto') => void
  showProjectName: boolean
  setShowProjectName: (enabled: boolean) => void
  showLastUserMessage: boolean
  setShowLastUserMessage: (enabled: boolean) => void
  showSessionIdPrefix: boolean
  setShowSessionIdPrefix: (enabled: boolean) => void
  inactiveSessionsExpanded: boolean
  setInactiveSessionsExpanded: (expanded: boolean) => void
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  projectFilters: string[]
  setProjectFilters: (filters: string[]) => void
  hostFilters: string[]
  setHostFilters: (filters: string[]) => void
  // Sound notifications
  soundOnPermission: boolean
  setSoundOnPermission: (enabled: boolean) => void
  soundOnIdle: boolean
  setSoundOnIdle: (enabled: boolean) => void

  // Command presets
  commandPresets: CommandPreset[]
  setCommandPresets: (presets: CommandPreset[]) => void
  defaultPresetId: string
  setDefaultPresetId: (id: string) => void
  updatePresetCommand: (presetId: string, command: string) => void
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
      manualSessionOrder: [],
      setManualSessionOrder: (order) => set({ manualSessionOrder: order }),
      useWebGL: true,
      setUseWebGL: (enabled) => set({ useWebGL: enabled }),
      fontSize: 13,
      setFontSize: (size) => set({ fontSize: Math.max(6, Math.min(24, size)) }),
      lineHeight: 1.0,
      setLineHeight: (height) => set({ lineHeight: Math.max(1.0, Math.min(2.0, height)) }),
      letterSpacing: 0,
      setLetterSpacing: (spacing) => set({ letterSpacing: Math.max(-3, Math.min(3, spacing)) }),
      fontOption: 'jetbrains-mono',
      setFontOption: (option) => set({ fontOption: option }),
      customFontFamily: '',
      setCustomFontFamily: (family) => set({ customFontFamily: family.slice(0, 256) }),
      shortcutModifier: 'auto',
      setShortcutModifier: (modifier) => set({ shortcutModifier: modifier }),
      showProjectName: true,
      setShowProjectName: (enabled) => set({ showProjectName: enabled }),
      showLastUserMessage: true,
      setShowLastUserMessage: (enabled) => set({ showLastUserMessage: enabled }),
      showSessionIdPrefix: false,
      setShowSessionIdPrefix: (enabled) => set({ showSessionIdPrefix: enabled }),
      inactiveSessionsExpanded: false,
      setInactiveSessionsExpanded: (expanded) => set({ inactiveSessionsExpanded: expanded }),
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      setSidebarWidth: (width) =>
        set({
          sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)),
        }),
      projectFilters: [],
      setProjectFilters: (filters) => set({ projectFilters: filters }),
      hostFilters: [],
      setHostFilters: (filters) => set({ hostFilters: filters }),
      // Sound notifications
      soundOnPermission: false,
      setSoundOnPermission: (enabled) => set({ soundOnPermission: enabled }),
      soundOnIdle: false,
      setSoundOnIdle: (enabled) => set({ soundOnIdle: enabled }),

      // Command presets
      commandPresets: DEFAULT_PRESETS,
      setCommandPresets: (presets) => set({ commandPresets: presets }),
      defaultPresetId: 'claude',
      setDefaultPresetId: (id) => set({ defaultPresetId: id }),
      updatePresetCommand: (presetId, command) => {
        const { commandPresets } = get()
        const updated = commandPresets.map(p =>
          p.id === presetId ? { ...p, command: command.trim().slice(0, 1024) } : p
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
      version: 4,
      partialize: (state) => {
        // Exclude manualSessionOrder from persistence (session-only state)
        const { manualSessionOrder: _, ...rest } = state
        return rest
      },
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Record<string, unknown>

        // Helper to migrate old preset format (baseCommand+modifiers) to new (command)
        const migrateOldPreset = (p: Record<string, unknown>): CommandPreset => {
          // Check if already new format
          if (typeof p.command === 'string') {
            return p as unknown as CommandPreset
          }
          // Migrate from baseCommand+modifiers
          const base = typeof p.baseCommand === 'string' ? p.baseCommand.trim() : ''
          const mods = typeof p.modifiers === 'string' ? p.modifiers.trim() : ''
          const command = mods ? `${base} ${mods}` : base
          return {
            id: p.id as string,
            label: p.label as string,
            command: command || 'claude',
            isBuiltIn: p.isBuiltIn as boolean,
            agentType: p.agentType as 'claude' | 'codex' | 'pi' | undefined,
          }
        }

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
              command: oldCmd,
              isBuiltIn: false,
            }
            presets.push(customPreset)
            defaultPresetId = customPreset.id
          }

          console.info('[agentboard:settings] Migrated from v0 to v2')
          return {
            ...state,
            commandPresets: presets,
            defaultPresetId,
            defaultCommand: oldCmd,
            recentPaths: [],
          }
        }

        // Migrate v1 presets (baseCommand+modifiers) to v2 (single command)
        const rawPresets = state.commandPresets as Record<string, unknown>[]
        const migratedPresets = rawPresets.map(migrateOldPreset)

        // Validate migrated presets
        const validPresets = migratedPresets.filter(isValidPreset)
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

        // Ensure all built-in presets from DEFAULT_PRESETS are present
        const existingIds = new Set(trimmedPresets.map(p => p.id))
        const missingBuiltIns = DEFAULT_PRESETS.filter(p => p.isBuiltIn && !existingIds.has(p.id))
        const finalPresets = [...trimmedPresets, ...missingBuiltIns]

        if (version < 4) {
          console.info(`[agentboard:settings] Migrated from v${version} to v4 (ensured all built-in presets)`)
        }

        return {
          ...state,
          commandPresets: finalPresets.map(normalizePreset),
          defaultPresetId: resolveDefaultPresetId(
            trimmedPresets,
            state.defaultPresetId as string
          ),
        }
      },
    }
  )
)

export {
  DEFAULT_PROJECT_DIR,
  DEFAULT_COMMAND,
  MAX_PRESETS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
}
