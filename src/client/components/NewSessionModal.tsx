import { useEffect, useRef, useState } from 'react'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (projectPath: string, name?: string, command?: string) => void
  defaultProjectDir: string
  defaultCommand: string
  lastProjectPath?: string | null
  activeProjectPath?: string
}

export type CommandMode = 'claude' | 'codex' | 'custom'

const COMMAND_PRESETS = [
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
  { label: 'Custom', value: '' },
] as const

export function getCommandMode(defaultCommand: string): CommandMode {
  if (defaultCommand === 'claude') return 'claude'
  if (defaultCommand === 'codex') return 'codex'
  return 'custom'
}

export function resolveCommand(commandMode: CommandMode, command: string): string {
  return commandMode === 'custom' ? command.trim() : commandMode
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
  defaultCommand,
  lastProjectPath,
  activeProjectPath,
}: NewSessionModalProps) {
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [commandMode, setCommandMode] = useState<CommandMode>('claude')
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!isOpen) {
      setProjectPath('')
      setName('')
      setCommand('')
      setCommandMode('claude')
      // Focus terminal after modal closes (with delay to let it settle)
      setTimeout(() => {
        if (typeof document === 'undefined') return
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea) {
          textarea.removeAttribute('disabled')
          textarea.focus()
        }
      }, 300)
      return
    }
    // Priority: active session -> last used -> default
    const basePath =
      activeProjectPath?.trim() || lastProjectPath || defaultProjectDir
    setProjectPath(basePath)
    setName('')
    const nextMode = getCommandMode(defaultCommand)
    setCommandMode(nextMode)
    setCommand(nextMode === 'custom' ? defaultCommand : '')
  }, [activeProjectPath, defaultCommand, defaultProjectDir, isOpen, lastProjectPath])

  useEffect(() => {
    if (!isOpen) return

    const getFocusableElements = () => {
      if (!formRef.current) return []
      // Only get elements that are actually tabbable (not tabindex="-1")
      const selector =
        'input:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]'
      return Array.from(formRef.current.querySelectorAll<HTMLElement>(selector))
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      // Enter key submits form from anywhere (except input fields which handle it natively)
      if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        formRef.current?.requestSubmit()
        return
      }

      // Focus trap: manually handle all Tab navigation within the modal
      if (e.key === 'Tab') {
        e.preventDefault()
        const focusableElements = getFocusableElements()
        if (focusableElements.length === 0) return

        const activeEl = document.activeElement as HTMLElement
        const currentIndex = focusableElements.indexOf(activeEl)

        let nextIndex: number
        if (e.shiftKey) {
          // Shift+Tab: go backwards
          nextIndex = currentIndex <= 0 ? focusableElements.length - 1 : currentIndex - 1
        } else {
          // Tab: go forwards
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
    const finalCommand = resolveCommand(commandMode, command)
    onCreate(
      resolvedPath,
      name.trim() || undefined,
      finalCommand || undefined
    )
    onClose()
  }

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
            <div className="flex gap-2" role="radiogroup" aria-label="Command type">
              {COMMAND_PRESETS.map((preset, index) => {
                const mode = preset.value || 'custom'
                const isActive = commandMode === mode
                const modes = COMMAND_PRESETS.map((p) => p.value || 'custom')
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => {
                      setCommandMode(mode as CommandMode)
                      if (mode !== 'custom') setCommand('')
                    }}
                    onKeyDown={(e) => {
                      let newIndex = index
                      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        newIndex = (index + 1) % modes.length
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        newIndex = (index - 1 + modes.length) % modes.length
                      } else {
                        return
                      }
                      const newMode = modes[newIndex] as CommandMode
                      setCommandMode(newMode)
                      if (newMode !== 'custom') setCommand('')
                      // Focus the new button
                      const container = e.currentTarget.parentElement
                      const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                      buttons?.[newIndex]?.focus()
                    }}
                    className={`btn flex-1 text-xs ${isActive ? 'btn-primary' : ''}`}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
            {commandMode === 'custom' && (
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="Enter custom command..."
                className="input mt-2 font-mono"
              />
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
