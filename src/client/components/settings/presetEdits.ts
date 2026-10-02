/**
 * Pure helpers for editing command presets in the settings dialog. Presets
 * are a synced key, so every edit is validated here before it reaches the
 * store: a preset with an empty name or command is never written.
 */
import type { AgentType } from '@shared/types'
import { normalizePreset, type CommandPreset } from '../../stores/settingsStore'

export const PRESET_LABEL_MAX = 64
export const PRESET_COMMAND_MAX = 1024

export type PresetField = 'label' | 'command'

/** Icon choices for custom presets; '' is the generic terminal icon. */
export const PRESET_ICON_OPTIONS: ReadonlyArray<{ value: AgentType | ''; label: string }> = [
  { value: '', label: 'Terminal' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'pi', label: 'Pi' },
  { value: 'devin', label: 'Devin' },
  { value: 'grok', label: 'Grok' },
  { value: 'omp', label: 'OMP' },
]

export function validatePresetField(field: PresetField, value: string): string | null {
  const trimmed = value.trim()
  if (field === 'label') {
    if (!trimmed) return 'Name is required'
    if (trimmed.length > PRESET_LABEL_MAX) return `Name is at most ${PRESET_LABEL_MAX} characters`
    return null
  }
  if (!trimmed) return 'Command is required'
  if (trimmed.length > PRESET_COMMAND_MAX) return `Command is at most ${PRESET_COMMAND_MAX} characters`
  return null
}

export function isCompletePreset(preset: Pick<CommandPreset, 'label' | 'command'>): boolean {
  return (
    validatePresetField('label', preset.label) === null &&
    validatePresetField('command', preset.command) === null
  )
}

/** Apply a patch to one preset, normalizing (trimming) the result. */
export function patchPreset(
  presets: readonly CommandPreset[],
  id: string,
  patch: Partial<Pick<CommandPreset, 'label' | 'command' | 'agentType'>>
): CommandPreset[] {
  return presets.map((preset) =>
    preset.id === id ? normalizePreset({ ...preset, ...patch }) : preset
  )
}
