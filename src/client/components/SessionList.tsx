import { useState, useRef, useEffect, useReducer, useCallback, useMemo } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { HandIcon } from '@untitledui-icons/react/line'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import ChevronRightIcon from '@untitledui-icons/react/line/esm/ChevronRightIcon'
import type { AgentSession, Session } from '@shared/types'
import { getSessionOrderKey, getUniqueProjects, sortSessions } from '../utils/sessions'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import AgentIcon from './AgentIcon'
import InactiveSessionItem from './InactiveSessionItem'
import ProjectFilterDropdown from './ProjectFilterDropdown'
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
  const showInactive = useSettingsStore((state) => state.inactiveSessionsExpanded)
  const setShowInactive = useSettingsStore((state) => state.setInactiveSessionsExpanded)
  const [previewSession, setPreviewSession] = useState<AgentSession | null>(null)
  const prefersReducedMotion = useReducedMotion()

  // Animation sequencing constants (in ms)
  const EXIT_DURATION = 200
  const COUNTER_DELAY = EXIT_DURATION
  const COUNTER_DURATION = 300
  const ENTRY_DELAY = COUNTER_DELAY + COUNTER_DURATION

  // Track counts for counter animations
  const prevActiveCountRef = useRef(sessions.length)
  const prevInactiveCountRef = useRef(inactiveSessions.length)
  const [activeCounterBump, setActiveCounterBump] = useState(false)
  const [inactiveCounterBump, setInactiveCounterBump] = useState(false)

  // Track pending counter bumps (delayed until exit animation completes)
  const pendingActiveCounterRef = useRef(false)
  const pendingInactiveCounterRef = useRef(false)

  // Detect count changes and queue delayed counter bumps
  useEffect(() => {
    if (sessions.length !== prevActiveCountRef.current) {
      pendingActiveCounterRef.current = true
      const timer = setTimeout(() => {
        if (pendingActiveCounterRef.current) {
          setActiveCounterBump(true)
          pendingActiveCounterRef.current = false
        }
      }, COUNTER_DELAY)
      prevActiveCountRef.current = sessions.length
      return () => clearTimeout(timer)
    }
  }, [sessions.length, COUNTER_DELAY])

  useEffect(() => {
    if (inactiveSessions.length > prevInactiveCountRef.current) {
      pendingInactiveCounterRef.current = true
      const timerId = setTimeout(() => {
        if (pendingInactiveCounterRef.current) {
          setInactiveCounterBump(true)
          pendingInactiveCounterRef.current = false
        }
      }, COUNTER_DELAY)
      prevInactiveCountRef.current = inactiveSessions.length
      return () => clearTimeout(timerId)
    }
    prevInactiveCountRef.current = inactiveSessions.length
  }, [inactiveSessions.length, COUNTER_DELAY])

  // Track newly added sessions for entry animations
  const prevActiveIdsRef = useRef<Set<string>>(new Set(sessions.map((s) => s.id)))
  const prevInactiveIdsRef = useRef<Set<string>>(new Set(inactiveSessions.map((s) => s.sessionId)))
  const prevInactiveIdsForActiveRef = useRef<Set<string>>(
    new Set(inactiveSessions.map((s) => s.sessionId))
  )
  const [newlyActiveIds, setNewlyActiveIds] = useState<Set<string>>(new Set())
  const [newlyInactiveIds, setNewlyInactiveIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    const currentInactiveIds = new Set(
      inactiveSessions.map((s) => s.sessionId)
    )
    const newIds = new Set<string>()
    for (const id of currentIds) {
      if (!prevActiveIdsRef.current.has(id)) {
        newIds.add(id)
      }
    }
    for (const session of sessions) {
      const agentId = session.agentSessionId?.trim()
      if (
        agentId &&
        prevInactiveIdsForActiveRef.current.has(agentId) &&
        !currentInactiveIds.has(agentId)
      ) {
        newIds.add(session.id)
      }
    }
    prevActiveIdsRef.current = currentIds
    prevInactiveIdsForActiveRef.current = currentInactiveIds

    if (newIds.size > 0) {
      setNewlyActiveIds(newIds)
      const timer = setTimeout(() => setNewlyActiveIds(new Set()), 500)
      return () => clearTimeout(timer)
    }
  }, [sessions, inactiveSessions])

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
  const setSessionSortMode = useSettingsStore((state) => state.setSessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const manualSessionOrder = useSettingsStore((state) => state.manualSessionOrder)
  const setManualSessionOrder = useSettingsStore((state) => state.setManualSessionOrder)
  const showProjectName = useSettingsStore((state) => state.showProjectName)
  const showLastUserMessage = useSettingsStore(
    (state) => state.showLastUserMessage
  )
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )
  const projectFilters = useSettingsStore((state) => state.projectFilters)
  const setProjectFilters = useSettingsStore((state) => state.setProjectFilters)

  // Get exiting sessions from store (sessions being animated out)
  const exitingSessions = useSessionStore((state) => state.exitingSessions)
  const clearExitingSession = useSessionStore((state) => state.clearExitingSession)
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Merge exiting sessions back into the list to maintain position during exit animation
  const sessionsWithExiting = useMemo(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    const exiting = Array.from(exitingSessions.values()).filter(
      (s) => !currentIds.has(s.id)
    )
    return [...sessions, ...exiting]
  }, [sessions, exitingSessions])

  // Track which session IDs are currently exiting (for disabling sortable)
  const exitingIds = useMemo(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    return new Set(
      Array.from(exitingSessions.keys()).filter((id) => !currentIds.has(id))
    )
  }, [sessions, exitingSessions])

  // Clear exiting sessions after exit animation completes without resetting on frequent updates
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    const exitingIdSet = new Set(exitingSessions.keys())

    for (const id of exitingIdSet) {
      if (currentIds.has(id) || exitTimersRef.current.has(id)) {
        continue
      }
      const timer = setTimeout(() => {
        clearExitingSession(id)
        exitTimersRef.current.delete(id)
      }, EXIT_DURATION + 50)
      exitTimersRef.current.set(id, timer)
    }

    for (const [id, timer] of exitTimersRef.current) {
      if (!exitingIdSet.has(id) || currentIds.has(id)) {
        clearTimeout(timer)
        exitTimersRef.current.delete(id)
      }
    }
  }, [sessions, exitingSessions, clearExitingSession, EXIT_DURATION])

  useEffect(() => {
    return () => {
      for (const timer of exitTimersRef.current.values()) {
        clearTimeout(timer)
      }
      exitTimersRef.current.clear()
    }
  }, [])

  // Filter inactive sessions to exclude any still exiting from active list
  const inactiveSessionsWithoutExiting = useMemo(() => {
    if (exitingSessions.size === 0) return inactiveSessions
    // Get agent session IDs of exiting sessions
    const exitingAgentIds = new Set(
      Array.from(exitingSessions.values())
        .map((s) => s.agentSessionId?.trim())
        .filter(Boolean)
    )
    return inactiveSessions.filter(
      (s) => !exitingAgentIds.has(s.sessionId)
    )
  }, [inactiveSessions, exitingSessions])

  // Clean up manualSessionOrder when sessions are removed
  useEffect(() => {
    if (manualSessionOrder.length === 0) return
    const currentIds = new Set<string>()
    for (const session of sessions) {
      currentIds.add(getSessionOrderKey(session))
      currentIds.add(session.id)
    }
    for (const session of inactiveSessions) {
      currentIds.add(session.sessionId)
    }
    const validOrder = manualSessionOrder.filter((id) => currentIds.has(id))
    if (validOrder.length !== manualSessionOrder.length) {
      setManualSessionOrder(validOrder)
    }
  }, [sessions, inactiveSessions, manualSessionOrder, setManualSessionOrder])

  // Use sessionsWithExiting to maintain position during exit animation
  const sortedSessions = sortSessions(sessionsWithExiting, {
    mode: sessionSortMode,
    direction: sessionSortDirection,
    manualOrder: manualSessionOrder,
  })

  const uniqueProjects = useMemo(
    () => getUniqueProjects(sessions, inactiveSessions),
    [sessions, inactiveSessions]
  )

  const filteredSessions = useMemo(() => {
    if (projectFilters.length === 0) return sortedSessions
    return sortedSessions.filter((session) => projectFilters.includes(session.projectPath))
  }, [sortedSessions, projectFilters])

  const filteredInactiveSessions = useMemo(() => {
    if (projectFilters.length === 0) return inactiveSessionsWithoutExiting
    return inactiveSessionsWithoutExiting.filter(
      (session) => projectFilters.includes(session.projectPath)
    )
  }, [inactiveSessionsWithoutExiting, projectFilters])

  const hiddenPermissionCount = useMemo(() => {
    if (projectFilters.length === 0) return 0
    const filterSet = new Set(projectFilters)
    return sessions.filter(
      (session) =>
        !filterSet.has(session.projectPath) && session.status === 'permission'
    ).length
  }, [sessions, projectFilters])

  useEffect(() => {
    if (projectFilters.length === 0) return
    const validProjects = new Set(uniqueProjects)
    const nextFilters = projectFilters.filter((project) => validProjects.has(project))
    if (nextFilters.length !== projectFilters.length) {
      setProjectFilters(nextFilters)
    }
  }, [projectFilters, uniqueProjects, setProjectFilters])

  // Drag-and-drop setup
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement to start drag (prevents accidental drags)
      },
    })
  )

  // Track active drag state for drop indicator
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  // Disable layout animations briefly after drag to prevent conflicts
  const [layoutAnimationsDisabled, setLayoutAnimationsDisabled] = useState(false)

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
    setLayoutAnimationsDisabled(true)
  }, [])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverId(event.over?.id as string | null)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      setOverId(null)

      if (!over || active.id === over.id) {
        // Re-enable layout animations after a brief delay
        setTimeout(() => setLayoutAnimationsDisabled(false), 100)
        return
      }

      const oldIndex = filteredSessions.findIndex((s) => s.id === active.id)
      const newIndex = filteredSessions.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) {
        setTimeout(() => setLayoutAnimationsDisabled(false), 100)
        return
      }

      const reorderedVisible = filteredSessions.map((s) => getSessionOrderKey(s))
      const [removed] = reorderedVisible.splice(oldIndex, 1)
      reorderedVisible.splice(newIndex, 0, removed)

      const fullOrder = sortedSessions.map((s) => getSessionOrderKey(s))
      const visibleSet = new Set(reorderedVisible)
      let visibleIndex = 0
      const newOrder = fullOrder.map((id) => {
        if (!visibleSet.has(id)) return id
        const nextId = reorderedVisible[visibleIndex]
        visibleIndex += 1
        return nextId
      })

      // Switch to manual mode and update order
      if (sessionSortMode !== 'manual') {
        setSessionSortMode('manual')
      }
      setManualSessionOrder(newOrder)
      // Re-enable layout animations after state settles
      setTimeout(() => setLayoutAnimationsDisabled(false), 100)
    },
    [
      filteredSessions,
      sortedSessions,
      sessionSortMode,
      setSessionSortMode,
      setManualSessionOrder,
    ]
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    setTimeout(() => setLayoutAnimationsDisabled(false), 100)
  }, [])

  useEffect(() => {
    if (!activeId && !overId) return
    const currentIds = new Set(filteredSessions.map((s) => s.id))
    let shouldReset = false
    if (activeId && !currentIds.has(activeId)) {
      setActiveId(null)
      shouldReset = true
    }
    if (overId && !currentIds.has(overId)) {
      setOverId(null)
      shouldReset = true
    }
    if (shouldReset) {
      setLayoutAnimationsDisabled(false)
    }
  }, [filteredSessions, activeId, overId])

  const handleRename = (sessionId: string, newName: string) => {
    onRename(sessionId, newName)
    setEditingSessionId(null)
  }

  return (
    <aside className="flex min-h-0 flex-1 flex-col border-r border-border bg-elevated">
      {error && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex h-10 items-center justify-between border-b border-border bg-elevated px-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">
            Sessions
          </span>
          <div className="flex items-center gap-4">
            <ProjectFilterDropdown
              projects={uniqueProjects}
              selectedProjects={projectFilters}
              onSelect={setProjectFilters}
              hasHiddenPermissions={hiddenPermissionCount > 0}
            />
            <motion.span
              className="w-8 text-right text-xs text-muted"
              animate={activeCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
              transition={{ duration: 0.3 }}
              onAnimationComplete={() => setActiveCounterBump(false)}
            >
              {filteredSessions.length}
            </motion.span>
          </div>
        </div>
        {loading ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded bg-surface"
              />
            ))}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            No sessions
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            {/* Exclude exiting sessions from SortableContext to prevent useSortable interference */}
            <SortableContext
              items={filteredSessions.filter((s) => !exitingIds.has(s.id)).map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <div>
                <AnimatePresence initial={false}>
                  {filteredSessions.map((session, index) => {
                    const isNew = newlyActiveIds.has(session.id)
                    const entryDelay = isNew ? ENTRY_DELAY / 1000 : 0
                    const isExiting = exitingIds.has(session.id)
                    // Calculate drop indicator position
                    const activeIndex = activeId
                      ? filteredSessions.findIndex((s) => s.id === activeId)
                      : -1
                    const isOver = overId === session.id && activeId !== session.id
                    const showDropIndicator = isOver ? (activeIndex > index ? 'above' : 'below') : null
                    return (
                      <SortableSessionItem
                        key={session.id}
                        session={session}
                        isNew={isNew}
                        isExiting={isExiting}
                        entryDelay={entryDelay}
                        exitDuration={EXIT_DURATION}
                        prefersReducedMotion={prefersReducedMotion}
                        layoutAnimationsDisabled={layoutAnimationsDisabled}
                        isSelected={session.id === selectedSessionId}
                        isEditing={session.id === editingSessionId}
                        showSessionIdPrefix={showSessionIdPrefix}
                        showProjectName={showProjectName}
                        showLastUserMessage={showLastUserMessage}
                        dropIndicator={showDropIndicator}
                        onSelect={() => onSelect(session.id)}
                        onStartEdit={() => setEditingSessionId(session.id)}
                        onCancelEdit={() => setEditingSessionId(null)}
                        onRename={(newName) => handleRename(session.id, newName)}
                      />
                    )
                  })}
                </AnimatePresence>
              </div>
            </SortableContext>
          </DndContext>
        )}

        {filteredInactiveSessions.length > 0 && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setShowInactive(!showInactive)}
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
                className="w-8 text-right text-xs"
                animate={inactiveCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
                transition={{ duration: 0.3 }}
                onAnimationComplete={() => setInactiveCounterBump(false)}
              >
                {filteredInactiveSessions.length}
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
                  {filteredInactiveSessions.map((session) => {
                    const isNew = newlyInactiveIds.has(session.sessionId)
                    // Delay entry animation for cards transitioning from active
                    const entryDelay = isNew ? ENTRY_DELAY / 1000 : 0
                    return (
                    <motion.div
                      key={session.sessionId}
                      initial={
                        prefersReducedMotion || !isNew
                          ? false
                          : { opacity: 0, y: -16, scale: 0.85 }
                      }
                      animate={
                        prefersReducedMotion
                          ? { opacity: 1, y: 0 }
                          : isNew
                            ? { opacity: 1, y: 0, scale: [1.06, 0.98, 1] }
                            : { opacity: 1, y: 0, scale: 1 }
                      }
                      transition={{
                        duration: 0.3,
                        delay: entryDelay,
                        scale: { duration: 0.4, ease: [0.34, 1.56, 0.64, 1], delay: entryDelay },
                      }}
                    >
                      <InactiveSessionItem
                        session={session}
                        showSessionIdPrefix={showSessionIdPrefix}
                        showProjectName={showProjectName}
                        showLastUserMessage={showLastUserMessage}
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

interface SortableSessionItemProps {
  session: Session
  isNew: boolean
  isExiting: boolean
  entryDelay: number
  exitDuration: number
  prefersReducedMotion: boolean | null
  layoutAnimationsDisabled: boolean
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  dropIndicator: 'above' | 'below' | null
  onSelect: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
}

function SortableSessionItem({
  session,
  isNew,
  isExiting,
  entryDelay,
  exitDuration,
  prefersReducedMotion,
  layoutAnimationsDisabled,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  dropIndicator,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
}: SortableSessionItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: session.id, disabled: isExiting })

  // Don't apply sortable transforms for exiting items
  const style = isExiting ? undefined : {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.9 : undefined,
  }

  return (
    <motion.div
      ref={isExiting ? undefined : setNodeRef}
      style={style}
      className="relative"
      layout={!prefersReducedMotion && !isDragging && !layoutAnimationsDisabled && !isExiting}
      initial={prefersReducedMotion ? false : { opacity: 0, y: -16, scale: 0.85 }}
      animate={
        prefersReducedMotion
          ? { opacity: 1, y: 0 }
          : isNew
            ? { opacity: 1, y: 0, scale: [1.06, 0.98, 1] }
            : { opacity: 1, y: 0, scale: 1 }
      }
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.9 }}
      transition={prefersReducedMotion ? { duration: 0 } : {
        layout: { type: 'spring', stiffness: 500, damping: 35, delay: entryDelay },
        opacity: { duration: exitDuration / 1000, delay: isExiting ? 0 : entryDelay },
        y: { duration: exitDuration / 1000, ease: 'easeOut', delay: isExiting ? 0 : entryDelay },
        scale: { duration: 0.4, ease: [0.34, 1.56, 0.64, 1], delay: isExiting ? 0 : entryDelay },
      }}
      {...(isExiting ? {} : attributes)}
      {...(isExiting ? {} : listeners)}
    >
      {/* Drop indicator line */}
      {dropIndicator === 'above' && (
        <div className="absolute -top-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
      <SessionRow
        session={session}
        isSelected={isSelected}
        isEditing={isEditing}
        showSessionIdPrefix={showSessionIdPrefix}
        showProjectName={showProjectName}
        showLastUserMessage={showLastUserMessage}
        isDragging={isDragging}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onRename={onRename}
      />
      {dropIndicator === 'below' && (
        <div className="absolute -bottom-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
    </motion.div>
  )
}

interface SessionRowProps {
  session: Session
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  isDragging?: boolean
  onSelect: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
}

function SessionRow({
  session,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  isDragging = false,
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
  const sessionIdPrefix =
    showSessionIdPrefix && agentSessionId
      ? getSessionIdShort(agentSessionId)
      : ''
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const showMessage = showLastUserMessage && Boolean(session.lastUserMessage)

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
    if (isDragging) return
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
      className={`session-row group cursor-pointer px-3 py-2 ${isSelected ? 'selected' : ''} ${isDragging ? 'cursor-grabbing shadow-lg ring-1 ring-accent/30 bg-elevated' : 'cursor-grab'}`}
      role="button"
      tabIndex={0}
      data-testid="session-card"
      data-session-id={session.id}
      onClick={isDragging ? undefined : onSelect}
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
          {sessionIdPrefix && (
            <span
              className="shrink-0 text-[11px] font-mono text-muted"
              title={agentSessionId}
            >
              {sessionIdPrefix}
            </span>
          )}
          {needsInput ? (
            <span className="ml-1 flex w-8 shrink-0 justify-end">
              <HandIcon className="h-4 w-4 text-approval" aria-label="Needs input" />
            </span>
          ) : (
            <span className="ml-1 w-8 shrink-0 text-right text-xs tabular-nums text-muted">{lastActivity}</span>
          )}
        </div>

        {/* Line 2: Directory + last user message (up to 2 lines total) */}
        {(showDirectory || showMessage) && (
          <span
            className="line-clamp-2 pl-[1.375rem] text-xs text-muted"
            title={showDirectory ? session.projectPath : undefined}
          >
            {showDirectory ? directoryLeaf : null}
            {showMessage ? (
              <span className="italic">
                {showDirectory ? `: "${session.lastUserMessage}"` : `"${session.lastUserMessage}"`}
              </span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  )
}

export { formatRelativeTime }
