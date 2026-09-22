import { useEffect, useRef, useState } from 'react'
import { type CommandPreset, getFullCommand, useSettingsStore } from '../stores/settingsStore'
import { DirectoryBrowser } from './DirectoryBrowser'
import AgentIcon from './AgentIcon'
import type { HostStatus } from '@shared/types'
import { inferAgentType } from '@shared/agentDetection'
import {
  addYoloFlag,
  commandHasYoloFlag,
  removeYoloFlag,
  yoloConflict,
  yoloFlagFor,
} from '@shared/yolo'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (projectPath: string, name?: string, command?: string, host?: string) => void
  defaultProjectDir: string
  commandPresets: CommandPreset[]
  defaultPresetId: string
  lastProjectPath?: string | null
  activeProjectPath?: string
  remoteHosts?: HostStatus[]
  remoteAllowControl?: boolean
  /** Pre-fill host for duplicate of remote session */
  initialHost?: string
  /** Pre-fill path (e.g. when duplicating an existing session) */
  initialPath?: string
  /** Pre-fill command (e.g. when duplicating an existing session) */
  initialCommand?: string
}

export default function NewSessionModal({
  isOpen,
  onClose,
  onCreate,
  defaultProjectDir,
  commandPresets,
  defaultPresetId,
  lastProjectPath,
  activeProjectPath,
  remoteHosts = [],
  remoteAllowControl = false,
  initialHost,
  initialPath,
  initialCommand,
}: NewSessionModalProps) {
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const [showBrowser, setShowBrowser] = useState(false)
  const [selectedHost, setSelectedHost] = useState('')
  const yoloMode = useSettingsStore((s) => s.yoloMode)
  const setYoloMode = useSettingsStore((s) => s.setYoloMode)
  const formRef = useRef<HTMLFormElement>(null)
  const projectPathRef = useRef<HTMLInputElement>(null)
  const defaultButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)

  const showHostPicker = remoteAllowControl && remoteHosts.length > 0

  // Apply the remembered yolo preference to a command that doesn't already carry a flag.
  const applyYoloPref = (cmd: string): string => {
    if (!yoloMode) return cmd
    const type = inferAgentType(cmd)
    return type && !yoloConflict(cmd, type) ? addYoloFlag(cmd, type) : cmd
  }

  const handlePresetSelect = (presetId: string) => {
    const preset = commandPresets.find(p => p.id === presetId)
    if (preset) {
      setSelectedPresetId(presetId)
      setCommand(applyYoloPref(getFullCommand(preset)))
    }
  }

  const handleCustomSelect = () => {
    setSelectedPresetId(null)
    setCommand('')
  }

  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = isOpen
    if (!isOpen) {
      setProjectPath('')
      setName('')
      setSelectedPresetId(null)
      setCommand('')
      setShowBrowser(false)
      setSelectedHost(initialHost ?? '')
      // Focus terminal after modal closes — only on an actual open→closed
      // transition, not on mount or dep changes while it stays closed.
      if (wasOpen) {
        setTimeout(() => {
          if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
          const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          if (textarea) {
            textarea.removeAttribute('disabled')
            textarea.focus()
          }
        }, 300)
      }
      return
    }
    // Disable terminal textarea when modal opens to prevent keyboard capture
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
      if (textarea && typeof textarea.setAttribute === 'function') {
        if (typeof textarea.blur === 'function') textarea.blur()
        textarea.setAttribute('disabled', 'true')
      }
    }
    // Initialize state when opening
    const basePath =
      initialPath?.trim() ||
      activeProjectPath?.trim() ||
      lastProjectPath ||
      defaultProjectDir ||
      ''
    setProjectPath(basePath)
    setName('')
    setSelectedHost(initialHost ?? '')
    const trimmedInitialCommand = initialCommand?.trim()
    if (trimmedInitialCommand) {
      const matchingPreset = commandPresets.find((p) => getFullCommand(p) === trimmedInitialCommand)
      if (matchingPreset) {
        setSelectedPresetId(matchingPreset.id)
        setCommand(getFullCommand(matchingPreset))
      } else {
        setSelectedPresetId(null)
        setCommand(trimmedInitialCommand)
      }
    } else {
      // Select default preset and set full command
      const defaultPreset = commandPresets.find(p => p.id === defaultPresetId)
      if (defaultPreset) {
        setSelectedPresetId(defaultPresetId)
        setCommand(applyYoloPref(getFullCommand(defaultPreset)))
      } else if (commandPresets.length > 0) {
        setSelectedPresetId(commandPresets[0].id)
        setCommand(applyYoloPref(getFullCommand(commandPresets[0])))
      } else {
        setSelectedPresetId(null)
        setCommand('')
      }
    }
    // Focus default button and scroll project path after DOM update
    setTimeout(() => {
      defaultButtonRef.current?.focus()
      if (projectPathRef.current) {
        const input = projectPathRef.current
        input.scrollLeft = input.scrollWidth
      }
    }, 50)
  }, [activeProjectPath, commandPresets, defaultPresetId, defaultProjectDir, isOpen, lastProjectPath, initialHost, initialPath, initialCommand])

  useEffect(() => {
    if (!isOpen) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return

    const getFocusableElements = () => {
      if (!formRef.current) return []
      const selector =
        'input:not([disabled]), select:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]'
      return Array.from(formRef.current.querySelectorAll<HTMLElement>(selector))
    }

      const handleKeyDown = (e: KeyboardEvent) => {
      if (showBrowser) return

      if (e.key === 'Escape') {
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        onClose()
        return
      }

      if (e.key === 'Enter') {
        const activeEl = document.activeElement as HTMLElement | null
        if (!activeEl) return
        if (activeEl.tagName === 'INPUT') return
        // Don't auto-submit from the host picker; Enter should only select the host chip.
        if (activeEl.closest('[data-testid="host-select"]')) return
        // Preserve the "Enter submits" behavior when focus is on command preset chips.
        if (!activeEl.closest('[data-testid="command-select"]')) return

        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        formRef.current?.requestSubmit()
        return
      }

      // Digit shortcuts: 1-9 select a preset by position, 0 selects Custom.
      if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const activeEl = document.activeElement as HTMLElement | null
        if (
          activeEl &&
          (activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.tagName === 'SELECT' ||
            activeEl.isContentEditable)
        ) {
          return
        }

        let optionIndex: number
        if (e.key === '0') {
          optionIndex = commandPresets.length
        } else {
          optionIndex = Number(e.key) - 1
          if (optionIndex >= commandPresets.length) return
        }

        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        if (optionIndex === commandPresets.length) {
          handleCustomSelect()
        } else {
          handlePresetSelect(commandPresets[optionIndex].id)
        }
        // Focus the chip so Enter creates the session.
        const chips = formRef.current?.querySelectorAll?.<HTMLButtonElement>(
          '[data-testid="command-select"] [role="radio"]'
        )
        chips?.[optionIndex]?.focus()
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        const focusableElements = getFocusableElements()
        if (focusableElements.length === 0) return

        const activeEl = document.activeElement as HTMLElement
        const currentIndex = focusableElements.indexOf(activeEl)

        let nextIndex: number
        if (currentIndex === -1) {
          // If current element not in list, start from beginning or end
          nextIndex = e.shiftKey ? focusableElements.length - 1 : 0
        } else if (e.shiftKey) {
          nextIndex = currentIndex <= 0 ? focusableElements.length - 1 : currentIndex - 1
        } else {
          nextIndex = currentIndex >= focusableElements.length - 1 ? 0 : currentIndex + 1
        }

        focusableElements[nextIndex]?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, showBrowser, commandPresets, yoloMode])

  if (!isOpen) {
    return null
  }

  const isCustomMode = selectedPresetId === null
  const isRemoteHost = selectedHost !== ''

  // Yolo checkbox state is derived from the command text: the flag is visible
  // and editable in the command input, so the checkbox just toggles it.
  const commandAgentType = inferAgentType(command)
  const yoloSupported = yoloFlagFor(commandAgentType) !== null
  const yoloChecked = commandAgentType
    ? commandHasYoloFlag(command, commandAgentType)
    : false
  const yoloConflictReason =
    commandAgentType && !yoloChecked ? yoloConflict(command, commandAgentType) : null
  const yoloDisabled = !yoloSupported || yoloConflictReason !== null
  const yoloTooltip = !commandAgentType
    ? 'Enter a supported agent command (claude, codex, grok, devin)'
    : commandAgentType === 'pi'
      ? 'Pi has no permission prompts — nothing to enable'
      : yoloConflictReason ?? `Append ${yoloFlagFor(commandAgentType)}`

  const handleYoloToggle = (checked: boolean) => {
    setYoloMode(checked)
    if (!commandAgentType) return
    setCommand(
      checked
        ? addYoloFlag(command, commandAgentType)
        : removeYoloFlag(command, commandAgentType)
    )
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedPath = projectPath.trim()
    if (!trimmedPath) {
      return
    }

    const finalCommand = command.trim()
    onCreate(
      trimmedPath,
      name.trim() || undefined,
      finalCommand || undefined,
      isRemoteHost ? selectedHost : undefined
    )
    onClose()
  }

  // Build button list: presets + Custom
  const allOptions = [
    ...commandPresets.map(p => ({ id: p.id, label: p.label, isCustom: false, agentType: p.agentType, command: p.command })),
    { id: 'custom', label: 'Custom', isCustom: true, agentType: undefined, command: undefined },
  ]

  const hostOptions = [
    { id: '', label: 'Local', ok: true, error: undefined },
    ...remoteHosts.map((hostStatus) => ({
      id: hostStatus.host,
      label: hostStatus.host,
      ok: hostStatus.ok,
      error: hostStatus.error,
    })),
  ]

  const browserInitialPath = projectPath.trim() || '~'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="w-full max-w-md border border-border bg-elevated p-6"
      >
        <h2 id="new-session-title" className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
          New Session
        </h2>

        <div className="mt-4 space-y-4">
          {showHostPicker && (
            <div>
              <label className="mb-1.5 block text-xs text-secondary">
                Host
              </label>
              <div
                className="flex flex-wrap gap-2"
                role="radiogroup"
                aria-label="Host"
                data-testid="host-select"
              >
                {hostOptions.map((option, index) => {
                  const isActive = selectedHost === option.id
                  const isMuted = !option.ok && !isActive
                  return (
                    <button
                      key={option.id || 'local'}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      aria-label={option.label}
                      title={!option.ok ? (option.error || 'Unreachable') : undefined}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => setSelectedHost(option.id)}
                      onKeyDown={(e) => {
                        let newIndex = index
                        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          e.preventDefault()
                          newIndex = (index + 1) % hostOptions.length
                        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          e.preventDefault()
                          newIndex = (index - 1 + hostOptions.length) % hostOptions.length
                        } else {
                          return
                        }
                        const next = hostOptions[newIndex]
                        setSelectedHost(next.id)
                        const container = e.currentTarget.parentElement
                        const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                        buttons?.[newIndex]?.focus()
                      }}
                      className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''} ${isMuted ? 'opacity-60' : ''}`}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Command
            </label>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label="Command preset"
              data-testid="command-select"
            >
              {allOptions.map((option, index) => {
                const isActive = option.isCustom ? isCustomMode : selectedPresetId === option.id
                const digitHint = option.isCustom ? '0' : index < 9 ? String(index + 1) : null
                return (
                  <button
                    key={option.id}
                    ref={isActive ? defaultButtonRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-keyshortcuts={digitHint ?? undefined}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => {
                      if (option.isCustom) {
                        handleCustomSelect()
                      } else {
                        handlePresetSelect(option.id)
                      }
                    }}
                    onKeyDown={(e) => {
                      let newIndex = index
                      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        newIndex = (index + 1) % allOptions.length
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        newIndex = (index - 1 + allOptions.length) % allOptions.length
                      } else {
                        return
                      }
                      const newOption = allOptions[newIndex]
                      if (newOption.isCustom) {
                        handleCustomSelect()
                      } else {
                        handlePresetSelect(newOption.id)
                      }
                      const container = e.currentTarget.parentElement
                      const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                      buttons?.[newIndex]?.focus()
                    }}
                    className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''}`}
                  >
                    {digitHint && (
                      <kbd aria-hidden="true" className="shortcut-badge">
                        {digitHint}
                      </kbd>
                    )}
                    <AgentIcon agentType={option.agentType} command={option.command} className="inline-block h-3.5 w-3.5 shrink-0" />
                    {option.label}
                  </button>
                )
              })}
            </div>

            {/* Full command input */}
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Enter command..."
              className="input mt-2 font-mono text-xs"
            />

            <label
              className={`mt-2 flex items-center gap-2 text-xs ${
                yoloDisabled ? 'text-muted opacity-60' : 'text-secondary'
              }`}
              title={yoloTooltip}
            >
              <input
                type="checkbox"
                checked={yoloChecked}
                disabled={yoloDisabled}
                onChange={(event) => handleYoloToggle(event.target.checked)}
              />
              yolo mode — skip permission prompts
            </label>
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Project Path
            </label>
            <div className="flex gap-2">
              <input
                ref={projectPathRef}
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder={
                  isRemoteHost
                    ? '/home/user/project'
                    : activeProjectPath ||
                      lastProjectPath ||
                      defaultProjectDir ||
                      '/Users/you/code/my-project'
                }
                className="input flex-1 text-sm"
              />
              {!isRemoteHost && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowBrowser(true)}
                >
                  Browse
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Display Name
            </label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="auto-generated"
              className="input text-sm placeholder:italic"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Create
          </button>
        </div>
      </form>
      {showBrowser && !isRemoteHost && (
        <DirectoryBrowser
          initialPath={browserInitialPath}
          onSelect={(path) => {
            setProjectPath(path)
            setShowBrowser(false)
          }}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}
