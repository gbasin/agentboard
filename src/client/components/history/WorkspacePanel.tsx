/** Named session groups, saved and reopened together. */
import { useState } from 'react'
import type { SavedWorkspace } from '@shared/persistence'
import { historyButton, libraryRequest } from './api'
export function WorkspacePanel({
  workspaces,
  selected,
  busy,
  act,
  setNotice,
}: {
  workspaces: SavedWorkspace[]
  selected: Set<string>
  busy: boolean
  act: (fn: () => Promise<unknown>) => Promise<void>
  setNotice: (value: string) => void
}) {
  const [workspaceName, setWorkspaceName] = useState('')
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[12px]">
      <p className="text-muted">
        Save a group of sessions and reopen them together. Running sessions are
        reused.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            await libraryRequest('/workspaces', 'POST', {
              name: workspaceName,
              sessionIds: [...selected],
            })
            setWorkspaceName('')
            setNotice('Workspace saved.')
          })
        }}
      >
        <input
          className="input flex-1"
          aria-label="Workspace name"
          placeholder="Workspace name, e.g. A/B/C team"
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
        />
        <button
          className={historyButton}
          disabled={busy || !selected.size || !workspaceName.trim()}
        >
          Save {selected.size} selected sessions
        </button>
      </form>
      {workspaces.map((w) => (
        <div
          key={w.id}
          className="flex flex-wrap items-center justify-between gap-2 border border-border p-3"
        >
          <div>
            <h3 className="font-semibold text-primary">{w.name}</h3>
            <p className="mt-1 text-muted">{w.sessionIds.length} sessions</p>
          </div>
          <div className="flex gap-2">
            <button
              className={historyButton}
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await libraryRequest<{
                    results: Array<{ ok: boolean; error?: string }>
                  }>(`/workspaces/${w.id}/resume`, 'POST', {})
                  setNotice(
                    `Reopened ${r.results.filter((x) => x.ok).length} sessions.`
                  )
                  const failures = r.results.filter((x) => !x.ok)
                  if (failures.length)
                    throw new Error(failures.map((x) => x.error).join('\n'))
                })
              }
            >
              Reopen workspace
            </button>
            <button
              className={historyButton}
              disabled={busy}
              onClick={() =>
                act(() => libraryRequest(`/workspaces/${w.id}`, 'DELETE'))
              }
            >
              Delete group
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
