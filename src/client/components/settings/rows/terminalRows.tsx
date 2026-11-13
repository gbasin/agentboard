/**
 * Terminal page: renderer and mobile autocorrect (this device), tmux mouse mode and color handling
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
import { SWITCH_TOUCH_TARGET } from '../styles'
import type { RowControlProps, SettingsRowDef } from '../types'
import { useServerSetting, type ServerSettingName } from '../useServerSetting'

const SHORTCUTS = [
  ['Session above', '['],
  ['Session below', ']'],
  ['Select session 1–9', '1–9'],
  ['New session', 'N'],
  ['Kill selected session', 'X'],
  ['Settings', ','],
] as const

function WebGLControl({ ids }: RowControlProps) {
  const checked = useSettingsStore((state) => state.useWebGL)
  const set = useSettingsStore((state) => state.setUseWebGL)
  return (
    <Switch
      className={SWITCH_TOUCH_TARGET}
      id={ids.control}
      checked={checked}
      onCheckedChange={set}
      ariaLabelledBy={ids.label}
      ariaDescribedBy={ids.description}
    />
  )
}

function MobileAutocorrectControl({ ids }: RowControlProps) {
  const checked = useSettingsStore((state) => state.mobileAutocorrect)
  const set = useSettingsStore((state) => state.setMobileAutocorrect)
  return (
    <Switch
      className={SWITCH_TOUCH_TARGET}
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
    // Disabled only until the value loads: disabling a focused switch during
    // a write would drop keyboard focus to <body>. Writes queue in order.
    const { value, loaded, set } = useServerSetting<boolean>(name, 'enabled', fallback)
    return (
      <Switch
        className={SWITCH_TOUCH_TARGET}
        id={ids.control}
        checked={value}
        onCheckedChange={set}
        disabled={!loaded}
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
  const mod = getModifierDisplay(getEffectiveModifier(value))
  return (
    <div className="w-full space-y-4">
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
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 text-[12px] text-secondary">
        {SHORTCUTS.map(([label, key]) => (
          <ShortcutEntry key={key} label={label} shortcut={`${mod}${key}`} />
        ))}
      </dl>
    </div>
  )
}

function ShortcutEntry({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-right"><kbd className="font-mono text-primary">{shortcut}</kbd></dd>
    </>
  )
}

export const terminalRows: SettingsRowDef[] = [
  {
    id: 'mobile-autocorrect',
    page: 'terminal',
    label: 'Mobile autocorrect',
    description: 'Keyboard suggestions and corrections on iOS and Android. Experimental; turn off for complex text editing.',
    keywords: ['keyboard', 'spelling', 'predictive', 'typing', 'gboard', 'iphone', 'ipad'],
    tags: ['device'],
    Control: MobileAutocorrectControl,
  },
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
    keywords: ['keyboard', 'shortcut', 'hotkey', 'ctrl', 'cmd', 'option', 'shift', 'navigation', 'new session', 'kill', 'select session'],
    tags: ['desktop', 'device'],
    layout: 'block',
    Control: ShortcutModifierControl,
  },
]
