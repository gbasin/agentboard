import { useEffect, useState } from 'react'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (projectPath: string, name?: string) => void
}

export default function NewSessionModal({
  isOpen,
  onClose,
  onCreate,
}: NewSessionModalProps) {
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')

  useEffect(() => {
    if (!isOpen) {
      setProjectPath('')
      setName('')
    }
  }, [isOpen])

  if (!isOpen) {
    return null
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!projectPath.trim()) {
      return
    }
    onCreate(projectPath.trim(), name.trim() || undefined)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6">
      <form
        onSubmit={handleSubmit}
        className="glass-card w-full max-w-lg rounded-3xl border p-6"
      >
        <h2 className="text-lg font-semibold text-ink">New Session</h2>
        <p className="mt-2 text-sm text-muted">
          Enter the absolute project path. A tmux window will launch Claude in
          that directory.
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="text-xs uppercase tracking-[0.2em] text-muted">
              Project Path
            </label>
            <input
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/Users/you/code/my-project"
              className="mt-2 w-full rounded-2xl border border-white/60 bg-white/80 px-4 py-3 text-sm text-ink shadow-glow focus:outline-none focus:ring-2 focus:ring-accent/60"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-[0.2em] text-muted">
              Display Name (optional)
            </label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-project"
              className="mt-2 w-full rounded-2xl border border-white/60 bg-white/80 px-4 py-3 text-sm text-ink shadow-glow focus:outline-none focus:ring-2 focus:ring-accent/60"
            />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/70 bg-white/70 px-4 py-2 text-sm font-semibold text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            Create Session
          </button>
        </div>
      </form>
    </div>
  )
}
