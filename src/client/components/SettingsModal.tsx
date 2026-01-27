import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_PROJECT_DIR,
  MAX_PRESETS,
  FONT_OPTIONS,
  useSettingsStore,
  type CommandPreset,
  type FontOption,
  type SessionSortDirection,
  type SessionSortMode,
  type ShortcutModifier,
} from '../stores/settingsStore'
import { useThemeStore, type Theme } from '../stores/themeStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import { Switch } from './Switch'
import { playPermissionSound, playIdleSound, primeAudio } from '../utils/sound'

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
  const fontSize = useSettingsStore((state) => state.fontSize)
  const setFontSize = useSettingsStore((state) => state.setFontSize)
  const lineHeight = useSettingsStore((state) => state.lineHeight)
  const setLineHeight = useSettingsStore((state) => state.setLineHeight)
  const letterSpacing = useSettingsStore((state) => state.letterSpacing)
  const setLetterSpacing = useSettingsStore((state) => state.setLetterSpacing)
  const fontOption = useSettingsStore((state) => state.fontOption)
  const setFontOption = useSettingsStore((state) => state.setFontOption)
  const customFontFamily = useSettingsStore((state) => state.customFontFamily)
  const setCustomFontFamily = useSettingsStore((state) => state.setCustomFontFamily)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const setShortcutModifier = useSettingsStore(
    (state) => state.setShortcutModifier
  )
  const showProjectName = useSettingsStore((state) => state.showProjectName)
  const setShowProjectName = useSettingsStore(
    (state) => state.setShowProjectName
  )
  const showLastUserMessage = useSettingsStore(
    (state) => state.showLastUserMessage
  )
  const setShowLastUserMessage = useSettingsStore(
    (state) => state.setShowLastUserMessage
  )
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )
  const setShowSessionIdPrefix = useSettingsStore(
    (state) => state.setShowSessionIdPrefix
  )
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const soundOnPermission = useSettingsStore((state) => state.soundOnPermission)
  const setSoundOnPermission = useSettingsStore((state) => state.setSoundOnPermission)
  const soundOnIdle = useSettingsStore((state) => state.soundOnIdle)
  const setSoundOnIdle = useSettingsStore((state) => state.setSoundOnIdle)

  const [draftDir, setDraftDir] = useState(defaultProjectDir)
  const [draftPresets, setDraftPresets] = useState<CommandPreset[]>(commandPresets)
  const [draftDefaultPresetId, setDraftDefaultPresetId] = useState(defaultPresetId)
  const [draftSortMode, setDraftSortMode] =
    useState<SessionSortMode>(sessionSortMode)
  const [draftSortDirection, setDraftSortDirection] =
    useState<SessionSortDirection>(sessionSortDirection)
  const [draftUseWebGL, setDraftUseWebGL] = useState(useWebGL)
  const [draftFontSize, setDraftFontSize] = useState(fontSize)
  const [draftLineHeight, setDraftLineHeight] = useState(lineHeight)
  const [draftLetterSpacing, setDraftLetterSpacing] = useState(letterSpacing)
  const [draftFontOption, setDraftFontOption] = useState<FontOption>(fontOption)
  const [draftCustomFontFamily, setDraftCustomFontFamily] = useState(customFontFamily)
  const [draftShortcutModifier, setDraftShortcutModifier] = useState<
    ShortcutModifier | 'auto'
  >(shortcutModifier)
  const [draftShowProjectName, setDraftShowProjectName] =
    useState(showProjectName)
  const [draftShowLastUserMessage, setDraftShowLastUserMessage] = useState(
    showLastUserMessage
  )
  const [draftShowSessionIdPrefix, setDraftShowSessionIdSuffix] = useState(
    showSessionIdPrefix
  )
  const [draftTheme, setDraftTheme] = useState<Theme>(theme)
  const [draftSoundOnPermission, setDraftSoundOnPermission] = useState(soundOnPermission)
  const [draftSoundOnIdle, setDraftSoundOnIdle] = useState(soundOnIdle)

  // Server-side settings (fetched from API)
  const [tmuxMouseMode, setTmuxMouseMode] = useState(true)
  const [tmuxMouseModeLoading, setTmuxMouseModeLoading] = useState(false)
  const [inactiveMaxAgeHours, setInactiveMaxAgeHours] = useState(24)
  const [inactiveMaxAgeHoursLoading, setInactiveMaxAgeHoursLoading] = useState(false)

  // New preset form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newCommand, setNewCommand] = useState('')
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
      setDraftFontSize(fontSize)
      setDraftLineHeight(lineHeight)
      setDraftLetterSpacing(letterSpacing)
      setDraftFontOption(fontOption)
      setDraftCustomFontFamily(customFontFamily)
      setDraftShortcutModifier(shortcutModifier)
      setDraftShowProjectName(showProjectName)
      setDraftShowLastUserMessage(showLastUserMessage)
      setDraftShowSessionIdSuffix(showSessionIdPrefix)
      setDraftTheme(theme)
      setDraftSoundOnPermission(soundOnPermission)
      setDraftSoundOnIdle(soundOnIdle)
      setShowAddForm(false)
      setNewLabel('')
      setNewCommand('')
      setNewAgentType('')
      // Fetch server-side settings
      fetch('/api/settings/tmux-mouse-mode')
        .then((res) => res.json())
        .then((data: { enabled: boolean }) => setTmuxMouseMode(data.enabled))
        .catch(() => {})
      fetch('/api/settings/inactive-max-age-hours')
        .then((res) => res.json())
        .then((data: { hours: number }) => setInactiveMaxAgeHours(data.hours))
        .catch(() => {})
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
    fontSize,
    lineHeight,
    letterSpacing,
    fontOption,
    customFontFamily,
    shortcutModifier,
    showProjectName,
    showLastUserMessage,
    showSessionIdPrefix,
    theme,
    soundOnPermission,
    soundOnIdle,
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
    setFontSize(draftFontSize)
    setLineHeight(draftLineHeight)
    setLetterSpacing(draftLetterSpacing)
    setFontOption(draftFontOption)
    setCustomFontFamily(draftCustomFontFamily)
    setShortcutModifier(draftShortcutModifier)
    setShowProjectName(draftShowProjectName)
    setShowLastUserMessage(draftShowLastUserMessage)
    setShowSessionIdPrefix(draftShowSessionIdPrefix)
    setTheme(draftTheme)
    setSoundOnPermission(draftSoundOnPermission)
    setSoundOnIdle(draftSoundOnIdle)
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
    if (!newLabel.trim() || !newCommand.trim()) return
    if (draftPresets.length >= MAX_PRESETS) return

    const newPreset: CommandPreset = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: newLabel.trim(),
      command: newCommand.trim(),
      isBuiltIn: false,
      agentType: newAgentType || undefined,
    }

    setDraftPresets([...draftPresets, newPreset])
    setShowAddForm(false)
    setNewLabel('')
    setNewCommand('')
    setNewAgentType('')
  }

  const canAddPreset = draftPresets.length < MAX_PRESETS

  const handleTmuxMouseModeChange = (enabled: boolean) => {
    setTmuxMouseModeLoading(true)
    setTmuxMouseMode(enabled)
    fetch('/api/settings/tmux-mouse-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
      .catch(() => setTmuxMouseMode(!enabled)) // Revert on error
      .finally(() => setTmuxMouseModeLoading(false))
  }

  const handleInactiveMaxAgeHoursChange = (hours: number) => {
    const prevHours = inactiveMaxAgeHours
    setInactiveMaxAgeHoursLoading(true)
    setInactiveMaxAgeHours(hours)
    fetch('/api/settings/inactive-max-age-hours', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours }),
    })
      .catch(() => setInactiveMaxAgeHours(prevHours)) // Revert on error
      .finally(() => setInactiveMaxAgeHoursLoading(false))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg max-h-[90vh] flex flex-col border border-border bg-elevated"
      >
        <div className="p-6 pb-0">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
            Settings
          </h2>
          <p className="mt-2 text-xs text-muted text-pretty">
            Configure default directory, command presets, and display options.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4">

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

                  <div>
                    <label className="text-[10px] text-muted block mb-1">Command</label>
                    <input
                      value={preset.command}
                      onChange={(e) => handleUpdatePreset(preset.id, { command: e.target.value })}
                      className="input text-xs py-1 px-2 font-mono w-full"
                      placeholder="command --flags"
                    />
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
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  className="input text-xs py-1 px-2 w-full"
                  placeholder="Label"
                />
                <input
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  className="input text-xs py-1 px-2 font-mono w-full"
                  placeholder="command --flags"
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
                    disabled={!newLabel.trim() || !newCommand.trim()}
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
                Created
              </button>
              <button
                type="button"
                className={`btn flex-1 ${draftSortMode === 'status' ? 'btn-primary' : ''}`}
                onClick={() => setDraftSortMode('status')}
              >
                Status
              </button>
              <button
                type="button"
                className={`btn flex-1 ${draftSortMode === 'manual' ? 'btn-primary' : ''}`}
                onClick={() => setDraftSortMode('manual')}
              >
                Manual
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-muted">
              {draftSortMode === 'status'
                ? 'Sessions auto-resort by status (waiting, working, unknown)'
                : draftSortMode === 'manual'
                  ? 'Drag sessions to reorder manually'
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

          <div className="border-t border-border pt-4 space-y-3">
            <label className="mb-1 block text-xs text-secondary">
              Session List Details
            </label>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Project Name</div>
                <div className="text-[10px] text-muted">
                  Show the project folder name under each session.
                </div>
              </div>
              <Switch
                checked={draftShowProjectName}
                onCheckedChange={setDraftShowProjectName}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Last User Message</div>
                <div className="text-[10px] text-muted">
                  Show the most recent user input next to the project name.
                </div>
              </div>
              <Switch
                checked={draftShowLastUserMessage}
                onCheckedChange={setDraftShowLastUserMessage}
              />
            </div>
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
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Inactive Sessions Lookback</div>
                <div className="text-[10px] text-muted">
                  Show inactive sessions from the last N hours (1-168).
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={inactiveMaxAgeHours}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (val >= 1 && val <= 168) {
                      handleInactiveMaxAgeHoursChange(val)
                    }
                  }}
                  disabled={inactiveMaxAgeHoursLoading}
                  className="input text-xs py-1 px-2 w-16 text-center"
                />
                <span className="text-xs text-muted">hrs</span>
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4 space-y-3">
            <label className="mb-1 block text-xs text-secondary">
              Notifications
            </label>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm text-primary">Permission Sound</div>
                <div className="text-[10px] text-muted">
                  Play a ping when any session needs permission.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void playPermissionSound()}
                  className="btn text-xs px-2 py-1"
                >
                  Test
                </button>
                <Switch
                  checked={draftSoundOnPermission}
                  onCheckedChange={(checked) => {
                    setDraftSoundOnPermission(checked)
                    if (checked) void primeAudio() // Unlock audio on user gesture
                  }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm text-primary">Idle Sound</div>
                <div className="text-[10px] text-muted">
                  Play a chime when a session finishes working.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void playIdleSound()}
                  className="btn text-xs px-2 py-1"
                >
                  Test
                </button>
                <Switch
                  checked={draftSoundOnIdle}
                  onCheckedChange={(checked) => {
                    setDraftSoundOnIdle(checked)
                    if (checked) void primeAudio() // Unlock audio on user gesture
                  }}
                />
              </div>
            </div>
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
                <div className="text-sm text-primary">Mouse Mode</div>
                <div className="text-[10px] text-muted">
                  Enable tmux mouse mode for trackpad/scroll wheel support.
                </div>
              </div>
              <Switch
                checked={tmuxMouseMode}
                onCheckedChange={handleTmuxMouseModeChange}
                disabled={tmuxMouseModeLoading}
              />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Font Size</div>
                <div className="text-[10px] text-muted">
                  Terminal text size in pixels (6-24)
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDraftFontSize(Math.max(6, draftFontSize - 1))}
                  className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover"
                >
                  <span className="text-sm font-bold">−</span>
                </button>
                <span className="text-sm text-secondary w-6 text-center">{draftFontSize}</span>
                <button
                  type="button"
                  onClick={() => setDraftFontSize(Math.min(24, draftFontSize + 1))}
                  className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover"
                >
                  <span className="text-sm font-bold">+</span>
                </button>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Line Height</div>
                <div className="text-[10px] text-muted">
                  Vertical spacing (1.0 = compact, 2.0 = spacious)
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

            <div className="mt-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Letter Spacing</div>
                <div className="text-[10px] text-muted">
                  Horizontal spacing between characters in pixels
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="-3"
                  max="3"
                  step="1"
                  value={draftLetterSpacing}
                  onChange={(e) => setDraftLetterSpacing(parseInt(e.target.value, 10))}
                  className="w-20 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
                />
                <span className="text-xs text-secondary w-8 text-right">{draftLetterSpacing}px</span>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-primary">Font Family</div>
                  <div className="text-[10px] text-muted">
                    Terminal typeface
                  </div>
                </div>
                <select
                  value={draftFontOption}
                  onChange={(e) => setDraftFontOption(e.target.value as FontOption)}
                  className="input text-xs py-1 px-2 w-auto"
                >
                  {FONT_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              {draftFontOption === 'custom' && (
                <input
                  value={draftCustomFontFamily}
                  onChange={(e) => setDraftCustomFontFamily(e.target.value)}
                  placeholder='"Fira Code", monospace'
                  className="input text-xs mt-2 font-mono"
                />
              )}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Dark Mode</div>
                <div className="text-[10px] text-muted">
                  Switch between dark and light themes.
                </div>
              </div>
              <Switch
                checked={draftTheme === 'dark'}
                onCheckedChange={(checked) => setDraftTheme(checked ? 'dark' : 'light')}
              />
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

        </div>

        <div className="flex justify-end gap-2 p-6 pt-4 border-t border-border bg-elevated">
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
