import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import NewSessionModal, {
  resolveProjectPath,
} from '../components/NewSessionModal'
import { DEFAULT_PRESETS } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
})

function setupDom() {
  const keyHandlers = new Map<string, EventListener>()
  const textarea = {
    removeAttribute: () => {},
    focus: () => {},
  }

  globalAny.document = {
    querySelector: () => textarea,
  } as unknown as Document

  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  } as unknown as Window & typeof globalThis

  return { keyHandlers }
}

describe('NewSessionModal helpers', () => {
  test('resolves project paths with base directories', () => {
    const resolvedBase = resolveProjectPath({
      value: ' ',
      activeProjectPath: ' /active ',
      lastProjectPath: '/last',
      defaultProjectDir: '/default',
    })
    expect(resolvedBase).toBe('/active')

    const resolvedRelative = resolveProjectPath({
      value: 'repo',
      activeProjectPath: undefined,
      lastProjectPath: '/base/',
      defaultProjectDir: '/default',
    })
    expect(resolvedRelative).toBe('/base/repo')

    const resolvedAbsolute = resolveProjectPath({
      value: '/abs/path',
      activeProjectPath: undefined,
      lastProjectPath: null,
      defaultProjectDir: '/default',
    })
    expect(resolvedAbsolute).toBe('/abs/path')

    const resolvedWindows = resolveProjectPath({
      value: 'C:\\work\\app',
      activeProjectPath: undefined,
      lastProjectPath: null,
      defaultProjectDir: '/default',
    })
    expect(resolvedWindows).toBe('C:\\work\\app')
  })
})

describe('NewSessionModal component', () => {
  test('submits resolved values and closes', () => {
    setupDom()

    const created: Array<{ path: string; name?: string; command?: string }> = []
    let closed = 0
    const updatedModifiers: Array<{ presetId: string; modifiers: string }> = []

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={(path, name, command) => {
            created.push({ path, name, command })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          onUpdateModifiers={(presetId, modifiers) => {
            updatedModifiers.push({ presetId, modifiers })
          }}
          lastProjectPath="/last"
          activeProjectPath="/active"
        />
      )
    })

    const inputs = renderer.root.findAllByType('input')
    const projectInput = inputs[0]
    const nameInput = inputs[1]

    act(() => {
      projectInput.props.onChange({ target: { value: 'repo' } })
      nameInput.props.onChange({ target: { value: ' Alpha ' } })
    })

    const buttons = renderer.root.findAllByType('button')
    const customButton = buttons.find((button) => button.props.children === 'Custom')

    if (!customButton) {
      throw new Error('Expected custom command button')
    }

    act(() => {
      customButton.props.onClick()
    })

    const commandInput = renderer.root.findAllByType('input')[2]

    act(() => {
      commandInput.props.onChange({ target: { value: ' bun run dev ' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    expect(created).toEqual([
      { path: '/active/repo', name: 'Alpha', command: 'bun run dev' },
    ])
    expect(closed).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('closes on overlay click and escape', () => {
    const { keyHandlers } = setupDom()
    let closed = 0

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          onUpdateModifiers={() => {}}
        />
      )
    })

    const overlay = renderer.root.findByProps({ role: 'dialog' })

    act(() => {
      overlay.props.onClick({ target: overlay, currentTarget: overlay })
    })

    act(() => {
      keyHandlers.get('keydown')?.({ key: 'Escape' } as KeyboardEvent)
    })

    expect(closed).toBe(2)

    act(() => {
      renderer.unmount()
    })
  })

  test('auto-saves modifiers when changed', () => {
    setupDom()

    const created: Array<{ path: string; name?: string; command?: string }> = []
    const updatedModifiers: Array<{ presetId: string; modifiers: string }> = []

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, name, command) => {
            created.push({ path, name, command })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          onUpdateModifiers={(presetId, modifiers) => {
            updatedModifiers.push({ presetId, modifiers })
          }}
          lastProjectPath="/last"
          activeProjectPath="/active"
        />
      )
    })

    // Find the modifiers input (third input after project path and name)
    const inputs = renderer.root.findAllByType('input')
    const modifiersInput = inputs[2]

    act(() => {
      modifiersInput.props.onChange({ target: { value: '--model opus' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    // Should have auto-saved the modifier
    expect(updatedModifiers).toEqual([
      { presetId: 'claude', modifiers: '--model opus' },
    ])

    // Command should include the modifier
    expect(created[0].command).toBe('claude --model opus')

    act(() => {
      renderer.unmount()
    })
  })
})
