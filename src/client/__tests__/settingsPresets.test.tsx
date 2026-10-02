import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { PresetsTable } from '../components/settings/PresetsTable'
import {
  isCompletePreset,
  patchPreset,
  validatePresetField,
} from '../components/settings/presetEdits'
import {
  DEFAULT_PRESETS,
  MAX_PRESETS,
  useSettingsStore,
  type CommandPreset,
} from '../stores/settingsStore'

const custom: CommandPreset = {
  id: 'custom-1',
  label: 'Mine',
  command: 'mine --go',
  isBuiltIn: false,
}

const ids = { control: 'c', label: 'l', description: 'd' }
let renderer: TestRenderer.ReactTestRenderer | null = null

beforeEach(() => {
  useSettingsStore.setState({
    commandPresets: [...DEFAULT_PRESETS, custom],
    defaultPresetId: 'claude',
  })
})

afterEach(() => {
  if (renderer) act(() => renderer!.unmount())
  renderer = null
  useSettingsStore.setState({ commandPresets: DEFAULT_PRESETS, defaultPresetId: 'claude' })
})

function render() {
  act(() => {
    renderer = TestRenderer.create(<PresetsTable ids={ids} />)
  })
  return renderer!.root
}

const input = (root: ReactTestInstance, id: string) =>
  root.find((node) => node.type === 'input' && node.props.id === id)
const button = (root: ReactTestInstance, label: string) =>
  root.find((node) => node.type === 'button' && node.props['aria-label'] === label)
const presets = () => useSettingsStore.getState().commandPresets
const enter = { key: 'Enter', preventDefault: () => {} }

describe('presetEdits', () => {
  test('validates name and command', () => {
    expect(validatePresetField('label', '  ')).toBe('Name is required')
    expect(validatePresetField('label', 'x'.repeat(65))).toContain('at most 64')
    expect(validatePresetField('label', ' ok ')).toBeNull()
    expect(validatePresetField('command', '')).toBe('Command is required')
    expect(validatePresetField('command', 'x'.repeat(1025))).toContain('at most 1024')
    expect(validatePresetField('command', 'run')).toBeNull()
    expect(isCompletePreset({ label: 'a', command: '' })).toBe(false)
    expect(isCompletePreset({ label: 'a', command: 'b' })).toBe(true)
  })

  test('patchPreset normalizes only the target', () => {
    const next = patchPreset([custom, DEFAULT_PRESETS[0]], 'custom-1', { label: '  New  ' })
    expect(next[0].label).toBe('New')
    expect(next[1]).toBe(DEFAULT_PRESETS[0])
  })
})

