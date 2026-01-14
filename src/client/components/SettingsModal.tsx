import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_PROJECT_DIR,
  MAX_PRESETS,
  useSettingsStore,
  type CommandPreset,
  type SessionSortDirection,
  type SessionSortMode,
  type ShortcutModifier,
} from '../stores/settingsStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import { Switch } from './Switch'

interface SettingsChangeFlags {
  webglChanged: boolean
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: (flags?: SettingsChangeFlags) => void
}

export default function SettingsModal({
  isOpen,
  onClose,
}: SettingsModalProps) {
  const defaultProjectDir = useSettingsStore((state) => state.defaultProjectDir)
  const setDefaultProjectDir = useSettingsStore(
    (state) => state.setDefaultProjectDir
  )
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const setCommandPresets = useSettingsStore((state) => state.setCommandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const setDefaultPresetId = useSettingsStore((state) => state.setDefaultPresetId)
  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const setSessionSortMode = useSettingsStore(
    (state) => state.setSessionSortMode
  )
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const setSessionSortDirection = useSettingsStore(
    (state) => state.setSessionSortDirection
  )
  const useWebGL = useSettingsStore((state) => state.useWebGL)
  const setUseWebGL = useSettingsStore((state) => state.setUseWebGL)
  const lineHeight = useSettingsStore((state) => state.lineHeight)
  const setLineHeight = useSettingsStore((state) => state.setLineHeight)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const setShortcutModifier = useSettingsStore(
    (state) => state.setShortcutModifier
  )
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )
  const setShowSessionIdPrefix = useSettingsStore(
    (state) => state.setShowSessionIdPrefix
  )

  const [draftDir, setDraftDir] = useState(defaultProjectDir)
  const [draftPresets, setDraftPresets] = useState<CommandPreset[]>(commandPresets)
  const [draftDefaultPresetId, setDraftDefaultPresetId] = useState(defaultPresetId)
  const [draftSortMode, setDraftSortMode] =
    useState<SessionSortMode>(sessionSortMode)
  const [draftSortDirection, setDraftSortDirection] =
    useState<SessionSortDirection>(sessionSortDirection)
  const [draftUseWebGL, setDraftUseWebGL] = useState(useWebGL)
  const [draftLineHeight, setDraftLineHeight] = useState(lineHeight)
  const [draftShortcutModifier, setDraftShortcutModifier] = useState<
    ShortcutModifier | 'auto'
  >(shortcutModifier)
  const [draftShowSessionIdPrefix, setDraftShowSessionIdSuffix] = useState(
    showSessionIdPrefix
  )

  // New preset form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newBaseCommand, setNewBaseCommand] = useState('')
  const [newModifiers, setNewModifiers] = useState('')
  const [newAgentType, setNewAgentType] = useState<'claude' | 'codex' | ''>('')
  const reenableTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (reenableTimeoutRef.current) {
      clearTimeout(reenableTimeoutRef.current)
      reenableTimeoutRef.current = null
    }

    if (isOpen) {
      setDraftDir(defaultProjectDir)
      setDraftPresets(commandPresets)
      setDraftDefaultPresetId(defaultPresetId)
      setDraftSortMode(sessionSortMode)
      setDraftSortDirection(sessionSortDirection)
      setDraftUseWebGL(useWebGL)
      setDraftLineHeight(lineHeight)
      setDraftShortcutModifier(shortcutModifier)
      setDraftShowSessionIdSuffix(showSessionIdPrefix)
      setShowAddForm(false)
      setNewLabel('')
      setNewBaseCommand('')
      setNewModifiers('')
      setNewAgentType('')
      // Disable terminal textarea when modal opens to prevent keyboard capture
      if (typeof document !== 'undefined') {
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea && typeof textarea.setAttribute === 'function') {
          if (typeof textarea.blur === 'function') textarea.blur()
          textarea.setAttribute('disabled', 'true')
        }
      }
    } else {
      // Re-enable terminal textarea when modal closes
      if (typeof document !== 'undefined') {
        reenableTimeoutRef.current = setTimeout(() => {
          if (typeof document === 'undefined') {
            return
          }
          const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          if (textarea) {
            textarea.removeAttribute('disabled')
            textarea.focus()
          }
        }, 300)
      }
    }
    return () => {
      if (reenableTimeoutRef.current) {
        clearTimeout(reenableTimeoutRef.current)
        reenableTimeoutRef.current = null
      }
    }
  }, [
    commandPresets,
    defaultPresetId,
    defaultProjectDir,
    sessionSortMode,
    sessionSortDirection,
    useWebGL,
    lineHeight,
    shortcutModifier,
    showSessionIdPrefix,
    isOpen,
  ])

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedDir = draftDir.trim()
    const webglChanged = draftUseWebGL !== useWebGL
    setDefaultProjectDir(trimmedDir || DEFAULT_PROJECT_DIR)
    setCommandPresets(draftPresets)
    setDefaultPresetId(draftDefaultPresetId)
    setSessionSortMode(draftSortMode)
    setSessionSortDirection(draftSortDirection)
    setUseWebGL(draftUseWebGL)
    setLineHeight(draftLineHeight)
    setShortcutModifier(draftShortcutModifier)
    setShowSessionIdPrefix(draftShowSessionIdPrefix)
    onClose({ webglChanged })
  }

  const handleUpdatePreset = (presetId: string, updates: Partial<CommandPreset>) => {
    setDraftPresets(presets =>
      presets.map(p => p.id === presetId ? { ...p, ...updates } : p)
    )
  }

  const handleDeletePreset = (presetId: string) => {
    const preset = draftPresets.find(p => p.id === presetId)
    if (!preset || preset.isBuiltIn) return

    const filtered = draftPresets.filter(p => p.id !== presetId)
    setDraftPresets(filtered)

    // Update default if deleted preset was default
    if (presetId === draftDefaultPresetId) {
      setDraftDefaultPresetId(filtered[0]?.id || 'claude')
    }
  }

  const handleAddPreset = () => {
    if (!newLabel.trim() || !newBaseCommand.trim()) return
    if (draftPresets.length >= MAX_PRESETS) return

    const newPreset: CommandPreset = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: newLabel.trim(),
      baseCommand: newBaseCommand.trim(),
      modifiers: newModifiers.trim(),
      isBuiltIn: false,
      agentType: newAgentType || undefined,
    }

    setDraftPresets([...draftPresets, newPreset])
    setShowAddForm(false)
    setNewLabel('')
    setNewBaseCommand('')
    setNewModifiers('')
    setNewAgentType('')
  }

  const canAddPreset = draftPresets.length < MAX_PRESETS

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto border border-border bg-elevated p-6"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
          Settings
        </h2>
        <p className="mt-2 text-xs text-muted text-pretty">
          Configure default directory, command presets, and display options.
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Default Project Directory
            </label>
            <input
              value={draftDir}
              onChange={(event) => setDraftDir(event.target.value)}
              placeholder={DEFAULT_PROJECT_DIR}
              className="input"
              autoFocus
            />
          </div>

          {/* Command Presets Section */}
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-secondary">
                Command Presets
              </label>
              <select
                value={draftDefaultPresetId}
                onChange={(e) => setDraftDefaultPresetId(e.target.value)}
                className="input text-xs py-1 px-2 w-auto"
              >
                {draftPresets.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <p className="text-[10px] text-muted mb-3">
              Default preset is pre-selected when creating new sessions.
            </p>

            <div className="space-y-3">
              {draftPresets.map(preset => (
                <div
                  key={preset.id}
                  className="border border-border p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {preset.isBuiltIn && (
                        <span className="text-[10px] text-muted">🔒</span>
                      )}
                      <input
                        value={preset.label}
                        onChange={(e) => handleUpdatePreset(preset.id, { label: e.target.value })}
                        className="input text-sm py-1 px-2 w-32"
                        placeholder="Label"
                      />
                    </div>
                    {!preset.isBuiltIn && (
                      <button
                        type="button"
                        onClick={() => handleDeletePreset(preset.id)}
                        className="btn text-xs px-2 py-1 text-error hover:bg-error/10"
                      >
                        Delete
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-muted block mb-1">Base Command</label>
                      <input
                        value={preset.baseCommand}
                        onChange={(e) => handleUpdatePreset(preset.id, { baseCommand: e.target.value })}
                        className="input text-xs py-1 px-2 font-mono"
                        placeholder="command"
                        disabled={preset.isBuiltIn}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted block mb-1">Modifiers</label>
                      <input
                        value={preset.modifiers}
                        onChange={(e) => handleUpdatePreset(preset.id, { modifiers: e.target.value })}
                        className="input text-xs py-1 px-2 font-mono"
                        placeholder="--flag value"
                      />
                    </div>
                  </div>

                  {!preset.isBuiltIn && (
                    <div>
                      <label className="text-[10px] text-muted block mb-1">Icon</label>
                      <select
                        value={preset.agentType || ''}
                        onChange={(e) => handleUpdatePreset(preset.id, {
                          agentType: e.target.value as 'claude' | 'codex' | undefined || undefined
                        })}
                        className="input text-xs py-1 px-2 w-auto"
                      >
                        <option value="">Terminal</option>
                        <option value="claude">Claude</option>
                        <option value="codex">Codex</option>
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Add Preset Form */}
            {showAddForm ? (
              <div className="mt-3 border border-border p-3 space-y-2">
                <div className="text-xs text-secondary mb-2">New Preset</div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    className="input text-xs py-1 px-2"
                    placeholder="Label"
                  />
                  <input
                    value={newBaseCommand}
                    onChange={(e) => setNewBaseCommand(e.target.value)}
                    className="input text-xs py-1 px-2 font-mono"
                    placeholder="command"
                  />
                </div>
                <input
                  value={newModifiers}
                  onChange={(e) => setNewModifiers(e.target.value)}
                  className="input text-xs py-1 px-2 font-mono w-full"
                  placeholder="Modifiers (optional)"
                />
                <div className="flex items-center gap-2">
                  <select
                    value={newAgentType}
                    onChange={(e) => setNewAgentType(e.target.value as 'claude' | 'codex' | '')}
                    className="input text-xs py-1 px-2 w-auto"
                  >
                    <option value="">Terminal Icon</option>
                    <option value="claude">Claude Icon</option>
                    <option value="codex">Codex Icon</option>
                  </select>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="btn text-xs px-2 py-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAddPreset}
                    disabled={!newLabel.trim() || !newBaseCommand.trim()}
                    className="btn btn-primary text-xs px-2 py-1"
                  >
                    Add
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                disabled={!canAddPreset}
                className="btn text-xs mt-3 w-full"
              >
                {canAddPreset ? '+ Add Preset' : `Max ${MAX_PRESETS} presets`}
              </button>
            )}
          </div>

          <div className="border-t border-border pt-4">
            <label className="mb-2 block text-xs text-secondary">
              Session List Order
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className={`btn flex-1 ${draftSortMode === 'created' ? 'btn-primary' : ''}`}
                onClick={() => setDraftSortMode('created')}
              >
                Creation Date
              </button>
              <button
                type="button"
                className={`btn flex-1 ${draftSortMode === 'status' ? 'btn-primary' : ''}`}
                onClick={() => setDraftSortMode('status')}
              >
                Status
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-muted">
              {draftSortMode === 'status'
                ? 'Sessions auto-resort by status (waiting, working, unknown)'
                : 'Sessions stay in creation order'}
            </p>
          </div>

          {draftSortMode === 'created' && (
            <div>
              <label className="mb-2 block text-xs text-secondary">
                Sort Direction
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`btn flex-1 ${draftSortDirection === 'desc' ? 'btn-primary' : ''}`}
                  onClick={() => setDraftSortDirection('desc')}
                >
                  Newest First
                </button>
                <button
                  type="button"
                  className={`btn flex-1 ${draftSortDirection === 'asc' ? 'btn-primary' : ''}`}
                  onClick={() => setDraftSortDirection('asc')}
                >
                  Oldest First
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-primary">Session ID Prefix</div>
              <div className="text-[10px] text-muted">
                Show first 5 characters of agent session IDs in the list.
              </div>
            </div>
            <Switch
              checked={draftShowSessionIdPrefix}
              onCheckedChange={setDraftShowSessionIdSuffix}
            />
          </div>

          <div className="border-t border-border pt-4">
            <label className="mb-2 block text-xs text-secondary">
              Terminal Rendering
            </label>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">WebGL Acceleration</div>
                <div className="text-[10px] text-muted">
                  GPU rendering for better performance. Disable if you see flickering.
                </div>
              </div>
              <Switch
                checked={draftUseWebGL}
                onCheckedChange={setDraftUseWebGL}
              />
            </div>
            {draftUseWebGL !== useWebGL && (
              <p className="mt-2 text-[10px] text-approval">
                Terminal will reload when saved
              </p>
            )}

            <div className="mt-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Line Height</div>
                <div className="text-[10px] text-muted">
                  Vertical spacing between lines (1.0 = compact, 2.0 = spacious)
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="1.0"
                  max="2.0"
                  step="0.1"
                  value={draftLineHeight}
                  onChange={(e) => setDraftLineHeight(parseFloat(e.target.value))}
                  className="w-20 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
                />
                <span className="text-xs text-secondary w-8 text-right">{draftLineHeight.toFixed(1)}</span>
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <label className="mb-2 block text-xs text-secondary">
              Keyboard Shortcut Modifier
            </label>
            <div className="grid grid-cols-5 gap-1">
              {(
                ['auto', 'ctrl-option', 'ctrl-shift', 'cmd-option', 'cmd-shift'] as const
              ).map((mod) => (
                <button
                  key={mod}
                  type="button"
                  className={`btn text-xs px-2 ${draftShortcutModifier === mod ? 'btn-primary' : ''}`}
                  onClick={() => setDraftShortcutModifier(mod)}
                >
                  {mod === 'auto'
                    ? 'Auto'
                    : getModifierDisplay(mod)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-muted">
              {draftShortcutModifier === 'auto'
                ? `Platform default: ${getModifierDisplay(getEffectiveModifier('auto'))}`
                : `Shortcuts: ${getModifierDisplay(draftShortcutModifier)}+[N/X/[/]]`}
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => onClose()} className="btn">
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
