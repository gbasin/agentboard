/**
 * PresetRow - one always-editable command preset: default radio, icon,
 * name, command, delete. Name and command commit on blur/Enter through
 * `onCommitField`, which returns an error to keep an invalid draft local.
 * Deleting a custom preset takes a second, confirming click.
 */
import { useEffect, useRef, useState } from 'react'
import type { AgentType } from '@shared/types'
import type { CommandPreset } from '../../stores/settingsStore'
import { cn } from '../../utils/cn'
import AgentIcon from '../AgentIcon'
import { ICON_SIZE } from '../controlStyles'
import { DeleteIcon } from '../icons'
import { CommitInput } from './controls/CommitInput'
import {
  PRESET_COMMAND_MAX,
  PRESET_ICON_OPTIONS,
  PRESET_LABEL_MAX,
  type PresetField,
} from './presetEdits'
import { CONTROL_BUTTON, CONTROL_HEIGHT, CONTROL_INPUT } from './styles'

/** Desktop: one line of five columns. Phone: radio/icon/delete, then name, then command. */
export const PRESET_GRID =
  'grid items-start gap-2 grid-cols-[56px_92px_minmax(0,0.8fr)_minmax(0,1.3fr)_auto] max-md:grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto] max-md:gap-y-2'

const CONFIRM_RESET_MS = 4000

interface PresetRowProps {
  preset: CommandPreset
  index: number
  isDefault: boolean
  /** Not yet in the store: name and command are still being entered. */
  pending?: boolean
  autoFocusName?: boolean
  onSetDefault: () => void
  onCommitField: (field: PresetField, value: string) => string | null
  onIconChange: (agentType: AgentType | undefined) => void
  onDelete: () => void
}

export function PresetRow({
  preset,
  index,
  isDefault,
  pending = false,
  autoFocusName = false,
  onSetDefault,
  onCommitField,
  onIconChange,
  onDelete,
}: PresetRowProps) {
  const [confirming, setConfirming] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const base = `settings-preset-${preset.id}`
  const name = preset.label.trim() || `preset ${index + 1}`

  useEffect(() => {
    if (autoFocusName) nameRef.current?.focus()
  }, [autoFocusName])

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_RESET_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  const handleDelete = () => {
    if (pending || confirming) {
      onDelete()
      return
    }
    setConfirming(true)
  }

  return (
    <div role="listitem" data-preset-id={preset.id} className={cn(PRESET_GRID, 'py-2')}>
      <label className={cn(CONTROL_HEIGHT, 'flex cursor-pointer items-center gap-2 md:justify-center')}>
        <input
          type="radio"
          name="settings-default-preset"
          checked={isDefault}
          disabled={pending}
          onChange={onSetDefault}
          aria-label={`Default preset: ${name}`}
          className="size-4 cursor-pointer accent-accent disabled:cursor-not-allowed"
        />
        <span aria-hidden="true" className="text-[12px] text-secondary md:hidden">Default</span>
      </label>

      {preset.isBuiltIn ? (
        <div className={cn(CONTROL_HEIGHT, 'flex items-center gap-2 text-muted')}>
          <AgentIcon agentType={preset.agentType} command={preset.command} className="size-4" />
          <span className="text-[11px]">Built-in</span>
        </div>
      ) : (
        <select
          id={`${base}-icon`}
          value={preset.agentType ?? ''}
          aria-label={`Icon for ${name}`}
          onChange={(event) => onIconChange((event.target.value || undefined) as AgentType | undefined)}
          className={cn(CONTROL_INPUT, 'w-full px-1')}
        >
          {PRESET_ICON_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}

      <CommitInput
        ref={nameRef}
        id={`${base}-label`}
        value={preset.label}
        placeholder="Name"
        aria-label={`Name of preset ${index + 1}`}
        maxLength={PRESET_LABEL_MAX}
        onCommit={(draft) => onCommitField('label', draft)}
        wrapperClassName="max-md:order-4 max-md:col-span-3"
      />
      <CommitInput
        id={`${base}-command`}
        value={preset.command}
        placeholder="command --flags"
        aria-label={`Command for ${name}`}
        maxLength={PRESET_COMMAND_MAX}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onCommit={(draft) => onCommitField('command', draft)}
        className="font-mono"
        wrapperClassName="max-md:order-5 max-md:col-span-3"
      />

      {preset.isBuiltIn ? (
        <span aria-hidden="true" className="w-[32px] max-md:order-3 max-md:w-[44px]" />
      ) : (
        <button
          type="button"
          onClick={handleDelete}
          onBlur={() => setConfirming(false)}
          aria-label={confirming ? `Confirm delete ${name}` : pending ? `Discard new preset` : `Delete ${name}`}
          title={confirming ? 'Click again to delete' : undefined}
          className={cn(
            CONTROL_BUTTON,
            'max-md:order-3 px-0',
            confirming
              ? 'border-danger bg-danger/10 px-2 text-danger hover:bg-danger/20 hover:text-danger'
              : 'w-[32px] max-md:w-[44px] hover:text-danger'
          )}
        >
          {confirming ? 'Delete?' : <DeleteIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />}
        </button>
      )}
    </div>
  )
}
