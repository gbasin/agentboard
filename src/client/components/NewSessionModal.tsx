import { useEffect, useRef, useState } from 'react'
import { type CommandPreset, getFullCommand } from '../stores/settingsStore'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (projectPath: string, name?: string, command?: string) => void
  defaultProjectDir: string
  commandPresets: CommandPreset[]
  defaultPresetId: string
  onUpdateModifiers: (presetId: string, modifiers: string) => void
  lastProjectPath?: string | null
  activeProjectPath?: string
}

export function resolveProjectPath({
  value,
  activeProjectPath,
  lastProjectPath,
  defaultProjectDir,
}: {
  value: string
  activeProjectPath?: string
  lastProjectPath?: string | null
  defaultProjectDir: string
}): string {
  const trimmedValue = value.trim()
  const baseDir =
    activeProjectPath?.trim() || lastProjectPath || defaultProjectDir.trim()
  if (!trimmedValue) {
    return baseDir
  }

  const isAbsolute =
    trimmedValue.startsWith('/') ||
    trimmedValue.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(trimmedValue)

  if (isAbsolute || !baseDir) {
    return trimmedValue
  }

  const base = baseDir.replace(/[\\/]+$/, '')
  return `${base}/${trimmedValue}`
}

export default function NewSessionModal({
  isOpen,
  onClose,
  onCreate,
  defaultProjectDir,
  commandPresets,
  defaultPresetId,
  onUpdateModifiers,
  lastProjectPath,
  activeProjectPath,
}: NewSessionModalProps) {
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [modifiers, setModifiers] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  const [isCustomMode, setIsCustomMode] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // Get current preset
  const selectedPreset = selectedPresetId
    ? commandPresets.find(p => p.id === selectedPresetId)
    : null

  // Compute preview command
  const previewCommand = isCustomMode
    ? customCommand.trim()
    : selectedPreset
      ? getFullCommand({ ...selectedPreset, modifiers })
      : ''

  useEffect(() => {
    if (!isOpen) {
      setProjectPath('')
      setName('')
      setSelectedPresetId(null)
      setModifiers('')
      setCustomCommand('')
      setIsCustomMode(false)
      // Focus terminal after modal closes
      setTimeout(() => {
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea) {
          textarea.removeAttribute('disabled')
          textarea.focus()
        }
      }, 300)
      return
    }
    // Initialize state when opening
    const basePath =
      activeProjectPath?.trim() || lastProjectPath || defaultProjectDir
    setProjectPath(basePath)
    setName('')
    // Select default preset
    const defaultPreset = commandPresets.find(p => p.id === defaultPresetId)
    if (defaultPreset) {
      setSelectedPresetId(defaultPresetId)
      setModifiers(defaultPreset.modifiers)
      setIsCustomMode(false)
    } else if (commandPresets.length > 0) {
      setSelectedPresetId(commandPresets[0].id)
      setModifiers(commandPresets[0].modifiers)
      setIsCustomMode(false)
    } else {
      setIsCustomMode(true)
    }
    setCustomCommand('')
  }, [activeProjectPath, commandPresets, defaultPresetId, defaultProjectDir, isOpen, lastProjectPath])

  useEffect(() => {
    if (!isOpen) return

    const getFocusableElements = () => {
      if (!formRef.current) return []
      const selector =
        'input:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]'
      return Array.from(formRef.current.querySelectorAll<HTMLElement>(selector))
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        formRef.current?.requestSubmit()
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        const focusableElements = getFocusableElements()
        if (focusableElements.length === 0) return

        const activeEl = document.activeElement as HTMLElement
        const currentIndex = focusableElements.indexOf(activeEl)

        let nextIndex: number
        if (e.shiftKey) {
          nextIndex = currentIndex <= 0 ? focusableElements.length - 1 : currentIndex - 1
        } else {
          nextIndex = currentIndex >= focusableElements.length - 1 ? 0 : currentIndex + 1
        }

        focusableElements[nextIndex]?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  const handlePresetSelect = (presetId: string) => {
    const preset = commandPresets.find(p => p.id === presetId)
    if (preset) {
      setSelectedPresetId(presetId)
      setModifiers(preset.modifiers)
      setIsCustomMode(false)
    }
  }

  const handleCustomSelect = () => {
    setIsCustomMode(true)
    setSelectedPresetId(null)
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const resolvedPath = resolveProjectPath({
      value: projectPath,
      activeProjectPath,
      lastProjectPath,
      defaultProjectDir,
    })
    if (!resolvedPath) {
      return
    }

    let finalCommand: string
    if (isCustomMode) {
      finalCommand = customCommand.trim()
    } else if (selectedPreset) {
      // Auto-save modifier if changed
      const trimmedModifiers = modifiers.trim()
      if (trimmedModifiers !== selectedPreset.modifiers.trim()) {
        onUpdateModifiers(selectedPreset.id, trimmedModifiers)
      }
      finalCommand = getFullCommand({ ...selectedPreset, modifiers: trimmedModifiers })
    } else {
      finalCommand = ''
    }

    onCreate(
      resolvedPath,
      name.trim() || undefined,
      finalCommand || undefined
    )
    onClose()
  }

  // Build button list: presets + Custom
  const allOptions = [
    ...commandPresets.map(p => ({ id: p.id, label: p.label, isCustom: false })),
    { id: 'custom', label: 'Custom', isCustom: true },
  ]

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
        <p className="mt-2 text-xs text-muted text-pretty">
          Enter an absolute project path or a folder name. Relative paths use
          the base directory.
        </p>
        {(activeProjectPath?.trim() || lastProjectPath || defaultProjectDir.trim()) ? (
          <p className="mt-1 text-xs text-muted">
            Base: {activeProjectPath?.trim() || lastProjectPath || defaultProjectDir.trim()}
          </p>
        ) : null}

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Project Path
            </label>
            <input
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder={
                activeProjectPath ||
                lastProjectPath ||
                defaultProjectDir ||
                '/Users/you/code/my-project'
              }
              className="input"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Display Name
            </label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="auto-generated"
              className="input placeholder:italic"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Command
            </label>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Command preset">
              {allOptions.map((option, index) => {
                const isActive = option.isCustom ? isCustomMode : selectedPresetId === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
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
                    className={`btn text-xs ${isActive ? 'btn-primary' : ''}`}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>

            {/* Modifier input for presets */}
            {!isCustomMode && selectedPreset && (
              <div className="mt-2">
                <input
                  value={modifiers}
                  onChange={(event) => setModifiers(event.target.value)}
                  placeholder="Modifiers (e.g., --model opus)"
                  className="input font-mono text-sm"
                />
              </div>
            )}

            {/* Custom command input */}
            {isCustomMode && (
              <input
                value={customCommand}
                onChange={(event) => setCustomCommand(event.target.value)}
                placeholder="Enter custom command..."
                className="input mt-2 font-mono"
              />
            )}

            {/* Command preview */}
            {previewCommand && (
              <p className="mt-2 text-xs text-muted font-mono truncate">
                Will run: {previewCommand}
              </p>
            )}
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
    </div>
  )
}
