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
    hostFilters: [],
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
    expect(state.hostFilters).toEqual([])
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

async function rehydratePresets(commandPresets: unknown[], defaultPresetId: string, version = 6) {
  storage.setItem('agentboard-settings', JSON.stringify({
    state: { commandPresets, defaultPresetId },
    version,
  }))
  await useSettingsStore.persist.rehydrate()
  return useSettingsStore.getState()
}

describe('preset migration', () => {
  test('migrates v1 presets from baseCommand and modifiers', async () => {
    const { commandPresets } = await rehydratePresets([
      { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '--model opus', isBuiltIn: true, agentType: 'claude' },
      { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
      { id: 'custom-1', label: 'Custom', baseCommand: 'bun', modifiers: '--fast --inspect', isBuiltIn: false },
    ], 'claude', 1)

    expect(commandPresets[0].command).toBe('claude --model opus')
    expect(commandPresets[0]).not.toHaveProperty('baseCommand')
    expect(commandPresets[0]).not.toHaveProperty('modifiers')
    expect(commandPresets[1].command).toBe('codex')
    expect(commandPresets[2].command).toBe('bun --fast --inspect')
  })

  test('preserves already migrated v2 presets', async () => {
    const preset = {
      id: 'custom-2', label: 'Already Migrated',
      command: 'node --inspect app.js', isBuiltIn: false,
    }
    const { commandPresets, defaultPresetId } = await rehydratePresets(
      [...DEFAULT_PRESETS, preset], preset.id, 2
    )

    expect(commandPresets.find((p) => p.id === preset.id)).toEqual(preset)
    expect(defaultPresetId).toBe(preset.id)
  })

  test('adds Grok to v6 settings while preserving edited commands and the custom default', async () => {
    const custom = { id: 'custom-default', label: 'My task', command: 'bun run task', isBuiltIn: false }
    const existing = [
      ...DEFAULT_PRESETS.filter((p) => p.id !== 'grok').map((p) =>
        p.id === 'claude' ? { ...p, command: 'claude --model opus' } : p
      ),
      custom,
    ]
    const { commandPresets, defaultPresetId } = await rehydratePresets(existing, custom.id)

    expect(commandPresets).toEqual([
      ...existing,
      { id: 'grok', label: 'Grok', command: 'grok', isBuiltIn: true },
    ])
    expect(defaultPresetId).toBe(custom.id)
    const persisted = JSON.parse(storage.getItem('agentboard-settings')!)
    expect(persisted.version).toBe(7)
    await useSettingsStore.persist.rehydrate()
    expect(useSettingsStore.getState().commandPresets).toEqual(commandPresets)
  })

  test.each([50, 52])('keeps all %i existing presets and their default when adding Grok', async (count) => {
    const builtIns = DEFAULT_PRESETS.filter((p) => p.id !== 'grok')
    const existing = [
      ...builtIns,
      ...Array.from({ length: count - builtIns.length }, (_, i) => ({
        id: `custom-${i}`, label: `Task ${i}`, command: `task-${i}`, isBuiltIn: false,
      })),
    ]
    const selected = existing.at(-1)!.id
    const { commandPresets, defaultPresetId } = await rehydratePresets(existing, selected)

    expect(commandPresets).toHaveLength(count + 1)
    expect(commandPresets.slice(0, existing.length)).toEqual(existing)
    expect(commandPresets.at(-1)?.id).toBe('grok')
    expect(defaultPresetId).toBe(selected)
  })

  test('preserves an existing Grok command and default without adding a duplicate', async () => {
    const existing = DEFAULT_PRESETS.map((p) =>
      p.id === 'grok' ? { ...p, command: 'grok --custom-flag' } : p
    )
    const { commandPresets, defaultPresetId } = await rehydratePresets(existing, 'grok')

    expect(commandPresets).toEqual(existing)
    expect(commandPresets.filter((p) => p.id === 'grok')).toHaveLength(1)
    expect(defaultPresetId).toBe('grok')
  })
})

describe('settings persistence migration', () => {
  test('runs the hibernating/history expansion rename for v5 persisted state', async () => {
    const options = useSettingsStore.persist.getOptions()
    expect(options.version).toBe(7)
    if (!options.migrate) {
      throw new Error('Expected settings migration to be configured')
    }

    const migrated = await Promise.resolve(options.migrate({
      inactiveSessionsExpanded: true,
      snoozedSessionsExpanded: false,
      commandPresets: DEFAULT_PRESETS.map((preset) => ({ ...preset })),
      defaultPresetId: 'claude',
    }, 5)) as Record<string, unknown>

    expect(migrated.historySessionsExpanded).toBe(true)
    expect(migrated.hibernatingSessionsExpanded).toBe(false)
  })
})

describe('manual session order persistence', () => {
  test('setManualSessionOrder writes the order to persisted settings', () => {
    useSettingsStore.getState().setManualSessionOrder(['abc123', 'session:@2'])

    const persisted = JSON.parse(storage.getItem('agentboard-settings') || '{}')
    expect(persisted.state.manualSessionOrder).toEqual(['abc123', 'session:@2'])
  })

  test('persisted manual order rehydrates into the store', async () => {
    storage.setItem('agentboard-settings', JSON.stringify({
      state: { manualSessionOrder: ['session:@7'], sessionSortMode: 'manual' },
      version: 6,
    }))

    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().manualSessionOrder).toEqual(['session:@7'])
    expect(useSettingsStore.getState().sessionSortMode).toBe('manual')
  })
})

afterAll(() => {
  globalAny.window = originalWindow
  globalAny.localStorage = originalLocalStorage
})
