import { useState, useRef, useEffect, useCallback, useMemo, forwardRef } from 'react'
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
import { HandIcon, XCloseIcon } from '@untitledui-icons/react/line'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'
import File06Icon from '@untitledui-icons/react/line/esm/File06Icon'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import ChevronRightIcon from '@untitledui-icons/react/line/esm/ChevronRightIcon'
import Edit05Icon from '@untitledui-icons/react/line/esm/Edit05Icon'
import Pin02Icon from '@untitledui-icons/react/line/esm/Pin02Icon'
import type { AgentSession, Session } from '@shared/types'
import { getSessionOrderKey, getUniqueHosts, getUniqueProjects, sortSessions } from '../utils/sessions'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import { useCounterBump } from '../hooks/useCounterBump'
import { useExitCleanup } from '../hooks/useExitCleanup'
import AgentIcon from './AgentIcon'
import InactiveSessionItem from './InactiveSessionItem'
import ProjectBadge from './ProjectBadge'
import HostBadge from './HostBadge'
import HostFilterDropdown from './HostFilterDropdown'
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
  onKill?: (sessionId: string) => void
  onDuplicate?: (sessionId: string) => void
  onSetPinned?: (sessionId: string, isPinned: boolean) => void
}

/** Status pill classes for the time/activity badge */
const statusPillClass: Record<Session['status'], string> = {
  working: 'bg-green-500/20 text-green-600',
  waiting: 'bg-zinc-500/20 text-zinc-400',
  permission: 'bg-amber-500/20 text-amber-600',
  unknown: 'bg-zinc-500/20 text-zinc-400',
}

