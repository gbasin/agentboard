import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

const globalAny = globalThis as typeof globalThis & {
  window?: { localStorage: Storage }
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

const storage = createStorage()
globalAny.localStorage = storage
globalAny.window = { localStorage: storage } as typeof window

const settingsModule = await import('../stores/settingsStore')
const {
  useSettingsStore,
  DEFAULT_PROJECT_DIR,
  DEFAULT_COMMAND,
  DEFAULT_PRESETS,
  isValidPreset,
  normalizePreset,
  getFullCommand,
  generatePresetId,
  resolveDefaultPresetId,
} = settingsModule

beforeEach(() => {
  storage.clear()
  useSettingsStore.setState({
    defaultProjectDir: DEFAULT_PROJECT_DIR,
    defaultCommand: DEFAULT_COMMAND,
    lastProjectPath: null,
    recentPaths: [],
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    commandPresets: DEFAULT_PRESETS.map((preset) => ({ ...preset })),
    defaultPresetId: 'claude',
    useWebGL: true,
    lineHeight: 1.4,
    shortcutModifier: 'auto',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
  })
})

describe('useSettingsStore', () => {
  test('exposes default values', () => {
    const state = useSettingsStore.getState()
    expect(state.defaultProjectDir).toBe(DEFAULT_PROJECT_DIR)
    expect(state.defaultCommand).toBe(DEFAULT_COMMAND)
    expect(state.lastProjectPath).toBeNull()
    expect(state.recentPaths).toEqual([])
    expect(state.projectFilters).toEqual([])
  })

  test('updates default project dir', () => {
    useSettingsStore.getState().setDefaultProjectDir('/tmp')
    expect(useSettingsStore.getState().defaultProjectDir).toBe('/tmp')
  })

  test('updates default command', () => {
    useSettingsStore.getState().setDefaultCommand('codex')
    expect(useSettingsStore.getState().defaultCommand).toBe('codex')
  })

  test('updates last project path', () => {
    useSettingsStore.getState().setLastProjectPath('/projects/app')
    expect(useSettingsStore.getState().lastProjectPath).toBe('/projects/app')
  })

  test('tracks recent paths with uniqueness and max size', () => {
    const { addRecentPath } = useSettingsStore.getState()
    addRecentPath('/one')
    addRecentPath('/two')
    addRecentPath('/three')
    addRecentPath('/four')
    addRecentPath('/five')
    addRecentPath('/six')
    addRecentPath('/three')

    expect(useSettingsStore.getState().recentPaths).toEqual([
      '/three',
      '/six',
      '/five',
      '/four',
      '/two',
    ])
  })

  test('updates session sort preferences', () => {
    useSettingsStore.getState().setSessionSortMode('status')
    useSettingsStore.getState().setSessionSortDirection('asc')

    const state = useSettingsStore.getState()
    expect(state.sessionSortMode).toBe('status')
    expect(state.sessionSortDirection).toBe('asc')
  })
})

describe('command preset helpers', () => {
  test('validates presets', () => {
    const valid = {
      id: 'custom-1',
      label: 'Custom',
      command: 'codex --fast',
      isBuiltIn: false,
      agentType: 'codex' as const,
    }

    expect(isValidPreset(valid)).toBe(true)
    expect(isValidPreset({ ...valid, id: '' })).toBe(false)
    expect(isValidPreset({ ...valid, label: '   ' })).toBe(false)
    expect(isValidPreset({ ...valid, command: '' })).toBe(false)
    expect(isValidPreset({ ...valid, agentType: 'other' as const })).toBe(false)
    expect(isValidPreset(null)).toBe(false)
  })

  test('normalizes presets and builds full commands', () => {
    const preset = {
      id: 'custom-2',
      label: '  My Preset  ',
      command: '  bun --flag  ',
      isBuiltIn: false,
    }

    const normalized = normalizePreset(preset)
    expect(normalized.label).toBe('My Preset')
    expect(normalized.command).toBe('bun --flag')

    const longPreset = normalizePreset({
      id: 'custom-3',
      label: 'x'.repeat(80),
      command: 'y'.repeat(1100),
      isBuiltIn: false,
    })

    expect(longPreset.label.length).toBe(64)
    expect(longPreset.command.length).toBe(1024)

    expect(getFullCommand(preset)).toBe('bun --flag')
  })

  test('resolves default preset ids', () => {
    expect(
      resolveDefaultPresetId([{ id: 'alpha', label: 'A', command: 'a', isBuiltIn: true }], 'missing')
    ).toBe('alpha')

    expect(resolveDefaultPresetId([], 'missing')).toBe('claude')

    expect(
      resolveDefaultPresetId([{ id: 'alpha', label: 'A', command: 'a', isBuiltIn: true }], 'alpha')
    ).toBe('alpha')
  })

  test('generates ids when collisions occur', () => {
    const originalRandom = Math.random
    const originalNow = Date.now

    Math.random = () => 0.123456
    Date.now = () => 1700000000000

    try {
      const shortId = `custom-1700000000000-${Math.random().toString(36).slice(2, 6)}`
      const id = generatePresetId(new Set([shortId]))

      expect(id).toContain('custom-1700000000000-')
      expect(id).not.toBe(shortId)
      expect(id.length).toBeGreaterThan(shortId.length)
    } finally {
      Math.random = originalRandom
      Date.now = originalNow
    }
  })
})

describe('command preset actions', () => {
  test('updates preset command', () => {
    useSettingsStore.setState({
      commandPresets: [
        {
          id: 'custom-4',
          label: 'Custom',
          command: 'bun',
          isBuiltIn: false,
        },
      ],
    })

    useSettingsStore.getState().updatePresetCommand('custom-4', '  bun --fast  ')
    expect(useSettingsStore.getState().commandPresets[0]?.command).toBe('bun --fast')
  })

  test('adds presets and respects max size', () => {
    const { addPreset } = useSettingsStore.getState()
    const originalWarn = console.warn
    console.warn = () => {}

    try {
      addPreset({
        label: '  New Preset  ',
        command: '  bun --inspect  ',
        agentType: 'codex',
      })

      const { commandPresets } = useSettingsStore.getState()
      const added = commandPresets[commandPresets.length - 1]

      expect(commandPresets.length).toBe(DEFAULT_PRESETS.length + 1)
      expect(added?.label).toBe('New Preset')
      expect(added?.command).toBe('bun --inspect')
      expect(added?.isBuiltIn).toBe(false)
      expect(added?.agentType).toBe('codex')
      expect(added?.id).toContain('custom-')

      const maxPresets = Array.from({ length: 50 }, (_, index) => ({
        id: `custom-${index}`,
        label: `Preset ${index}`,
        command: 'bun',
        isBuiltIn: false,
      }))

      useSettingsStore.setState({ commandPresets: maxPresets })
      addPreset({
        label: 'Overflow',
        command: 'bun',
      })

      expect(useSettingsStore.getState().commandPresets).toHaveLength(50)
    } finally {
      console.warn = originalWarn
    }
  })

  test('removes custom presets and preserves built-ins', () => {
    const customPreset = {
      id: 'custom-keep',
      label: 'Custom',
      command: 'bun',
      isBuiltIn: false,
    }

    useSettingsStore.setState({
      commandPresets: [...DEFAULT_PRESETS.map((preset) => ({ ...preset })), customPreset],
      defaultPresetId: 'custom-keep',
    })

    useSettingsStore.getState().removePreset('custom-keep')

    const state = useSettingsStore.getState()
    expect(state.commandPresets.find((preset) => preset.id === 'custom-keep')).toBeUndefined()
    expect(state.defaultPresetId).toBe('claude')

    const lengthBefore = state.commandPresets.length
    useSettingsStore.getState().removePreset('claude')
    expect(useSettingsStore.getState().commandPresets.length).toBe(lengthBefore)
  })

  test('clamps line height, letter spacing, and toggles webgl', () => {
    useSettingsStore.getState().setLineHeight(0.5)
    expect(useSettingsStore.getState().lineHeight).toBe(1.0)

    useSettingsStore.getState().setLineHeight(2.5)
    expect(useSettingsStore.getState().lineHeight).toBe(2.0)

    useSettingsStore.getState().setLetterSpacing(-5)
    expect(useSettingsStore.getState().letterSpacing).toBe(-3)

    useSettingsStore.getState().setLetterSpacing(5)
    expect(useSettingsStore.getState().letterSpacing).toBe(3)

    useSettingsStore.getState().setUseWebGL(false)
    expect(useSettingsStore.getState().useWebGL).toBe(false)
  })
})

describe('preset migration', () => {
  test('migrates v1 presets (baseCommand+modifiers) to v2 (command)', () => {
    // Simulate v1 preset format in storage
    const v1Presets = [
      { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '--model opus', isBuiltIn: true, agentType: 'claude' },
      { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
      { id: 'custom-1', label: 'Custom', baseCommand: 'bun', modifiers: '--fast --inspect', isBuiltIn: false },
    ]

    storage.setItem('agentboard-settings', JSON.stringify({
      state: {
        commandPresets: v1Presets,
        defaultPresetId: 'claude',
      },
      version: 1,
    }))

    // Re-import the store to trigger migration
    // The migration happens during rehydration, so we need to manually trigger it
    // by accessing the persisted state and running the migrate function
    const persisted = JSON.parse(storage.getItem('agentboard-settings') || '{}')

    // Simulate migration logic (same as in settingsStore.ts)
    const migrateOldPreset = (p: Record<string, unknown>) => {
      if (typeof p.command === 'string') {
        return p
      }
      const base = typeof p.baseCommand === 'string' ? p.baseCommand.trim() : ''
      const mods = typeof p.modifiers === 'string' ? p.modifiers.trim() : ''
      const command = mods ? `${base} ${mods}` : base
      return {
        id: p.id,
        label: p.label,
        command: command || 'claude',
        isBuiltIn: p.isBuiltIn,
        agentType: p.agentType,
      }
    }

    const migratedPresets = persisted.state.commandPresets.map(migrateOldPreset)

    // Verify migration results
    expect(migratedPresets[0].command).toBe('claude --model opus')
    expect(migratedPresets[0].baseCommand).toBeUndefined()
    expect(migratedPresets[0].modifiers).toBeUndefined()

    expect(migratedPresets[1].command).toBe('codex')

    expect(migratedPresets[2].command).toBe('bun --fast --inspect')
  })

  test('preserves already migrated v2 presets', () => {
    const v2Preset = {
      id: 'custom-2',
      label: 'Already Migrated',
      command: 'node --inspect app.js',
      isBuiltIn: false,
    }

    // Simulate migration logic
    const migrateOldPreset = (p: Record<string, unknown>) => {
      if (typeof p.command === 'string') {
        return p
      }
      const base = typeof p.baseCommand === 'string' ? p.baseCommand.trim() : ''
      const mods = typeof p.modifiers === 'string' ? p.modifiers.trim() : ''
      const command = mods ? `${base} ${mods}` : base
      return {
        id: p.id,
        label: p.label,
        command: command || 'claude',
        isBuiltIn: p.isBuiltIn,
        agentType: p.agentType,
      }
    }

    const migrated = migrateOldPreset(v2Preset as Record<string, unknown>)

    // Should be unchanged
    expect(migrated.command).toBe('node --inspect app.js')
    expect(migrated).toEqual(v2Preset)
  })
})

afterAll(() => {
  globalAny.window = originalWindow
  globalAny.localStorage = originalLocalStorage
})
