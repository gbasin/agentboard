/** A saved session remains actionable even when no tmux window exists. */
import { useState } from 'react'
import type { SavedSession } from '@shared/persistence'
import { historyButton } from './api'
export function HistoryRow({
  session,
  selected,
  busy,
  onSelect,
  onResume,
  onChange,
  onDetails,
}: {
  session: SavedSession
  selected: boolean
  busy: boolean
  onSelect: () => void
  onResume: () => void
  onChange: (patch: {
    name?: string
    pinned?: boolean
    state?: 'archived' | 'hibernating'
  }) => void
  onDetails: () => void
}) {
  const [renaming, setRenaming] = useState(false),
    [name, setName] = useState(session.name)
  return (
    <article
      className="border-b border-border px-4 py-3"
      data-testid="saved-session"
      data-session-id={session.id}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={`Select ${session.name}`}
          checked={selected}
          onChange={onSelect}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {renaming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  onChange({ name })
                  setRenaming(false)
                }}
              >
                <input
                  aria-label="Session name"
                  className="input text-sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                />
                <button className={historyButton}>Save name</button>
              </form>
            ) : (
              <button
                className="break-all text-left text-sm font-semibold text-primary hover:underline"
                onClick={onDetails}
              >
                {session.name}
              </button>
            )}
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] uppercase ${session.state === 'interrupted' || session.state === 'failed' ? 'bg-approval/10 text-approval' : 'bg-hover text-muted'}`}
            >
              {session.state}
            </span>
            {session.pinned && (
              <span className="text-[12px] text-accent">Pinned</span>
            )}
          </div>
          <p className="mt-1 break-all text-[12px] text-muted">
            {session.projectPath} · {session.agentType || 'shell'} ·{' '}
            {new Date(session.lastActivityAt).toLocaleString()}
          </p>
          {session.origin === 'imported' && (
            <p className="mt-1 text-[11px] text-muted">
              Recovered from conversation logs
            </p>
          )}
          {session.preview && (
            <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-[12px] text-secondary">
              {session.preview}
            </p>
          )}
          {session.error && (
            <p className="mt-2 text-[12px] text-approval">{session.error}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              className={`${historyButton} border-accent text-accent`}
              disabled={busy || session.state === 'starting'}
              onClick={onResume}
            >
              {session.state === 'running' ? 'Open' : 'Reopen'}
            </button>
            <button
              className={historyButton}
              disabled={busy}
              onClick={() => {
                setName(session.name)
                setRenaming(!renaming)
              }}
            >
              Rename
            </button>
            <button
              className={historyButton}
              disabled={busy}
              onClick={() => onChange({ pinned: !session.pinned })}
            >
              {session.pinned ? 'Unpin' : 'Pin'}
            </button>
            {session.state === 'running' && (
              <button
                className={historyButton}
                disabled={busy}
                onClick={() => onChange({ state: 'hibernating' })}
              >
                Hibernate
              </button>
            )}
            {session.state !== 'archived' && (
              <button
                className={historyButton}
                disabled={busy}
                onClick={() => onChange({ state: 'archived' })}
                title={
                  session.state === 'running'
                    ? 'Stop this run and keep it in history'
                    : 'Keep this session in history'
                }
              >
                Archive
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
