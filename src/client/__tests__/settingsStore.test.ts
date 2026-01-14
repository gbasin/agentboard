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
    showSessionIdPrefix: false,
  })
})

describe('useSettingsStore', () => {
  test('exposes default values', () => {
    const state = useSettingsStore.getState()
    expect(state.defaultProjectDir).toBe(DEFAULT_PROJECT_DIR)
    expect(state.defaultCommand).toBe(DEFAULT_COMMAND)
    expect(state.lastProjectPath).toBeNull()
    expect(state.recentPaths).toEqual([])
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
      baseCommand: 'codex',
      modifiers: '--fast',
      isBuiltIn: false,
      agentType: 'codex' as const,
    }

    expect(isValidPreset(valid)).toBe(true)
    expect(isValidPreset({ ...valid, id: '' })).toBe(false)
    expect(isValidPreset({ ...valid, label: '   ' })).toBe(false)
    expect(isValidPreset({ ...valid, baseCommand: '' })).toBe(false)
    expect(isValidPreset({ ...valid, modifiers: 123 as unknown as string })).toBe(false)
    expect(isValidPreset({ ...valid, agentType: 'other' as const })).toBe(false)
    expect(isValidPreset(null)).toBe(false)
  })

  test('normalizes presets and builds full commands', () => {
    const preset = {
      id: 'custom-2',
      label: '  My Preset  ',
      baseCommand: '  bun  ',
      modifiers: '  --flag  ',
      isBuiltIn: false,
    }

    const normalized = normalizePreset(preset)
    expect(normalized.label).toBe('My Preset')
    expect(normalized.baseCommand).toBe('bun')
    expect(normalized.modifiers).toBe('--flag')

    const longPreset = normalizePreset({
      id: 'custom-3',
      label: 'x'.repeat(80),
      baseCommand: 'y'.repeat(300),
      modifiers: 'z'.repeat(1100),
      isBuiltIn: false,
    })

    expect(longPreset.label.length).toBe(64)
    expect(longPreset.baseCommand.length).toBe(256)
    expect(longPreset.modifiers.length).toBe(1024)

    expect(getFullCommand({ ...preset, modifiers: '' })).toBe('bun')
    expect(getFullCommand(preset)).toBe('bun --flag')
  })

  test('resolves default preset ids', () => {
    expect(
      resolveDefaultPresetId([{ id: 'alpha', label: 'A', baseCommand: 'a', modifiers: '', isBuiltIn: true }], 'missing')
    ).toBe('alpha')

    expect(resolveDefaultPresetId([], 'missing')).toBe('claude')

    expect(
      resolveDefaultPresetId([{ id: 'alpha', label: 'A', baseCommand: 'a', modifiers: '', isBuiltIn: true }], 'alpha')
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
  test('updates preset modifiers', () => {
    useSettingsStore.setState({
      commandPresets: [
        {
          id: 'custom-4',
          label: 'Custom',
          baseCommand: 'bun',
          modifiers: '',
          isBuiltIn: false,
        },
      ],
    })

    useSettingsStore.getState().updatePresetModifiers('custom-4', '  --fast  ')
    expect(useSettingsStore.getState().commandPresets[0]?.modifiers).toBe('--fast')
  })

  test('adds presets and respects max size', () => {
    const { addPreset } = useSettingsStore.getState()

    addPreset({
      label: '  New Preset  ',
      baseCommand: '  bun  ',
      modifiers: '  --inspect  ',
      agentType: 'codex',
    })

    const { commandPresets } = useSettingsStore.getState()
    const added = commandPresets[commandPresets.length - 1]

    expect(commandPresets.length).toBe(DEFAULT_PRESETS.length + 1)
    expect(added?.label).toBe('New Preset')
    expect(added?.baseCommand).toBe('bun')
    expect(added?.modifiers).toBe('--inspect')
    expect(added?.isBuiltIn).toBe(false)
    expect(added?.agentType).toBe('codex')
    expect(added?.id).toContain('custom-')

    const maxPresets = Array.from({ length: 50 }, (_, index) => ({
      id: `custom-${index}`,
      label: `Preset ${index}`,
      baseCommand: 'bun',
      modifiers: '',
      isBuiltIn: false,
    }))

    useSettingsStore.setState({ commandPresets: maxPresets })
    addPreset({
      label: 'Overflow',
      baseCommand: 'bun',
      modifiers: '',
    })

    expect(useSettingsStore.getState().commandPresets).toHaveLength(50)
  })

  test('removes custom presets and preserves built-ins', () => {
    const customPreset = {
      id: 'custom-keep',
      label: 'Custom',
      baseCommand: 'bun',
      modifiers: '',
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

  test('clamps line height and toggles webgl', () => {
    useSettingsStore.getState().setLineHeight(0.5)
    expect(useSettingsStore.getState().lineHeight).toBe(1.0)

    useSettingsStore.getState().setLineHeight(2.5)
    expect(useSettingsStore.getState().lineHeight).toBe(2.0)

    useSettingsStore.getState().setUseWebGL(false)
    expect(useSettingsStore.getState().useWebGL).toBe(false)
  })
})

afterAll(() => {
  globalAny.window = originalWindow
  globalAny.localStorage = originalLocalStorage
})
