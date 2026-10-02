/**
 * Terminal page: renderer (this device), tmux mouse mode and color handling
 * (server-wide), and the keyboard shortcut modifier (this device, desktop).
 * WebGL toggles live: useTerminal loads or disposes the addon when the
 * store value changes, so no reload or Save step is needed.
 */
import {
  useSettingsStore,
  type ShortcutModifier,
} from '../../../stores/settingsStore'
import { getEffectiveModifier, getModifierDisplay } from '../../../utils/device'
import { Switch } from '../../Switch'
import { SegmentedControl } from '../controls/SegmentedControl'
import type { RowControlProps, SettingsRowDef } from '../types'
import { useServerSetting, type ServerSettingName } from '../useServerSetting'

/** Keys the shortcut modifier combines with, as shown in hint text. */
export const SHORTCUT_KEYS_HINT = '1-9 [ ] N X ,'

function WebGLControl({ ids }: RowControlProps) {
  const checked = useSettingsStore((state) => state.useWebGL)
  const set = useSettingsStore((state) => state.setUseWebGL)
  return (
    <Switch
      id={ids.control}
      checked={checked}
      onCheckedChange={set}
      ariaLabelledBy={ids.label}
      ariaDescribedBy={ids.description}
    />
  )
}

function serverSwitch(name: ServerSettingName, fallback: boolean) {
  return function ServerSwitch({ ids }: RowControlProps) {
    const { value, loading, set } = useServerSetting<boolean>(name, 'enabled', fallback)
    return (
      <Switch
        id={ids.control}
        checked={value}
        onCheckedChange={set}
        disabled={loading}
        ariaLabelledBy={ids.label}
        ariaDescribedBy={ids.description}
      />
    )
  }
}

type ModifierChoice = ShortcutModifier | 'auto'

const MODIFIER_CHOICES: readonly ModifierChoice[] = [
  'auto',
  'ctrl-option',
  'ctrl-shift',
  'cmd-option',
  'cmd-shift',
]

function ShortcutModifierControl({ ids }: RowControlProps) {
  const value = useSettingsStore((state) => state.shortcutModifier)
  const set = useSettingsStore((state) => state.setShortcutModifier)
  return (
    <SegmentedControl<ModifierChoice>
      options={MODIFIER_CHOICES.map((choice) => ({
        value: choice,
        label: choice === 'auto' ? 'Auto' : getModifierDisplay(choice),
      }))}
      value={value}
      onChange={set}
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

function ShortcutModifierDescription() {
  const value = useSettingsStore((state) => state.shortcutModifier)
  const mod = getModifierDisplay(getEffectiveModifier(value))
  return (
    <>
      Shortcuts: {mod} + {SHORTCUT_KEYS_HINT} (sessions, navigate, new, kill, settings).
    </>
  )
}

export const terminalRows: SettingsRowDef[] = [
  {
    id: 'webgl',
    page: 'terminal',
    label: 'WebGL acceleration',
    description:
      'GPU rendering for better performance. Turn off if text looks fuzzy or flickers (common in Safari).',
    keywords: ['gpu', 'renderer', 'canvas', 'blurry', 'performance'],
    tags: ['device'],
    Control: WebGLControl,
  },
  {
    id: 'mouse-mode',
    page: 'terminal',
    label: 'Mouse mode',
    description: 'tmux mouse mode for trackpad and scroll wheel support.',
    keywords: ['tmux', 'scroll', 'trackpad', 'mouse'],
    Control: serverSwitch('tmux-mouse-mode', true),
  },
  {
    id: 'terminal-colors',
    page: 'terminal',
    label: 'Terminal colors',
    description:
      'Preserve ANSI colors in terminal output. Hibernate then Wake running agents after changing this.',
    keywords: ['ansi', 'color', 'colour'],
    Control: serverSwitch('terminal-colors', true),
  },
  {
    id: 'shortcut-modifier',
    page: 'terminal',
    label: 'Keyboard shortcut modifier',
    description: 'Modifier keys for the app shortcuts. Auto picks ⌃⌥ on macOS, ⌃⇧ elsewhere.',
    keywords: ['keyboard', 'shortcut', 'hotkey', 'ctrl', 'cmd', 'option', 'shift'],
    tags: ['desktop', 'device'],
    layout: 'wide',
    Description: ShortcutModifierDescription,
    Control: ShortcutModifierControl,
  },
]
