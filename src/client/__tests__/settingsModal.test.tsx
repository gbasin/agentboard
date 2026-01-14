import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import SettingsModal from '../components/SettingsModal'
import {
  DEFAULT_PRESETS,
  DEFAULT_PROJECT_DIR,
  useSettingsStore,
} from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  localStorage?: Storage
}

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

beforeEach(() => {
  globalAny.localStorage = createStorage()
  useSettingsStore.setState({
    defaultProjectDir: '/projects',
    defaultCommand: 'codex',
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'codex',
    lastProjectPath: null,
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showSessionIdPrefix: false,
  })
})

afterEach(() => {
  globalAny.localStorage = originalLocalStorage
  useSettingsStore.setState({
    defaultProjectDir: DEFAULT_PROJECT_DIR,
    defaultCommand: 'claude',
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'claude',
    lastProjectPath: null,
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showSessionIdPrefix: false,
  })
})

describe('SettingsModal', () => {
  test('submits trimmed values and falls back to defaults', () => {
    let closed = 0
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={() => { closed += 1 }} />
      )
    })

    const inputs = renderer.root.findAllByType('input')
    const dirInput = inputs[0]

    act(() => {
      dirInput.props.onChange({ target: { value: '   ' } })
    })

    const statusButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Status')

    if (!statusButton) {
      throw new Error('Expected status button')
    }

    act(() => {
      statusButton.props.onClick()
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    const state = useSettingsStore.getState()
    expect(state.defaultProjectDir).toBe(DEFAULT_PROJECT_DIR)
    expect(state.sessionSortMode).toBe('status')
    expect(state.sessionSortDirection).toBe('desc')
    expect(state.commandPresets.length).toBe(2)
    expect(closed).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('resets draft values when reopened', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    const onClose = () => {}

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={onClose} />
      )
    })

    let inputs = renderer.root.findAllByType('input')
    const dirInput = inputs[0]

    act(() => {
      dirInput.props.onChange({ target: { value: '/dirty' } })
    })

    act(() => {
      useSettingsStore.setState({
        defaultProjectDir: '/next',
        defaultPresetId: 'claude',
        sessionSortMode: 'status',
        sessionSortDirection: 'asc',
      })
    })

    act(() => {
      renderer.update(<SettingsModal isOpen={false} onClose={onClose} />)
    })

    act(() => {
      renderer.update(<SettingsModal isOpen onClose={onClose} />)
    })

    inputs = renderer.root.findAllByType('input')
    expect(inputs[0].props.value).toBe('/next')

    const statusButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Status')

    if (!statusButton) {
      throw new Error('Expected status button')
    }

    expect(statusButton.props.className).toContain('btn-primary')

    act(() => {
      renderer.unmount()
    })
  })

  test('updates preset modifiers', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={() => {}} />
      )
    })

    // Find the modifiers input for Claude preset (first preset)
    const inputs = renderer.root.findAllByType('input')
    // Input layout: [dir, Claude label, Claude base, Claude modifiers, Codex label, Codex base, Codex modifiers]
    // The modifiers input for Claude is the 4th input (index 3)
    const claudeModifiersInput = inputs.find((input) =>
      input.props.placeholder === '--flag value'
    )

    if (!claudeModifiersInput) {
      throw new Error('Expected modifiers input')
    }

    act(() => {
      claudeModifiersInput.props.onChange({ target: { value: '--model opus' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    const state = useSettingsStore.getState()
    const claudePreset = state.commandPresets.find(p => p.id === 'claude')
    expect(claudePreset?.modifiers).toBe('--model opus')

    act(() => {
      renderer.unmount()
    })
  })
})
