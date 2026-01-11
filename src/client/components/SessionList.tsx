import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import type { Session } from '@shared/types'
import { sortSessions } from '../utils/sessions'
import { formatCommandLabel } from '../utils/sessionLabel'
import { useSettingsStore } from '../stores/settingsStore'
import { getNavShortcutMod } from '../utils/device'

interface SessionListProps {
  sessions: Session[]
  selectedSessionId: string | null
  loading: boolean
  error: string | null
  onSelect: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
}

const statusBarClass: Record<Session['status'], string> = {
  working: 'status-bar-working',
  waiting: 'status-bar-waiting',
  permission: 'status-bar-approval pulse-approval',
  unknown: 'status-bar-waiting',
}

const statusLabel: Record<Session['status'], string> = {
  working: 'Working',
  waiting: 'Waiting',
  permission: 'Needs Input',
  unknown: 'Unknown',
}

const statusTextClass: Record<Session['status'], string> = {
  working: 'text-working',
  waiting: 'text-waiting',
  permission: 'text-approval',
  unknown: 'text-muted',
}

export default function SessionList({
  sessions,
  selectedSessionId,
  loading,
  error,
  onSelect,
  onRename,
}: SessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const prefersReducedMotion = useReducedMotion()
  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const sortedSessions = sortSessions(sessions, {
    mode: sessionSortMode,
    direction: sessionSortDirection,
  })

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
            <AnimatePresence initial={false}>
              {sortedSessions.map((session, index) => (
                <motion.div
                  key={session.id}
                  layout={!prefersReducedMotion}
                  initial={prefersReducedMotion ? false : { opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
                  transition={prefersReducedMotion ? { duration: 0 } : {
                    layout: { type: 'spring', stiffness: 500, damping: 35 },
                    opacity: { duration: 0.15 },
                  }}
                >
                  <SessionRow
                    session={session}
                    isSelected={session.id === selectedSessionId}
                    isEditing={session.id === editingSessionId}
                    shortcutIndex={index}
                    onSelect={() => onSelect(session.id)}
                    onStartEdit={() => setEditingSessionId(session.id)}
                    onCancelEdit={() => setEditingSessionId(null)}
                    onRename={(newName) => handleRename(session.id, newName)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="hidden shrink-0 border-t border-border px-3 py-2 md:block">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
          <span>{getNavShortcutMod()}[ ] nav</span>
          <span>{getNavShortcutMod()}N new</span>
          <span>{getNavShortcutMod()}X kill</span>
        </div>
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
  onStartEdit,
  onCancelEdit,
  onRename,
}: SessionRowProps) {
  const lastActivity = formatRelativeTime(session.lastActivity)
  const shortcutLabel =
    !isEditing && shortcutIndex < 9 ? String(shortcutIndex + 1) : null
  const inputRef = useRef<HTMLInputElement>(null)
  const [editValue, setEditValue] = useState(session.name)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commandLabel = formatCommandLabel(session)

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
      className={`session-row group cursor-pointer px-3 py-2 ${isSelected ? 'selected' : ''}`}
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
          {commandLabel && (
            <div className="mt-0.5">
              <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {commandLabel}
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

        {/* Position indicator */}
        {shortcutLabel && (
          <span className="hidden text-xs tabular-nums text-muted/50 md:block">
            {shortcutLabel}
          </span>
        )}
      </div>
    </div>
  )
}

export function formatRelativeTime(iso: string): string {
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
