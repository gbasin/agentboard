import { useEffect, useRef, useState } from 'react'
import { type CommandPreset, getFullCommand } from '../stores/settingsStore'
import { DirectoryBrowser } from './DirectoryBrowser'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (projectPath: string, name?: string, command?: string) => void
  defaultProjectDir: string
  commandPresets: CommandPreset[]
  defaultPresetId: string
  lastProjectPath?: string | null
  activeProjectPath?: string
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
}: NewSessionModalProps) {
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const [showBrowser, setShowBrowser] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const projectPathRef = useRef<HTMLInputElement>(null)
  const defaultButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) {
      setProjectPath('')
      setName('')
      setSelectedPresetId(null)
      setCommand('')
      setShowBrowser(false)
      // Focus terminal after modal closes
      setTimeout(() => {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea) {
          textarea.removeAttribute('disabled')
          textarea.focus()
        }
      }, 300)
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
      activeProjectPath?.trim() || lastProjectPath || defaultProjectDir
    setProjectPath(basePath)
    setName('')
    // Select default preset and set full command
    const defaultPreset = commandPresets.find(p => p.id === defaultPresetId)
    if (defaultPreset) {
      setSelectedPresetId(defaultPresetId)
      setCommand(getFullCommand(defaultPreset))
    } else if (commandPresets.length > 0) {
      setSelectedPresetId(commandPresets[0].id)
      setCommand(getFullCommand(commandPresets[0]))
    } else {
      setSelectedPresetId(null)
      setCommand('')
    }
    // Focus default button and scroll project path after DOM update
    setTimeout(() => {
      defaultButtonRef.current?.focus()
      if (projectPathRef.current) {
        const input = projectPathRef.current
        input.scrollLeft = input.scrollWidth
      }
    }, 50)
  }, [activeProjectPath, commandPresets, defaultPresetId, defaultProjectDir, isOpen, lastProjectPath])

  useEffect(() => {
    if (!isOpen) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return

    const getFocusableElements = () => {
      if (!formRef.current) return []
      const selector =
        'input:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]'
      return Array.from(formRef.current.querySelectorAll<HTMLElement>(selector))
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (showBrowser) return

      if (e.key === 'Escape') {
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        onClose()
        return
      }

      if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        formRef.current?.requestSubmit()
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
  }, [isOpen, onClose, showBrowser])

  if (!isOpen) {
    return null
  }

  const handlePresetSelect = (presetId: string) => {
    const preset = commandPresets.find(p => p.id === presetId)
    if (preset) {
      setSelectedPresetId(presetId)
      setCommand(getFullCommand(preset))
    }
  }

  const handleCustomSelect = () => {
    setSelectedPresetId(null)
    setCommand('')
  }

  const isCustomMode = selectedPresetId === null

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
      finalCommand || undefined
    )
    onClose()
  }

  // Build button list: presets + Custom
  const allOptions = [
    ...commandPresets.map(p => ({ id: p.id, label: p.label, isCustom: false })),
    { id: 'custom', label: 'Custom', isCustom: true },
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
                    ref={isActive ? defaultButtonRef : undefined}
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
                    className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''}`}
                  >
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
                  activeProjectPath ||
                  lastProjectPath ||
                  defaultProjectDir ||
                  '/Users/you/code/my-project'
                }
                className="input flex-1 text-sm"
              />
              <button
                type="button"
                className="btn"
                onClick={() => setShowBrowser(true)}
              >
                Browse
              </button>
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
      {showBrowser && (
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