describe('PresetsTable', () => {
  test('renders a labelled default column and every preset', () => {
    const root = render()
    const radios = root.findAll((node) => node.type === 'input' && node.props.type === 'radio')
    expect(radios).toHaveLength(DEFAULT_PRESETS.length + 1)
    expect(radios[0].props['aria-label']).toBe('Default preset: Claude')
    expect(radios[0].props.checked).toBe(true)
    const header = root.find((node) => node.props['aria-hidden'] === 'true' && node.type === 'div')
    expect(header.findAllByType('span').map((span) => span.props.children)).toContain('Default')
    // Built-ins can't be deleted; custom presets can and get an icon select.
    expect(root.findAll((node) => node.props['aria-label'] === 'Delete Claude')).toHaveLength(0)
    expect(button(root, 'Delete Mine')).toBeTruthy()
    expect(root.findAll((node) => node.type === 'select')).toHaveLength(1)
  })

  test('default radio writes immediately', () => {
    const root = render()
    const codex = root.find((node) => node.type === 'input' && node.props['aria-label'] === 'Default preset: Codex')
    act(() => codex.props.onChange())
    expect(useSettingsStore.getState().defaultPresetId).toBe('codex')
  })

  test('edits commit on blur and invalid edits stay local', () => {
    const root = render()
    const command = () => input(root, 'settings-preset-claude-command')
    act(() => command().props.onChange({ target: { value: ' claude --model opus ' } }))
    expect(presets()[0].command).toBe('claude')
    act(() => command().props.onBlur())
    expect(presets()[0].command).toBe('claude --model opus')

    const name = () => input(root, 'settings-preset-claude-label')
    act(() => name().props.onChange({ target: { value: '' } }))
    act(() => name().props.onBlur())
    expect(presets()[0].label).toBe('Claude')
    expect(name().props['aria-invalid']).toBe(true)
    expect(root.find((node) => node.props.id === 'settings-preset-claude-label-error').props.children).toBe('Name is required')
  })

  test('custom icon changes write immediately', () => {
    const root = render()
    const select = root.find((node) => node.type === 'select')
    act(() => select.props.onChange({ target: { value: 'codex' } }))
    expect(presets().find((p) => p.id === 'custom-1')?.agentType).toBe('codex')
    act(() => root.find((node) => node.type === 'select').props.onChange({ target: { value: '' } }))
    expect(presets().find((p) => p.id === 'custom-1')?.agentType).toBeUndefined()
  })

  test('a new preset joins the store only once name and command are valid', () => {
    const root = render()
    const add = () => root.find((node) => node.type === 'button' && node.props.children?.[1] === 'Add preset')
    act(() => add().props.onClick())
    expect(add().props.disabled).toBe(true)
    const before = presets().length
    const pendingRow = root.findAll((node) => node.props.role === 'listitem').at(-1)!
    const pendingId = pendingRow.props['data-preset-id'] as string
    expect(pendingId.startsWith('custom-')).toBe(true)

    const pendingSelect = pendingRow.find((node) => node.type === 'select')
    act(() => pendingSelect.props.onChange({ target: { value: 'pi' } }))

    act(() => input(root, `settings-preset-${pendingId}-label`).props.onChange({ target: { value: 'New one' } }))
    act(() => input(root, `settings-preset-${pendingId}-label`).props.onBlur())
    expect(presets()).toHaveLength(before)

    act(() => input(root, `settings-preset-${pendingId}-command`).props.onChange({ target: { value: ' run it ' } }))
    act(() => input(root, `settings-preset-${pendingId}-command`).props.onKeyDown(enter))
    expect(presets()).toHaveLength(before + 1)
    expect(presets().at(-1)).toEqual({
      id: pendingId,
      label: 'New one',
      command: 'run it',
      isBuiltIn: false,
      agentType: 'pi',
    })
    expect(add().props.disabled).toBe(false)
  })

  test('a pending preset can be discarded without confirmation', () => {
    const root = render()
    act(() => root.find((node) => node.type === 'button' && node.props.children?.[1] === 'Add preset').props.onClick())
    act(() => button(root, 'Discard new preset').props.onClick())
    expect(root.findAll((node) => node.props['aria-label'] === 'Discard new preset')).toHaveLength(0)
  })

  test('discarding a complete pending preset never saves it', () => {
    const root = render()
    const before = presets().length
    act(() => root.find((node) => node.type === 'button' && node.props.children?.[1] === 'Add preset').props.onClick())
    const pendingRow = root.findAll((node) => node.props.role === 'listitem').at(-1)!
    const pendingId = pendingRow.props['data-preset-id'] as string
    act(() => input(root, `settings-preset-${pendingId}-label`).props.onChange({ target: { value: 'Oops' } }))
    act(() => input(root, `settings-preset-${pendingId}-label`).props.onBlur())
    // Command typed but not yet committed: the cursor is still in the field.
    act(() => input(root, `settings-preset-${pendingId}-command`).props.onChange({ target: { value: 'oops' } }))

    // Pointer-down on Discard keeps focus in the input (no blur commit)...
    const discard = button(root, 'Discard new preset')
    const pointer = { prevented: false, preventDefault() { pointer.prevented = true } }
    discard.props.onPointerDown(pointer)
    expect(pointer.prevented).toBe(true)
    // ...and the click removes the row. The unmounting input then commits
    // its dirty draft, which must not resurrect the discarded preset.
    act(() => discard.props.onClick())
    expect(presets()).toHaveLength(before)
    expect(presets().some((p) => p.id === pendingId)).toBe(false)
    expect(root.findAll((node) => node.props.role === 'listitem')).toHaveLength(before)
  })

  test('stored rows have no pointer-down guard on delete', () => {
    const root = render()
    expect(button(root, 'Delete Mine').props.onPointerDown).toBeUndefined()
  })

  test('deleting needs a second click and moves the default', () => {
    useSettingsStore.setState({ defaultPresetId: 'custom-1' })
    const root = render()
    act(() => button(root, 'Delete Mine').props.onClick())
    expect(presets().some((p) => p.id === 'custom-1')).toBe(true)
    // Blur cancels the pending confirmation.
    act(() => button(root, 'Confirm delete Mine').props.onBlur())
    act(() => button(root, 'Delete Mine').props.onClick())
    act(() => button(root, 'Confirm delete Mine').props.onClick())
    expect(presets().some((p) => p.id === 'custom-1')).toBe(false)
    expect(useSettingsStore.getState().defaultPresetId).toBe('claude')
  })

  test('confirmation expires on its own', async () => {
    const root = render()
    act(() => button(root, 'Delete Mine').props.onClick())
    expect(button(root, 'Confirm delete Mine')).toBeTruthy()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4100)) })
    expect(button(root, 'Delete Mine')).toBeTruthy()
  }, 6000)

  test('respects MAX_PRESETS', () => {
    const many = Array.from({ length: MAX_PRESETS }, (_, i) => ({ ...custom, id: `custom-${i}`, label: `P${i}` }))
    useSettingsStore.setState({ commandPresets: many })
    const root = render()
    const add = root.find((node) => node.type === 'button' && node.props.children?.[1] === 'Add preset')
    expect(add.props.disabled).toBe(true)
    act(() => add.props.onClick())
    expect(root.findAll((node) => node.props.role === 'listitem')).toHaveLength(MAX_PRESETS)
    expect(JSON.stringify(root.findAll((node) => node.type === 'span').map((n) => n.props.children))).toContain('Maximum of')
  })
})
