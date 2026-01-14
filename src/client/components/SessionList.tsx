import { useState, useRef, useEffect, useReducer } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { HandIcon } from '@untitledui-icons/react/line'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import ChevronRightIcon from '@untitledui-icons/react/line/esm/ChevronRightIcon'
import type { AgentSession, Session } from '@shared/types'
import { sortSessions } from '../utils/sessions'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdSuffix } from '../utils/sessionId'
import { useSettingsStore } from '../stores/settingsStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import AgentIcon from './AgentIcon'
import InactiveSessionItem from './InactiveSessionItem'
import SessionPreviewModal from './SessionPreviewModal'

interface SessionListProps {
  sessions: Session[]
  inactiveSessions?: AgentSession[]
  selectedSessionId: string | null
  loading: boolean
  error: string | null
  onSelect: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onResume?: (sessionId: string) => void
}

const statusBarClass: Record<Session['status'], string> = {
  working: 'status-bar-working',
  waiting: 'status-bar-waiting',
  permission: 'status-bar-approval pulse-approval',
  unknown: 'status-bar-waiting',
}

// Force re-render every 30s to update relative timestamps
function useTimestampRefresh() {
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const id = setInterval(forceUpdate, 30000)
    return () => clearInterval(id)
  }, [])
}

export default function SessionList({
  sessions,
  inactiveSessions = [],
  selectedSessionId,
  loading,
  error,
  onSelect,
  onRename,
  onResume,
}: SessionListProps) {
  useTimestampRefresh()
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [previewSession, setPreviewSession] = useState<AgentSession | null>(null)
  const prefersReducedMotion = useReducedMotion()

  // Track counts for counter animations
  const prevActiveCountRef = useRef(sessions.length)
  const prevInactiveCountRef = useRef(inactiveSessions.length)
  const [activeCounterBump, setActiveCounterBump] = useState(false)
  const [inactiveCounterBump, setInactiveCounterBump] = useState(false)

  useEffect(() => {
    if (sessions.length !== prevActiveCountRef.current) {
      setActiveCounterBump(true)
    }
    prevActiveCountRef.current = sessions.length
  }, [sessions.length])

  useEffect(() => {
    if (inactiveSessions.length > prevInactiveCountRef.current) {
      setInactiveCounterBump(true)
    }
    prevInactiveCountRef.current = inactiveSessions.length
  }, [inactiveSessions.length])

  // Track newly added sessions for entry animations
  const prevActiveIdsRef = useRef<Set<string>>(new Set(sessions.map((s) => s.id)))
  const prevInactiveIdsRef = useRef<Set<string>>(new Set(inactiveSessions.map((s) => s.sessionId)))
  const [newlyActiveIds, setNewlyActiveIds] = useState<Set<string>>(new Set())
  const [newlyInactiveIds, setNewlyInactiveIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    const newIds = new Set<string>()
    for (const id of currentIds) {
      if (!prevActiveIdsRef.current.has(id)) {
        newIds.add(id)
      }
    }
    prevActiveIdsRef.current = currentIds

    if (newIds.size > 0) {
      setNewlyActiveIds(newIds)
      const timer = setTimeout(() => setNewlyActiveIds(new Set()), 500)
      return () => clearTimeout(timer)
    }
  }, [sessions])

  useEffect(() => {
    const currentIds = new Set(inactiveSessions.map((s) => s.sessionId))
    const newIds = new Set<string>()
    for (const id of currentIds) {
      if (!prevInactiveIdsRef.current.has(id)) {
        newIds.add(id)
      }
    }
    prevInactiveIdsRef.current = currentIds

    if (newIds.size > 0) {
      setNewlyInactiveIds(newIds)
      const timer = setTimeout(() => setNewlyInactiveIds(new Set()), 500)
      return () => clearTimeout(timer)
    }
  }, [inactiveSessions])
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))
  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const showSessionIdSuffix = useSettingsStore(
    (state) => state.showSessionIdSuffix
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
        <motion.span
          className="text-xs text-muted"
          animate={activeCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
          transition={{ duration: 0.3 }}
          onAnimationComplete={() => setActiveCounterBump(false)}
        >
          {sessions.length}
        </motion.span>
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
          <div>
            <AnimatePresence initial={false}>
              {sortedSessions.map((session) => {
                const isNew = newlyActiveIds.has(session.id)
                return (
                <motion.div
                  key={session.id}
                  layout={!prefersReducedMotion}
                  initial={prefersReducedMotion ? false : { opacity: 0, y: -10, scale: 0.95 }}
                  animate={
                    prefersReducedMotion
                      ? { opacity: 1, y: 0 }
                      : isNew
                        ? { opacity: 1, y: 0, scale: [0.95, 1.02, 1] }
                        : { opacity: 1, y: 0, scale: 1 }
                  }
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 20 }}
                  transition={prefersReducedMotion ? { duration: 0 } : {
                    layout: { type: 'spring', stiffness: 500, damping: 35 },
                    opacity: { duration: 0.2 },
                    y: { duration: 0.25 },
                    scale: { duration: 0.3 },
                  }}
                >
                  <SessionRow
                    session={session}
                    isSelected={session.id === selectedSessionId}
                    isEditing={session.id === editingSessionId}
                    showSessionIdSuffix={showSessionIdSuffix}
                    onSelect={() => onSelect(session.id)}
                    onStartEdit={() => setEditingSessionId(session.id)}
                    onCancelEdit={() => setEditingSessionId(null)}
                    onRename={(newName) => handleRename(session.id, newName)}
                  />
                </motion.div>
              )})}
            </AnimatePresence>
          </div>
        )}

        {inactiveSessions.length > 0 && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setShowInactive((value) => !value)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted hover:text-primary"
            >
              <span className="flex items-center gap-2">
                {showInactive ? (
                  <ChevronDownIcon className="h-4 w-4" />
                ) : (
                  <ChevronRightIcon className="h-4 w-4" />
                )}
                Inactive Sessions
              </span>
              <motion.span
                className="text-xs"
                animate={inactiveCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
                transition={{ duration: 0.3 }}
                onAnimationComplete={() => setInactiveCounterBump(false)}
              >
                {inactiveSessions.length}
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {showInactive && (
                <motion.div
                  className="py-1 overflow-hidden"
                  initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {inactiveSessions.map((session) => {
                    const isNew = newlyInactiveIds.has(session.sessionId)
                    return (
                    <motion.div
                      key={session.sessionId}
                      initial={
                        prefersReducedMotion || !isNew
                          ? false
                          : { opacity: 0, y: -20, scale: 0.95 }
                      }
                      animate={
                        prefersReducedMotion
                          ? { opacity: 1, y: 0 }
                          : isNew
                            ? { opacity: 1, y: 0, scale: [0.95, 1.02, 1] }
                            : { opacity: 1, y: 0, scale: 1 }
                      }
                      transition={{ duration: 0.25, delay: 0.1, scale: { duration: 0.3 } }}
                    >
                      <InactiveSessionItem
                        session={session}
                        showSessionIdSuffix={showSessionIdSuffix}
                        onResume={(sessionId) => onResume?.(sessionId)}
                        onPreview={setPreviewSession}
                      />
                    </motion.div>
                  )})}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="hidden shrink-0 border-t border-border px-3 py-2 md:block">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
          <span>{modDisplay}[ ] nav</span>
          <span>{modDisplay}N new</span>
          <span>{modDisplay}X kill</span>
        </div>
      </div>

      {previewSession && (
        <SessionPreviewModal
          session={previewSession}
          onClose={() => setPreviewSession(null)}
          onResume={(sessionId) => {
            setPreviewSession(null)
            onResume?.(sessionId)
          }}
        />
      )}
    </aside>
  )
}

interface SessionRowProps {
  session: Session
  isSelected: boolean
  isEditing: boolean
  showSessionIdSuffix: boolean
  onSelect: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
}

function SessionRow({
  session,
  isSelected,
  isEditing,
  showSessionIdSuffix,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
}: SessionRowProps) {
  const lastActivity = formatRelativeTime(session.lastActivity)
  const inputRef = useRef<HTMLInputElement>(null)
  const displayName = session.agentSessionName || session.name
  const [editValue, setEditValue] = useState(displayName)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const needsInput = session.status === 'permission'
  const agentSessionId = session.agentSessionId?.trim()
  const sessionIdSuffix =
    showSessionIdSuffix && agentSessionId
      ? getSessionIdSuffix(agentSessionId)
      : ''

  // Track previous status for transition animation
  const prevStatusRef = useRef<Session['status']>(session.status)
  const [isPulsingComplete, setIsPulsingComplete] = useState(false)

  useEffect(() => {
    const prevStatus = prevStatusRef.current
    const currentStatus = session.status

    // Detect transition from working → waiting (not permission, which needs immediate attention)
    if (prevStatus === 'working' && currentStatus === 'waiting') {
      setIsPulsingComplete(true)
      // Don't update ref yet - will update when animation ends
    } else {
      prevStatusRef.current = currentStatus
    }
  }, [session.status])

  const handlePulseAnimationEnd = () => {
    setIsPulsingComplete(false)
    prevStatusRef.current = session.status
  }

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  useEffect(() => {
    setEditValue(displayName)
  }, [displayName])

  const handleSubmit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== displayName) {
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
      setEditValue(displayName)
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
      <div
        className={`status-bar ${statusBarClass[session.status]}${isPulsingComplete ? ' pulse-complete' : ''}`}
        onAnimationEnd={handlePulseAnimationEnd}
      />

      <div className="flex flex-col gap-0.5 pl-2.5">
        {/* Line 1: Icon + Name + Time/Hand */}
        <div className="flex items-center gap-2">
          <AgentIcon
            agentType={session.agentType}
            command={session.command}
            className="h-3.5 w-3.5 shrink-0 text-muted"
          />
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSubmit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
              {displayName}
            </span>
          )}
          {sessionIdSuffix && (
            <span
              className="shrink-0 text-[11px] font-mono text-muted/70"
              title={agentSessionId}
            >
              #{sessionIdSuffix}
            </span>
          )}
          {needsInput ? (
            <HandIcon className="h-4 w-4 shrink-0 text-approval" aria-label="Needs input" />
          ) : (
            <span className="ml-1 w-8 shrink-0 text-right text-xs tabular-nums text-muted">{lastActivity}</span>
          )}
        </div>

        {/* Line 2: Directory */}
        {directoryLeaf && (
          <span
            className="truncate pl-[1.375rem] text-xs text-muted"
            title={session.projectPath}
          >
            {directoryLeaf}
          </span>
        )}
      </div>
    </div>
  )
}

export { formatRelativeTime }
