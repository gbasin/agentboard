/**
 * Appearance page: theme (synced) and terminal typography (this device).
 * Every control applies live, so the terminal behind the light backdrop
 * shows the result immediately.
 */
import {
  FONT_OPTIONS,
  useSettingsStore,
  type FontOption,
} from '../../../stores/settingsStore'
import { useThemeStore, type Theme } from '../../../stores/themeStore'
import { CommitInput } from '../controls/CommitInput'
import { Slider, Stepper } from '../controls/NumericControls'
import { SegmentedControl } from '../controls/SegmentedControl'
import { CONTROL_INPUT } from '../styles'
import type { RowControlProps, SettingsRowDef } from '../types'

export const FONT_SIZE_MIN = 6
export const FONT_SIZE_MAX = 24

function ThemeControl({ ids }: RowControlProps) {
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  return (
    <SegmentedControl<Theme>
      options={[
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'System' },
      ]}
      value={theme}
      onChange={setTheme}
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

function FontFamilyControl({ ids }: RowControlProps) {
  const value = useSettingsStore((state) => state.fontOption)
  const set = useSettingsStore((state) => state.setFontOption)
  return (
    <select
      id={ids.control}
      value={value}
      aria-describedby={ids.description}
      onChange={(event) => set(event.target.value as FontOption)}
      className={`${CONTROL_INPUT} w-44 max-md:w-full`}
    >
      {FONT_OPTIONS.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function CustomFontFamilyControl({ ids }: RowControlProps) {
  const value = useSettingsStore((state) => state.customFontFamily)
  return (
    <CommitInput
      id={ids.control}
      value={value}
      placeholder='"Fira Code", monospace'
      describedBy={ids.description}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      maxLength={256}
      wrapperClassName="w-60 max-md:w-full"
      className="font-mono"
      onCommit={(draft) => {
        useSettingsStore.getState().setCustomFontFamily(draft.trim())
        return null
      }}
    />
  )
}

function FontSizeControl({ ids }: RowControlProps) {
  const value = useSettingsStore((state) => state.fontSize)
  const set = useSettingsStore((state) => state.setFontSize)
  return (
    <Stepper
      value={value}
      min={FONT_SIZE_MIN}
      max={FONT_SIZE_MAX}
      onChange={set}
      noun="font size"
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

function LineHeightControl({ ids }: RowControlProps) {
  const value = useSettingsStore((state) => state.lineHeight)
  const set = useSettingsStore((state) => state.setLineHeight)
  return (
    <Slider
      id={ids.control}
      value={value}
      min={1}
      max={2}
      step={0.1}
      // Snap float drift (1.2000000000000002) from the range input.
      onChange={(next) => set(Math.round(next * 10) / 10)}
      format={(v) => v.toFixed(1)}
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

function LetterSpacingControl({ ids }: RowControlProps) {
  const value = useSettingsStore((state) => state.letterSpacing)
  const set = useSettingsStore((state) => state.setLetterSpacing)
  return (
    <Slider
      id={ids.control}
      value={value}
      min={-3}
      max={3}
      step={1}
      onChange={(next) => set(Math.round(next))}
      format={(v) => `${v}px`}
      labelledBy={ids.label}
      describedBy={ids.description}
    />
  )
}

export const appearanceRows: SettingsRowDef[] = [
  {
    id: 'theme',
    page: 'appearance',
    label: 'Theme',
    description: 'Light, dark, or follow the system setting.',
    keywords: ['dark mode', 'light mode', 'color', 'colour', 'system'],
    Control: ThemeControl,
  },
  {
    id: 'font-family',
    page: 'appearance',
    label: 'Font family',
    description: 'Terminal typeface. Default JetBrains Mono.',
    keywords: ['font', 'typeface', 'monospace'],
    tags: ['device'],
    Control: FontFamilyControl,
  },
  {
    id: 'custom-font-family',
    page: 'appearance',
    label: 'Custom font family',
    description: 'A CSS font-family list. Empty falls back to JetBrains Mono.',
    keywords: ['font', 'typeface', 'css'],
    tags: ['device'],
    layout: 'wide',
    visibleWhen: (state) => state.fontOption === 'custom',
    Control: CustomFontFamilyControl,
  },
  {
    id: 'font-size',
    page: 'appearance',
    label: 'Font size',
    description: `Terminal text size in pixels (${FONT_SIZE_MIN}–${FONT_SIZE_MAX}). Default 13.`,
    keywords: ['font', 'text', 'zoom', 'size'],
    tags: ['device'],
    Control: FontSizeControl,
  },
  {
    id: 'line-height',
    page: 'appearance',
    label: 'Line height',
    description: 'Vertical spacing, 1.0 compact to 2.0 spacious. Default 1.0.',
    keywords: ['spacing', 'leading', 'line'],
    tags: ['device'],
    Control: LineHeightControl,
  },
  {
    id: 'letter-spacing',
    page: 'appearance',
    label: 'Letter spacing',
    description: 'Extra space between characters in pixels (−3 to 3). Default 0.',
    keywords: ['spacing', 'tracking', 'kerning'],
    tags: ['device'],
    Control: LetterSpacingControl,
  },
]
