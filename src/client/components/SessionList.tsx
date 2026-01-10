import { useState, useRef, useEffect } from 'react'
import type { Session } from '@shared/types'
import { sortSessions } from '../utils/sessions'

interface SessionListProps {
  sessions: Session[]
  selectedSessionId: string | null
  loading: boolean
  error: string | null
  onSelect: (sessionId: string) => void
  onKill: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
}

const statusBarClass: Record<Session['status'], string> = {
  working: 'status-bar-working',
  needs_approval: 'status-bar-approval',
  waiting: 'status-bar-waiting',
  unknown: 'status-bar-waiting',
}

const statusLabel: Record<Session['status'], string> = {
  working: 'Working',
  needs_approval: 'Approval',
  waiting: 'Waiting',
  unknown: 'Unknown',
}

const statusTextClass: Record<Session['status'], string> = {
  working: 'text-working',
  needs_approval: 'text-approval',
  waiting: 'text-waiting',
  unknown: 'text-muted',
}

export default function SessionList({
  sessions,
  selectedSessionId,
  loading,
  error,
  onSelect,
  onKill,
  onRename,
}: SessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const sortedSessions = sortSessions(sessions)

  const handleKill = (session: Session) => {
    if (session.source !== 'managed') return
    const confirmed = window.confirm(
      `Kill session "${session.name}"? This will close the tmux window.`
    )
    if (confirmed) {
      onKill(session.id)
    }
  }

  const handleRename = (sessionId: string, newName: string) => {
    onRename(sessionId, newName)
    setEditingSessionId(null)
  }

  return (
    <aside className="flex h-full flex-col border-r border-border bg-elevated">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">
          Sessions
        </span>
        <span className="text-xs text-muted">{sessions.length}</span>
      </div>

      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded bg-surface"
              />
            ))}
          </div>
        ) : sortedSessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            No sessions
          </div>
        ) : (
          <div className="py-1">
            {sortedSessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                isSelected={session.id === selectedSessionId}
                isEditing={session.id === editingSessionId}
                shortcutIndex={index}
                onSelect={() => onSelect(session.id)}
                onKill={() => handleKill(session)}
                onStartEdit={() => setEditingSessionId(session.id)}
                onCancelEdit={() => setEditingSessionId(null)}
                onRename={(newName) => handleRename(session.id, newName)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

interface SessionRowProps {
  session: Session
  isSelected: boolean
  isEditing: boolean
  shortcutIndex: number
  onSelect: () => void
  onKill: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
}

function SessionRow({
  session,
  isSelected,
  isEditing,
  shortcutIndex,
  onSelect,
  onKill,
  onStartEdit,
  onCancelEdit,
  onRename,
}: SessionRowProps) {
  const lastActivity = formatRelativeTime(session.lastActivity)
  const isApproval = session.status === 'needs_approval'
  const shortcutLabel =
    !isEditing && shortcutIndex < 9 ? String(shortcutIndex + 1) : null
  const inputRef = useRef<HTMLInputElement>(null)
  const [editValue, setEditValue] = useState(session.name)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  useEffect(() => {
    setEditValue(session.name)
  }, [session.name])

  const handleSubmit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== session.name) {
      onRename(trimmed)
    } else {
      onCancelEdit()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditValue(session.name)
      onCancelEdit()
    }
  }

  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      onStartEdit()
    }, 500)
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  return (
    <div
      className={`session-row group cursor-pointer px-3 py-2 ${isSelected ? 'selected' : ''} ${isApproval ? 'pulse-approval' : ''}`}
      role="button"
      tabIndex={0}
      data-testid="session-card"
      data-session-id={session.id}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div className={`status-bar ${statusBarClass[session.status]}`} />

      <div className="flex items-start justify-between gap-2 pl-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleSubmit}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
              />
            ) : (
              <span className="truncate text-sm font-medium text-primary">
                {session.name}
              </span>
            )}
          </div>
          {session.command && (
            <div className="mt-0.5">
              <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {session.command}
              </span>
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-xs">
            <span className={statusTextClass[session.status]}>
              {statusLabel[session.status]}
            </span>
            <span className="text-muted">{lastActivity}</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {!isEditing && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onStartEdit()
              }}
              className="rounded p-1 text-muted opacity-0 transition-opacity hover:bg-surface hover:text-primary group-hover:opacity-100"
              title="Rename session"
            >
              <GearIcon />
            </button>
          )}
          {session.source === 'managed' && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onKill()
              }}
              className="btn btn-danger hidden py-0.5 text-[10px] group-hover:flex"
            >
              Kill
            </button>
          )}
          {shortcutLabel && (
            <span
              className="shortcut-badge hidden md:inline-flex"
              title={`Shortcut: Cmd/Ctrl+${shortcutLabel}`}
              aria-label={`Shortcut Cmd/Ctrl+${shortcutLabel}`}
            >
              <CommandIcon />
              <span className="shortcut-plus">+</span>
              <span>{shortcutLabel}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function GearIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function CommandIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 3a3 3 0 0 0-3 3v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V6a3 3 0 1 0-3 3h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6a3 3 0 1 0 3 3v-1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a3 3 0 1 0 3-3h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h1a3 3 0 0 0 0-6z" />
    </svg>
  )
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''

  const delta = Date.now() - timestamp
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  return `${days}d`
}