function useTimestampRefresh() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30000)
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
  onKill,
  onDuplicate,
  onSetPinned,
}: SessionListProps) {
  useTimestampRefresh()
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const showInactive = useSettingsStore((state) => state.inactiveSessionsExpanded)
  const setShowInactive = useSettingsStore((state) => state.setInactiveSessionsExpanded)
  const [previewSession, setPreviewSession] = useState<AgentSession | null>(null)
  const [inactiveLimit, setInactiveLimit] = useState(20)
  const prefersReducedMotion = useReducedMotion()

  // Reset pagination when inactive panel is collapsed
  useEffect(() => {
    if (!showInactive) {
      setInactiveLimit(20)
    }
  }, [showInactive])

  // Animation sequencing constants (in ms)
  const EXIT_DURATION = 200

  // Counter bump animations
  const [activeCounterBump, clearActiveCounterBump] = useCounterBump(sessions.length, EXIT_DURATION)
  const [inactiveCounterBump, clearInactiveCounterBump] = useCounterBump(inactiveSessions.length, EXIT_DURATION, true)

  // Track newly added sessions for entry animations
  const prevActiveIdsRef = useRef<Set<string>>(new Set(sessions.map((s) => s.id)))
  const prevInactiveIdsForActiveRef = useRef<Set<string>>(
    new Set(inactiveSessions.map((s) => s.sessionId))
  )
  const [newlyActiveIds, setNewlyActiveIds] = useState<Set<string>>(new Set())

  // Detect newly active sessions
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
    }
  }, [sessions, inactiveSessions])

  // Auto-clear newlyActiveIds after delay (separate effect to avoid timer bugs)
  useEffect(() => {
    if (newlyActiveIds.size === 0) return
    const timer = setTimeout(() => setNewlyActiveIds(new Set()), 500)
    return () => clearTimeout(timer)
  }, [newlyActiveIds])

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
  const hostFilters = useSettingsStore((state) => state.hostFilters)
  const setHostFilters = useSettingsStore((state) => state.setHostFilters)

  // Get exiting sessions from store (for kill-failed rollback only)
  const exitingSessions = useSessionStore((state) => state.exitingSessions)
  const clearExitingSession = useSessionStore((state) => state.clearExitingSession)
  const hostStatuses = useSessionStore((state) => state.hostStatuses)
  const remoteAllowControl = useSessionStore((state) => state.remoteAllowControl)

  // Clean up exiting session state after animations
  useExitCleanup(sessions, exitingSessions, clearExitingSession, EXIT_DURATION)


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

  const sortedActive = useMemo(
    () =>
      sortSessions(sessions, {
        mode: sessionSortMode,
        direction: sessionSortDirection,
        manualOrder: manualSessionOrder,
      }),
    [sessions, sessionSortMode, sessionSortDirection, manualSessionOrder]
  )

  // Don't add exiting sessions back to the list - let AnimatePresence handle
  // the exit animation naturally. This prevents the 250ms delay before animation starts.
  const sortedSessions = sortedActive

  const uniqueProjects = useMemo(
    () => getUniqueProjects(sessions, inactiveSessions),
    [sessions, inactiveSessions]
  )

  const uniqueHosts = useMemo(() => {
    const sessionHosts = getUniqueHosts(sessions, inactiveSessions)
    const statusHosts = hostStatuses.map((status) => status.host)
    const seen = new Set<string>()
    const merged: string[] = []

    for (const host of statusHosts) {
      if (!host || seen.has(host)) continue
      seen.add(host)
      merged.push(host)
    }

    for (const host of sessionHosts) {
      if (!host || seen.has(host)) continue
      seen.add(host)
      merged.push(host)
    }

    return merged
  }, [sessions, inactiveSessions, hostStatuses])

  // Auto-show host info when multiple hosts are present
  const showHostInfo = useMemo(() => uniqueHosts.length > 1, [uniqueHosts])

  const filteredSessions = useMemo(() => {
    let next = sortedSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [sortedSessions, projectFilters, hostFilters])

  const filterKey = useMemo(
    () => {
      const projectKey = projectFilters.length === 0 ? 'all-projects' : projectFilters.join('|')
      const hostKey = hostFilters.length === 0 ? 'all-hosts' : hostFilters.join('|')
      return `${projectKey}::${hostKey}`
    },
    [projectFilters, hostFilters]
  )

  // Track sessions that became visible due to filter changes (for entry animation)
  const prevFilteredIdsRef = useRef<Set<string>>(new Set(filteredSessions.map((s) => s.id)))
  const [newlyFilteredInIds, setNewlyFilteredInIds] = useState<Set<string>>(new Set())

  // Detect sessions that became visible due to filter changes
  useEffect(() => {
    const currentFilteredIds = new Set(filteredSessions.map((s) => s.id))
    const newlyVisible = new Set<string>()

    // Find sessions that are now visible but weren't before
    for (const id of currentFilteredIds) {
      if (!prevFilteredIdsRef.current.has(id)) {
        // Only mark as "newly filtered in" if the session already existed (wasn't truly new)
        // This distinguishes filter changes from actual new sessions
        if (!newlyActiveIds.has(id)) {
          newlyVisible.add(id)
        }
      }
    }

    prevFilteredIdsRef.current = currentFilteredIds

    if (newlyVisible.size > 0) {
      setNewlyFilteredInIds(newlyVisible)
    }
  }, [filteredSessions, newlyActiveIds])

  // Auto-clear newlyFilteredInIds after delay (separate effect to avoid timer bugs)
  useEffect(() => {
    if (newlyFilteredInIds.size === 0) return
    const timer = setTimeout(() => setNewlyFilteredInIds(new Set()), 500)
    return () => clearTimeout(timer)
  }, [newlyFilteredInIds])

  const filteredInactiveSessions = useMemo(() => {
    let next = inactiveSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [inactiveSessions, projectFilters, hostFilters])

  const hiddenPermissionCount = useMemo(() => {
    if (projectFilters.length === 0) return 0
    const filterSet = new Set(projectFilters)
    return sessions.filter(
      (session) =>
        !filterSet.has(session.projectPath) && session.status === 'permission'
    ).length
  }, [sessions, projectFilters])

  useEffect(() => {
    // Skip cleanup when no projects loaded yet (would clear persisted filters on initial load)
    if (projectFilters.length === 0 || uniqueProjects.length === 0) return
    const validProjects = new Set(uniqueProjects)
    const nextFilters = projectFilters.filter((project) => validProjects.has(project))
    if (nextFilters.length !== projectFilters.length) {
      setProjectFilters(nextFilters)
    }
  }, [projectFilters, uniqueProjects, setProjectFilters])

  useEffect(() => {
    if (hostFilters.length === 0 || uniqueHosts.length === 0) return
    const validHosts = new Set(uniqueHosts)
    const nextFilters = hostFilters.filter((host) => validHosts.has(host))
    if (nextFilters.length !== hostFilters.length) {
      setHostFilters(nextFilters)
    }
  }, [hostFilters, uniqueHosts, setHostFilters])

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
            {showHostInfo && (
              <HostFilterDropdown
                hosts={uniqueHosts}
                selectedHosts={hostFilters}
                onSelect={setHostFilters}
                statuses={hostStatuses}
              />
            )}
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
              onAnimationComplete={clearActiveCounterBump}
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
            <SortableContext
              items={filteredSessions.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <div key={filterKey}>
                <AnimatePresence initial={false}>
                  {filteredSessions.map((session, index) => {
                    const isTrulyNew = newlyActiveIds.has(session.id)
                    const isFilteredIn = newlyFilteredInIds.has(session.id)
                    const isRemote = session.remote === true
                    const isManaged = session.source === 'managed'
                    const canControl = !isRemote || (remoteAllowControl && isManaged)
                    // Calculate drop indicator position
                    const activeIndex = activeId
                      ? filteredSessions.findIndex((s) => s.id === activeId)
                      : -1
                    const isOver = overId === session.id && activeId !== session.id
                    const showDropIndicator = isOver ? (activeIndex > index ? 'above' : 'below') : null
                    // Show bounce for both new and filter-in, but delay only for truly new
                    const isNew = isTrulyNew || isFilteredIn
                    return (
                      <SortableSessionItem
                        key={session.id}
                        session={session}
                        isNew={isNew}
                        exitDuration={EXIT_DURATION}
                        prefersReducedMotion={prefersReducedMotion}
                        layoutAnimationsDisabled={layoutAnimationsDisabled}
                        isSelected={session.id === selectedSessionId}
                        isEditing={session.id === editingSessionId}
                        showSessionIdPrefix={showSessionIdPrefix}
                        showProjectName={showProjectName}
                        showLastUserMessage={showLastUserMessage}
                        showHostInfo={showHostInfo}
                        dropIndicator={showDropIndicator}
                        onSelect={() => onSelect(session.id)}
                        onStartEdit={canControl ? () => setEditingSessionId(session.id) : undefined}
                        onCancelEdit={() => setEditingSessionId(null)}
                        onRename={(newName) => handleRename(session.id, newName)}
                        onKill={onKill && canControl ? () => onKill(session.id) : undefined}
                        onDuplicate={onDuplicate && canControl ? () => onDuplicate(session.id) : undefined}
                        onSetPinned={onSetPinned && session.agentSessionId ? (isPinned) => onSetPinned(session.agentSessionId!.trim(), isPinned) : undefined}
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
                onAnimationComplete={clearInactiveCounterBump}
              >
                {filteredInactiveSessions.length}
              </motion.span>
            </button>
            {showInactive && (
              <div className="py-1">
                {filteredInactiveSessions.slice(0, inactiveLimit).map((session) => (
                  <InactiveSessionItem
                    key={session.sessionId}
                    session={session}
                    showSessionIdPrefix={showSessionIdPrefix}
                    showProjectName={showProjectName}
                    showLastUserMessage={showLastUserMessage}
                    onResume={(sessionId) => onResume?.(sessionId)}
                    onPreview={setPreviewSession}
                    onSetPinned={onSetPinned}
                  />
                ))}
                {filteredInactiveSessions.length > inactiveLimit && (
                  <button
                    type="button"
                    onClick={() => setInactiveLimit((prev) => prev + 20)}
                    className="w-full px-3 py-2 text-center text-xs text-muted hover:text-primary hover:bg-hover"
                  >
                    Show more ({filteredInactiveSessions.length - inactiveLimit} remaining)
                  </button>
                )}
              </div>
            )}
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
  exitDuration: number
  prefersReducedMotion: boolean | null
  layoutAnimationsDisabled: boolean
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  showHostInfo: boolean
  dropIndicator: 'above' | 'below' | null
  onSelect: () => void
  onStartEdit?: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onKill?: () => void
  onDuplicate?: () => void
  onSetPinned?: (isPinned: boolean) => void
}

const SortableSessionItem = forwardRef<HTMLDivElement, SortableSessionItemProps>(function SortableSessionItem({
  session,
  isNew,
  exitDuration,
  prefersReducedMotion,
  layoutAnimationsDisabled,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  showHostInfo,
  dropIndicator,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onKill,
  onDuplicate,
  onSetPinned,
}, ref) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: session.id,
    animateLayoutChanges: ({ isSorting, wasDragging }) => isSorting || wasDragging,
  })

  const dndTransform = CSS.Transform.toString(transform)
  const shouldApplyStyleTransform = Boolean(prefersReducedMotion && dndTransform)
  const style = {
    ...(shouldApplyStyleTransform ? { transform: dndTransform, transition } : {}),
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.9 : undefined,
  }

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node)
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [setNodeRef, ref],
  )

  return (
    <motion.div
      ref={setRefs}
      style={{ ...style, overflow: 'hidden' }}
      className="relative"
      layout={!prefersReducedMotion && !isDragging && !layoutAnimationsDisabled && !isNew}
      transformTemplate={(_, generatedTransform) => {
        if (!dndTransform) return generatedTransform
        if (!generatedTransform || generatedTransform === 'none') return dndTransform
        return `${dndTransform} ${generatedTransform}`
      }}
      initial={prefersReducedMotion || !isNew ? false : { opacity: 0, scale: 0.97 }}
      animate={
        prefersReducedMotion
          ? { opacity: 1 }
          : isNew
            ? { opacity: 1, scale: [1.02, 0.99, 1] }
            : { opacity: 1, scale: 1 }
      }
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, scale: 0.97 }}
      transition={prefersReducedMotion ? { duration: 0 } : {
        layout: { type: 'spring', stiffness: 500, damping: 35 },
        opacity: { duration: exitDuration / 1000 },
        scale: { duration: exitDuration / 1000, ease: [0.34, 1.56, 0.64, 1] },
        height: { duration: exitDuration / 1000, ease: 'easeOut' },
      }}
      {...attributes}
      {...listeners}
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
        showHostInfo={showHostInfo}
        isDragging={isDragging}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onRename={onRename}
        onKill={onKill}
        onDuplicate={onDuplicate}
        onSetPinned={onSetPinned}
      />
      {dropIndicator === 'below' && (
        <div className="absolute -bottom-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
    </motion.div>
  )
})

SortableSessionItem.displayName = 'SortableSessionItem'

interface SessionRowProps {
  session: Session
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  showHostInfo: boolean
  isDragging?: boolean
  onSelect: () => void
  onStartEdit?: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onKill?: () => void
  onDuplicate?: () => void
  onSetPinned?: (isPinned: boolean) => void
}

function SessionRow({
  session,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  showHostInfo,
  isDragging = false,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onKill,
  onDuplicate,
  onSetPinned,
}: SessionRowProps) {
  const lastActivity = formatRelativeTime(session.lastActivity)
  const inputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const displayName =
    session.agentSessionName?.trim() ||
    session.name?.trim() ||
    session.id
  const [editValue, setEditValue] = useState(displayName)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const hostLabel = session.host?.trim()
  const needsInput = session.status === 'permission'
  const agentSessionId = session.agentSessionId?.trim()
  const sessionIdPrefix =
    showSessionIdPrefix && agentSessionId
      ? getSessionIdShort(agentSessionId)
      : ''
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const showHostBadge = showHostInfo && Boolean(hostLabel)
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

  const touchStartPos = useRef<{ x: number; y: number } | null>(null)

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isDragging) return
    const touch = e.touches[0]
    touchStartPos.current = { x: touch.clientX, y: touch.clientY }
    longPressTimer.current = setTimeout(() => {
      if (touchStartPos.current) {
        setContextMenu(touchStartPos.current)
      }
    }, 500)
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  // Close context menu on click outside or escape
  useEffect(() => {
    if (!contextMenu) return

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div
      className={`session-row group cursor-pointer select-none px-3 py-2 ${isSelected ? 'selected' : ''} ${isDragging ? 'cursor-grabbing shadow-lg ring-1 ring-accent/30 bg-elevated' : 'cursor-grab'}`}
      role="button"
      tabIndex={0}
      data-testid="session-card"
      data-session-id={session.id}
      onClick={isDragging ? undefined : onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div className="flex flex-col gap-0.5 pl-0.5">
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
          {session.isPinned && (
            <Pin02Icon
              className="h-3 w-3 shrink-0 text-primary"
              aria-label="Pinned"
              title="Pinned - will auto-resume on server restart"
            />
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
            <span
              className={`ml-1 flex shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 ${statusPillClass[session.status]} pulse-approval`}
              onAnimationEnd={handlePulseAnimationEnd}
            >
              <HandIcon className="h-3 w-3" aria-label="Needs input" />
            </span>
          ) : (
            <span
              className={`ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-right text-xs tabular-nums ${statusPillClass[session.status]}${isPulsingComplete ? ' pulse-complete' : ''}`}
              onAnimationEnd={handlePulseAnimationEnd}
            >
              {lastActivity}
            </span>
          )}
        </div>

        {/* Line 2: Project badge + last user message (up to 2 lines total) */}
        {(showDirectory || showHostBadge || showMessage) && (
          <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
            {showHostBadge && <HostBadge name={hostLabel!} />}
            {showDirectory && (
              <ProjectBadge name={directoryLeaf!} fullPath={session.projectPath} />
            )}
            {showMessage && (
              <span className="line-clamp-2 text-xs italic text-muted">
                "{session.lastUserMessage!.length > 200
                  ? session.lastUserMessage!.slice(0, 200) + '…'
                  : session.lastUserMessage}"
              </span>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {onStartEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onStartEdit()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
            >
              <Edit05Icon width={14} height={14} />
              Rename
            </button>
          )}
          {onDuplicate && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onDuplicate()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title="Create a copy in a new tmux window"
            >
              <Copy01Icon width={14} height={14} />
              Duplicate
            </button>
          )}
          {onSetPinned && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onSetPinned(!session.isPinned)
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.isPinned ? 'Remove from auto-resume list' : 'Auto-resume on server restart'}
            >
              <Pin02Icon width={14} height={14} />
              {session.isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {session.logFilePath && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                const pathToCopy = session.logFilePath
                setContextMenu(null)
                if (pathToCopy) {
                  // Use textarea fallback for better mobile support
                  const textarea = document.createElement('textarea')
                  textarea.value = pathToCopy
                  textarea.style.position = 'fixed'
                  textarea.style.left = '-9999px'
                  document.body.appendChild(textarea)
                  textarea.focus()
                  textarea.select()
                  try {
                    document.execCommand('copy')
                  } catch {
                    // Fallback to clipboard API
                    void navigator.clipboard.writeText(pathToCopy).catch(() => {})
                  }
                  document.body.removeChild(textarea)
                }
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.logFilePath}
            >
              <File06Icon width={14} height={14} />
              Copy Log Path
            </button>
          )}
          {onKill && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setContextMenu(null)
                  onKill()
                }}
                className="w-full px-3 py-2 text-left text-sm text-danger hover:bg-danger/10 flex items-center gap-2"
                role="menuitem"
              >
                <XCloseIcon width={14} height={14} />
                Kill Session
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export { formatRelativeTime }
