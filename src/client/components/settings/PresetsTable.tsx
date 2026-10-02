/**
 * PresetsTable - the command presets editor on the New sessions page.
 *
 * Stored rows edit the synced `commandPresets` key in place. "Add" appends
 * a pending row that lives only in local state until both name and command
 * are valid; it then joins the store under the id it was created with, so
 * React keeps the same row (and the focused input) across the hand-off.
 */
import { useEffect, useRef, useState } from 'react'
import type { AgentType } from '@shared/types'
import {
  MAX_PRESETS,
  generatePresetId,
  normalizePreset,
  useSettingsStore,
  type CommandPreset,
} from '../../stores/settingsStore'
import { cn } from '../../utils/cn'
import { ICON_SIZE } from '../controlStyles'
import { PlusIcon } from '../icons'
import { isCompletePreset, patchPreset, validatePresetField, type PresetField } from './presetEdits'
import { PRESET_GRID, PresetRow } from './PresetRow'
import { CONTROL_BUTTON, HELP_TEXT } from './styles'
import type { RowControlProps } from './types'

export function PresetsTable({ ids }: RowControlProps) {
  const presets = useSettingsStore((state) => state.commandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const [pending, setPending] = useState<CommandPreset | null>(null)
  // Mirror of `pending` for commits that fire while a row is unmounting
  // (a discarded row's inputs commit on unmount); a discarded row must not
  // be resurrected by that late commit.
  const pendingRef = useRef<CommandPreset | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  // Set when a row is removed; the Add button may still be disabled in this
  // render (a pending row existed), so focus it after the update lands.
  const focusAddRef = useRef(false)
  useEffect(() => {
    if (!focusAddRef.current) return
    focusAddRef.current = false
    const add = addRef.current
    if (add && !add.disabled) {
      add.focus()
      return
    }
    // Add stays disabled while a pending row exists; land on that row.
    const pendingId = pendingRef.current?.id
    if (pendingId && typeof document !== 'undefined') {
      document.getElementById(`settings-preset-${pendingId}-label`)?.focus()
    }
  })

  const updatePending = (next: CommandPreset | null) => {
    pendingRef.current = next
    setPending(next)
  }

  const canAdd = !pending && presets.length < MAX_PRESETS
  const rows = pending ? [...presets, pending] : presets

  const commitStoredField = (id: string, field: PresetField, value: string) => {
    const error = validatePresetField(field, value)
    if (error) return error
    const { commandPresets, setCommandPresets } = useSettingsStore.getState()
    setCommandPresets(patchPreset(commandPresets, id, { [field]: value }))
    return null
  }

  const commitPendingField = (field: PresetField, value: string) => {
    const current = pendingRef.current
    if (!current) return null
    const next = { ...current, [field]: value }
    const { commandPresets, setCommandPresets } = useSettingsStore.getState()
    if (isCompletePreset(next) && commandPresets.length < MAX_PRESETS) {
      setCommandPresets([...commandPresets, normalizePreset(next)])
      updatePending(null)
    } else {
      updatePending(next)
    }
    return null
  }

  const changeIcon = (id: string, agentType: AgentType | undefined) => {
    if (pending?.id === id) {
      updatePending({ ...pending, agentType })
      return
    }
    const { commandPresets, setCommandPresets } = useSettingsStore.getState()
    setCommandPresets(patchPreset(commandPresets, id, { agentType }))
  }

  const handleAdd = () => {
    if (!canAdd) return
    const existing = new Set(presets.map((preset) => preset.id))
    updatePending({ id: generatePresetId(existing), label: '', command: '', isBuiltIn: false })
  }

  // The removed row's inputs held focus; hand it to the Add button rather
  // than letting it fall to <body>.
  const removeRow = (id: string) => {
    focusAddRef.current = true
    if (pendingRef.current?.id === id) updatePending(null)
    else useSettingsStore.getState().removePreset(id)
  }

  return (
    <div className="w-full min-w-0">
      <div aria-hidden="true" className={cn(PRESET_GRID, 'border-b border-border pb-1 text-[11px] uppercase tracking-wide text-muted max-md:hidden')}>
        <span className="text-center">Default</span>
        <span>Icon</span>
        <span>Name</span>
        <span>Command</span>
        <span className="w-[32px]" />
      </div>
      <div role="list" aria-labelledby={ids.label} aria-describedby={ids.description} className="divide-y divide-border-subtle">
        {rows.map((preset, index) => {
          const isPending = preset.id === pending?.id
          return (
            <PresetRow
              key={preset.id}
              preset={preset}
              index={index}
              isDefault={preset.id === defaultPresetId}
              pending={isPending}
              autoFocusName={isPending}
              onSetDefault={() => useSettingsStore.getState().setDefaultPresetId(preset.id)}
              onCommitField={(field, value) =>
                isPending ? commitPendingField(field, value) : commitStoredField(preset.id, field, value)
              }
              onIconChange={(agentType) => changeIcon(preset.id, agentType)}
              onDelete={() => removeRow(preset.id)}
            />
          )
        })}
      </div>
      {pending && (
        <p className={cn(HELP_TEXT, 'pb-2')} role="status">
          Enter a name and a command to add the preset.
        </p>
      )}
      <div className="mt-2 flex items-center gap-3">
        <button ref={addRef} type="button" className={CONTROL_BUTTON} onClick={handleAdd} disabled={!canAdd}>
          <PlusIcon width={ICON_SIZE.default} height={ICON_SIZE.default} className="mr-1.5" />
          Add preset
        </button>
        {presets.length >= MAX_PRESETS && (
          <span className={HELP_TEXT}>Maximum of {MAX_PRESETS} presets.</span>
        )}
      </div>
    </div>
  )
}
