import { useEffect, useState } from 'react'
import {
  DEFAULT_COMMAND,
  DEFAULT_PROJECT_DIR,
  useSettingsStore,
  type SessionSortDirection,
  type SessionSortMode,
} from '../stores/settingsStore'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function SettingsModal({
  isOpen,
  onClose,
}: SettingsModalProps) {
  const defaultProjectDir = useSettingsStore((state) => state.defaultProjectDir)
  const setDefaultProjectDir = useSettingsStore(
    (state) => state.setDefaultProjectDir
  )
  const defaultCommand = useSettingsStore((state) => state.defaultCommand)
  const setDefaultCommand = useSettingsStore((state) => state.setDefaultCommand)
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

  const [draftDir, setDraftDir] = useState(defaultProjectDir)
  const [draftCommand, setDraftCommand] = useState(defaultCommand)
  const [draftSortMode, setDraftSortMode] =
    useState<SessionSortMode>(sessionSortMode)
  const [draftSortDirection, setDraftSortDirection] =
    useState<SessionSortDirection>(sessionSortDirection)

  useEffect(() => {
    if (isOpen) {
      setDraftDir(defaultProjectDir)
      setDraftCommand(defaultCommand)
      setDraftSortMode(sessionSortMode)
      setDraftSortDirection(sessionSortDirection)
    }
  }, [
    defaultCommand,
    defaultProjectDir,
    sessionSortMode,
    sessionSortDirection,
    isOpen,
  ])

  if (!isOpen) {
    return null
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedDir = draftDir.trim()
    const trimmedCommand = draftCommand.trim()
    setDefaultProjectDir(trimmedDir || DEFAULT_PROJECT_DIR)
    setDefaultCommand(trimmedCommand || DEFAULT_COMMAND)
    setSessionSortMode(draftSortMode)
    setSessionSortDirection(draftSortDirection)
    onClose()
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
        className="w-full max-w-md border border-border bg-elevated p-6"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
          Settings
        </h2>
        <p className="mt-2 text-xs text-muted text-pretty">
          Set the default directory for new sessions. Tilde (~) resolves to your
          home directory on the server.
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
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Default Command
            </label>
            <input
              value={draftCommand}
              onChange={(event) => setDraftCommand(event.target.value)}
              placeholder={DEFAULT_COMMAND}
              className="input font-mono"
            />
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
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn">
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
