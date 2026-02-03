import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import SettingsModal from '../components/SettingsModal'
import {
  DEFAULT_PRESETS,
  DEFAULT_PROJECT_DIR,
  useSettingsStore,
} from '../stores/settingsStore'
import { useThemeStore } from '../stores/themeStore'

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
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    hostFilters: [],
  })
  useThemeStore.setState({ theme: 'dark' })
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
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    hostFilters: [],
  })
  useThemeStore.setState({ theme: 'dark' })
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
    expect(state.commandPresets.length).toBe(3)
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

  test('updates preset command', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={() => {}} />
      )
    })

    // Find the command input for Claude preset (first preset)
    const inputs = renderer.root.findAllByType('input')
    // Input layout: [dir, Claude label, Claude command, Codex label, Codex command]
    // The command input for Claude has placeholder 'command --flags'
    const claudeCommandInput = inputs.find((input) =>
      input.props.placeholder === 'command --flags'
    )

    if (!claudeCommandInput) {
      throw new Error('Expected command input')
    }

    act(() => {
      claudeCommandInput.props.onChange({ target: { value: 'claude --model opus' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    const state = useSettingsStore.getState()
    const claudePreset = state.commandPresets.find(p => p.id === 'claude')
    expect(claudePreset?.command).toBe('claude --model opus')

    act(() => {
      renderer.unmount()
    })
  })
})
