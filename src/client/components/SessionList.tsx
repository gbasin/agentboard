import { useState, useRef, useEffect, useCallback, useMemo, forwardRef, type ReactNode } from 'react'
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
import type { AgentSession, Session, SessionKillSource } from '@shared/types'
import { freezeListOrderDuringDrag, getSessionOrderKey, getUniqueHosts, getUniqueProjects, sortSessions } from '../utils/sessions'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { copyText } from '../utils/copyText'
import { composeSortableTransform } from '../utils/sortableTransform'
import { useSettingsStore, type SidebarAnchor } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import { useCounterBump } from '../hooks/useCounterBump'
import { useExitCleanup } from '../hooks/useExitCleanup'
import { useScrollToSelection } from '../hooks/useScrollToSelection'
import { useIsMobileLayout } from '../hooks/useMobileLayout'
import { useBottomPinnedScroll } from '../hooks/useBottomPinnedScroll'
import { useMenuViewportFit } from '../hooks/useMenuViewportFit'
import AgentIcon from './AgentIcon'
import { Copy01Icon, Edit05Icon, File06Icon, HandIcon, Moon01Icon, PlusIcon, XCloseIcon } from './icons'
import { ICON_SIZE, MOBILE_ROW_TARGET_CLASS } from './controlStyles'
import ProjectBadge from './ProjectBadge'
import HostBadge from './HostBadge'
import { PrChips } from './PrChips'
import SessionFilterButton from './SessionFilterButton'
import SessionPreviewModal from './SessionPreviewModal'
import { HibernatingSection, HistorySection } from './DormantSessionSections'

interface SessionListProps {
  sessions: Session[]
  hibernatingSessions?: AgentSession[]
  historySessions?: AgentSession[]
  selectedSessionId: string | null
  selectedHibernatingSessionId?: string | null
  loading: boolean
  error: string | null
  onSelect: (sessionId: string) => void
  onSelectHibernating?: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onResume?: (sessionId: string) => void
  onHibernate?: (sessionId: string) => void
  onKill?: (sessionId: string, source?: SessionKillSource) => void
  onDuplicate?: (sessionId: string) => void
  onMoveToHistory?: (sessionId: string) => void
  onNewSession?: () => void
  /** False while the list is off-screen (closed mobile drawer): defers
   * scroll-to-selection until it becomes visible again. */
  scrollSelectionActive?: boolean
  /** 'bottom' mirrors the column vertically (desktop only): sections and rows
   * render in reverse, the filter bar sticks to the bottom, and the list
   * stays pinned to its bottom edge. Sort order and indices are unchanged. */
  anchor?: SidebarAnchor
  /** Global controls at the right end of the filter bar (desktop only;
   * the mobile drawer has its own header). */
  filterBarControls?: ReactNode
  /** Optional banner (e.g. session recovery) that belongs to the list region.
   * Top: directly under the filter bar, scrolling with the rows. Bottom: a
   * pinned row at the top of the column, since the first row must sit flush
   * on the filter bar. Never above the controls bar under Top. */
  notice?: ReactNode
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
  hibernatingSessions = [],
  historySessions = [],
  selectedSessionId,
  selectedHibernatingSessionId = null,
  loading,
  error,
  onSelect,
  onSelectHibernating,
  onRename,
  onResume,
  onHibernate,
  onKill,
  onDuplicate,
  onMoveToHistory,
  onNewSession,
  scrollSelectionActive = true,
  anchor = 'top',
  filterBarControls,
  notice,
}: SessionListProps) {
  const isBottom = anchor === 'bottom'
  useTimestampRefresh()
  const isSafari = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  }, [])
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const showHibernating = useSettingsStore((state) => state.hibernatingSessionsExpanded)
  const [previewSession, setPreviewSession] = useState<AgentSession | null>(null)
  const prefersReducedMotion = useReducedMotion()
  const useSafariLayoutFallback = isSafari && !prefersReducedMotion
  const dormantSessions = useMemo(
    () => [...hibernatingSessions, ...historySessions],
    [hibernatingSessions, historySessions]
  )

  // Animation sequencing constants (in ms)
  const EXIT_DURATION = 200

  // Counter bump animations
  const [activeCounterBump, clearActiveCounterBump] = useCounterBump(
    sessions.length,
    EXIT_DURATION
  )
  const [historyCounterBump, clearHistoryCounterBump] = useCounterBump(historySessions.length, EXIT_DURATION, true)

  // Track newly added sessions for entry animations
  const prevActiveIdsRef = useRef<Set<string>>(new Set(sessions.map((s) => s.id)))
  const prevDormantIdsForActiveRef = useRef<Set<string>>(
    new Set(
      [...hibernatingSessions, ...historySessions].map((session) => session.sessionId)
    )
  )
  const [newlyActiveIds, setNewlyActiveIds] = useState<Set<string>>(new Set())

  // Detect newly active sessions
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    const currentDormantIds = new Set(
      [...hibernatingSessions, ...historySessions].map((session) => session.sessionId)
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
        prevDormantIdsForActiveRef.current.has(agentId) &&
        !currentDormantIds.has(agentId)
      ) {
        newIds.add(session.id)
      }
    }
    prevActiveIdsRef.current = currentIds
    prevDormantIdsForActiveRef.current = currentDormantIds

    if (newIds.size > 0) {
      setNewlyActiveIds(newIds)
    }
  }, [sessions, hibernatingSessions, historySessions])

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

  // Drag state: the active/over row ids plus a frozen snapshot of the list
  // order, captured at drag start. Live session updates must not reorder the
  // list under a held pointer (dnd-kit measures droppable rects against the
  // rendered order; mid-drag churn teleports rows and mis-targets drops).
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [dragOrderSnapshot, setDragOrderSnapshot] = useState<string[] | null>(null)
  const lastNonActiveOverIdRef = useRef<string | null>(null)

  // Keep the selected row visible when selection changes (keyboard nav,
  // auto-select after kill, persisted selection on reload). A hibernating
  // selection renders no row while its section is collapsed — skip scrolling.
  // Also skip while a drag is in progress: scrollIntoView would shift every
  // droppable rect mid-gesture.
  const listScrollRef = useRef<HTMLDivElement>(null)
  const listContentRef = useRef<HTMLDivElement>(null)
  // Must run before useScrollToSelection (layout effects run in order).
  useBottomPinnedScroll(listScrollRef, listContentRef, isBottom)
  useScrollToSelection(
    listScrollRef,
    selectedSessionId ?? selectedHibernatingSessionId,
    (id) => id !== selectedHibernatingSessionId || showHibernating,
    scrollSelectionActive && !activeId
  )


  // Clean up manualSessionOrder when sessions are removed
  useEffect(() => {
    if (manualSessionOrder.length === 0) return
    const currentIds = new Set<string>()
    for (const session of sessions) {
      currentIds.add(getSessionOrderKey(session))
      currentIds.add(session.id)
    }
    for (const session of dormantSessions) {
      currentIds.add(session.sessionId)
    }
    const validOrder = manualSessionOrder.filter((id) => currentIds.has(id))
    if (validOrder.length !== manualSessionOrder.length) {
      setManualSessionOrder(validOrder)
    }
  }, [sessions, dormantSessions, manualSessionOrder, setManualSessionOrder])

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
    () => getUniqueProjects(sessions, dormantSessions),
    [sessions, dormantSessions]
  )

  const uniqueHosts = useMemo(() => {
    const sessionHosts = getUniqueHosts(sessions, dormantSessions)
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
  }, [sessions, dormantSessions, hostStatuses])

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

  const filteredHibernatingSessions = useMemo(() => {
    let next = hibernatingSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [hibernatingSessions, projectFilters, hostFilters])

  const filteredHistorySessions = useMemo(() => {
    let next = historySessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [historySessions, projectFilters, hostFilters])

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

  // While dragging, render in the snapshot order — never the live order.
  const displaySessions = useMemo(
    () => freezeListOrderDuringDrag(filteredSessions, dragOrderSnapshot),
    [filteredSessions, dragOrderSnapshot]
  )

  // Stable items array for SortableContext: useSortable treats a new array
  // identity as "items changed" and disables the displacement transition for
  // that render — a fresh array on every dragOver re-render would pin
  // `transition: transform 0s` on rows, undoing the eased glide.
  // Under the bottom anchor rows draw in reverse (index 0 lowest). dnd-kit's
  // vertical strategy needs items in on-screen order, so both the rendered
  // rows and the sortable items use this visual order.
  const visualSessions = useMemo(
    () => (isBottom ? [...displaySessions].reverse() : displaySessions),
    [displaySessions, isBottom]
  )
  const sortableItems = useMemo(
    () => visualSessions.map((s) => s.id),
    [visualSessions]
  )

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveId(event.active.id as string)
      setDragOrderSnapshot(filteredSessions.map((s) => s.id))
      lastNonActiveOverIdRef.current = null
    },
    [filteredSessions]
  )

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const id = (event.over?.id as string | null) ?? null
    setOverId(id)
    // closestCenter reports the dragged row as `over` when the pointer sits
    // over its rect. Remember the last real target row so a drop on that
    // frame still commits to the slot the displaced rows were showing.
    if (id && id !== event.active.id) {
      lastNonActiveOverIdRef.current = id
    }
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      setOverId(null)
      setDragOrderSnapshot(null)

      const overId =
        over && over.id !== active.id
          ? (over.id as string)
          : over?.id === active.id
            ? lastNonActiveOverIdRef.current
            : null
      lastNonActiveOverIdRef.current = null
      if (!overId) {
        return
      }

      // Indices come from the frozen order — the order the user actually saw
      // and aimed at — not the live order, which may have churned mid-drag.
      // They are looked up by id in the logical (unreversed) order: moving
      // `active` to `over`'s slot there is the same move as in the reversed
      // on-screen order, so the bottom anchor needs no translation.
      const oldIndex = displaySessions.findIndex((s) => s.id === active.id)
      const newIndex = displaySessions.findIndex((s) => s.id === overId)
      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      const reorderedVisible = displaySessions.map((s) => getSessionOrderKey(s))
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
    },
    [
      displaySessions,
      sortedSessions,
      sessionSortMode,
      setSessionSortMode,
      setManualSessionOrder,
    ]
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    setDragOrderSnapshot(null)
    lastNonActiveOverIdRef.current = null
  }, [])

  useEffect(() => {
    if (!activeId && !overId) return
    const currentIds = new Set(filteredSessions.map((s) => s.id))
    if (activeId && !currentIds.has(activeId)) {
      setActiveId(null)
      setDragOrderSnapshot(null)
    }
    if (overId && !currentIds.has(overId)) {
      setOverId(null)
    }
  }, [filteredSessions, activeId, overId])

  const handleRename = (sessionId: string, newName: string) => {
    onRename(sessionId, newName)
    setEditingSessionId(null)
  }

  const filterBar = (
    <div
      className={`sticky z-10 flex h-10 items-center gap-2 bg-elevated px-3 ${
        // shrink-0: under bottom the bar is a flex item of the scroll column
        isBottom ? 'bottom-0 shrink-0 border-t border-border' : 'top-0 border-b border-border'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <SessionFilterButton
          projects={uniqueProjects}
          selectedProjects={projectFilters}
          onSelectProjects={setProjectFilters}
          hosts={uniqueHosts}
          selectedHosts={hostFilters}
          onSelectHosts={setHostFilters}
          hostStatuses={hostStatuses}
          showHosts={showHostInfo}
          hasHiddenPermissions={hiddenPermissionCount > 0}
          placement={isBottom ? 'up' : 'down'}
        />
      </div>
      {filterBarControls}
    </div>
  )

  const displayPrefs = { showSessionIdPrefix, showProjectName, showLastUserMessage }

  const activeSection = loading ? (
    <div className="space-y-1 p-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded bg-surface"
        />
      ))}
    </div>
  ) : (
    <>
      <div className="flex items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted">
        <span>Active</span>
        <div className="flex items-center gap-2">
          {filteredSessions.length === 0 && onNewSession && (
            <button
              type="button"
              onClick={onNewSession}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-accent hover:bg-hover"
              title="Start a new session"
            >
              <PlusIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              New session
            </button>
          )}
          <motion.span
            className="w-8 text-right text-xs"
            animate={activeCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
            transition={{ duration: 0.3 }}
            onAnimationComplete={clearActiveCounterBump}
          >
            {filteredSessions.length}
          </motion.span>
        </div>
      </div>
      {filteredSessions.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={sortableItems}
            strategy={verticalListSortingStrategy}
          >
            <div key={filterKey}>
              {/* sync (not popLayout): without per-row layout animation,
                  popLayout would overlap an exiting row with the sibling
                  snapping into its place */}
              <AnimatePresence initial={false} mode="sync">
                {visualSessions.map((session, index) => {
                  const isTrulyNew = newlyActiveIds.has(session.id)
                  const isFilteredIn = newlyFilteredInIds.has(session.id)
                  const isRemote = session.remote === true
                  const isManaged = session.source === 'managed'
                  const canControl = !isRemote || (remoteAllowControl && isManaged)
                  const canHibernate = Boolean(
                    onHibernate &&
                    !isRemote &&
                    isManaged &&
                    session.agentSessionId?.trim()
                  )
                  // Drop indicator position, from on-screen (visual) indices
                  const activeIndex = activeId
                    ? visualSessions.findIndex((s) => s.id === activeId)
                    : -1
                  // Over the dragged row's own rect counts as the last
                  // real target — keeps the indicator from blinking off.
                  const effectiveOverId =
                    overId && overId !== activeId
                      ? overId
                      : overId === activeId
                        ? lastNonActiveOverIdRef.current
                        : null
                  const isOver = effectiveOverId === session.id
                  const showDropIndicator = isOver ? (activeIndex > index ? 'above' : 'below') : null
                  // Show bounce for both new and filter-in, but delay only for truly new.
                  // Suppressed mid-drag: a bounce would fight the dnd-kit displacement transform.
                  const isNew = (isTrulyNew || isFilteredIn) && !activeId
                  return (
                    <SortableSessionItem
                      key={session.id}
                      session={session}
                      isNew={isNew}
                      exitDuration={EXIT_DURATION}
                      prefersReducedMotion={prefersReducedMotion}
                      useSafariLayoutFallback={useSafariLayoutFallback}
                      isSelected={session.id === selectedSessionId}
                      isEditing={session.id === editingSessionId}
                      {...displayPrefs}
                      showHostInfo={showHostInfo}
                      dropIndicator={showDropIndicator}
                      onSelect={() => onSelect(session.id)}
                      onStartEdit={canControl ? () => setEditingSessionId(session.id) : undefined}
                      onCancelEdit={() => setEditingSessionId(null)}
                      onRename={(newName) => handleRename(session.id, newName)}
                      onHibernate={
                        canHibernate
                          ? () => onHibernate?.(session.agentSessionId!.trim())
                          : undefined
                      }
                      onKill={
                        onKill && canControl
                          ? () => onKill(session.id, 'session_list_context_menu')
                          : undefined
                      }
                      onDuplicate={onDuplicate && canControl ? () => onDuplicate(session.id) : undefined}
                    />
                  )
                })}
              </AnimatePresence>
            </div>
          </SortableContext>
        </DndContext>
      )}
    </>
  )

  const hibernatingSection = !loading && (
    <HibernatingSection
      anchor={anchor}
      sessions={filteredHibernatingSessions}
      selectedSessionId={selectedHibernatingSessionId}
      {...displayPrefs}
      onSelect={onSelectHibernating}
      onWake={onResume}
      onRename={handleRename}
      onMoveToHistory={onMoveToHistory}
    />
  )

  const historySection = (
    <HistorySection
      anchor={anchor}
      sessions={filteredHistorySessions}
      counterBump={historyCounterBump}
      onCounterBumpComplete={clearHistoryCounterBump}
      prefersReducedMotion={prefersReducedMotion}
      {...displayPrefs}
      onResume={onResume}
      onPreview={setPreviewSession}
    />
  )

  return (
    <aside className="flex min-h-0 flex-1 flex-col border-r border-border bg-elevated">
      {error && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {isBottom && notice && <div className="shrink-0">{notice}</div>}

      {isBottom ? (
        // Mirrored: rows stack from the bottom edge (mt-auto spacer, not
        // justify-end, which would make overflow unreachable); scroll-pb-10
        // keeps selected rows clear of the sticky bottom filter bar.
        <div
          ref={listScrollRef}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain scroll-pb-10"
        >
          <div ref={listContentRef} className="mt-auto shrink-0">
            {historySection}
            {hibernatingSection}
            {activeSection}
          </div>
          {filterBar}
        </div>
      ) : (
        // scroll-pt-10 keeps rows scrolled past the sticky h-10 filter bar
        <div
          ref={listScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain scroll-pt-10"
        >
          {filterBar}
          {notice}
          {activeSection}
          {hibernatingSection}
          {historySection}
        </div>
      )}

      {/* Keyboard shortcuts hint — shares the status rail's 40px bottom bar */}
      <div className="hidden h-10 shrink-0 items-center border-t border-border px-4 md:flex">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
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
  useSafariLayoutFallback: boolean
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
  onHibernate?: () => void
  onKill?: () => void
  onDuplicate?: () => void
}

const SortableSessionItem = forwardRef<HTMLDivElement, SortableSessionItemProps>(function SortableSessionItem({
  session,
  isNew,
  exitDuration,
  prefersReducedMotion,
  useSafariLayoutFallback,
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
  onHibernate,
  onKill,
  onDuplicate,
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

  // On coarse pointers the card body must keep native panning — with the
  // dnd-kit listeners on the whole row, Safari claims the gesture for
  // scrolling and pointercancel kills every touch drag. Move the activator
  // to a small touch-action:none handle instead.
  const coarsePointer = useIsMobileLayout('(pointer: coarse)')

  // Pin the drag transform to the vertical axis: a horizontally-tracking card
  // extends the scroller's scrollable overflow, which lets wheel flicks and
  // dnd-kit's edge auto-scroll drag the whole list sideways off the panel.
  const dndTransform = CSS.Transform.toString(
    transform ? { ...transform, x: 0 } : transform
  )
  const shouldApplyStyleTransform = Boolean(prefersReducedMotion && dndTransform)
  const style = {
    ...(shouldApplyStyleTransform ? { transform: dndTransform } : {}),
    // dnd-kit's transition only applies while sorting (or during the drop
    // settle) — the dragged node gets undefined so it tracks the pointer 1:1.
    // Without it, displaced siblings teleport instead of easing out of the way.
    ...(transition && !prefersReducedMotion ? { transition } : {}),
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
    // Deliberately no framer `layout` prop: animated resorts slide rows through
    // each other, overlapping two sessions' text mid-flight (#159). Rows snap to
    // their new position; drag previews still animate via the dnd-kit transform.
    <motion.div
      ref={setRefs}
      data-session-id={session.id}
      style={{ ...style, overflow: 'hidden' }}
      className="relative"
      transformTemplate={(_, generatedTransform) =>
        composeSortableTransform({
          useSafariLayoutFallback,
          isDragging,
          dndTransform,
          generatedTransform,
        })
      }
      initial={
        prefersReducedMotion || !isNew
          ? false
          : useSafariLayoutFallback
            ? { opacity: 0 }
            : { opacity: 0, scale: 0.97 }
      }
      animate={
        prefersReducedMotion
          ? { opacity: 1 }
          : isNew
            ? useSafariLayoutFallback
              ? { opacity: 1 }
              : { opacity: 1, scale: [1.02, 0.99, 1] }
            : { opacity: 1, scale: 1 }
      }
      exit={prefersReducedMotion
        ? { opacity: 0 }
        : useSafariLayoutFallback
          ? { opacity: 0, height: 0 }
          : { opacity: 0, height: 0, scale: 0.97 }}
      transition={
        prefersReducedMotion
          ? { duration: 0 }
          : useSafariLayoutFallback
            ? {
              opacity: { duration: exitDuration / 1000 },
              height: { duration: exitDuration / 1000, ease: 'easeOut' },
            }
            : {
              opacity: { duration: exitDuration / 1000 },
              scale: { duration: exitDuration / 1000, ease: [0.34, 1.56, 0.64, 1] },
              height: { duration: exitDuration / 1000, ease: 'easeOut' },
            }
      }
      {...attributes}
      {...(coarsePointer ? {} : listeners)}
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
        dragHandleListeners={coarsePointer ? listeners : undefined}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onRename={onRename}
        onHibernate={onHibernate}
        onKill={onKill}
        onDuplicate={onDuplicate}
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
  /** Present only on coarse pointers: the dnd-kit activator listeners move off
   * the card body onto the drag handle so the row can still pan natively. */
  dragHandleListeners?: NonNullable<ReturnType<typeof useSortable>['listeners']>
  onSelect: () => void
  onStartEdit?: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onHibernate?: () => void
  onKill?: () => void
  onDuplicate?: () => void
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
  dragHandleListeners,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onHibernate,
  onKill,
  onDuplicate,
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
  const contextMenuPosition = useMenuViewportFit(contextMenuRef, contextMenu)
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
    // A touch on the drag handle starts a dnd-kit drag — don't also arm the
    // long-press context menu under the same gesture.
    const touchTarget = e.target as HTMLElement | null
    if (
      typeof touchTarget?.closest === 'function' &&
      touchTarget.closest('[data-testid="drag-handle"]')
    )
      return
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
      className={`session-row group cursor-pointer select-none px-3 py-2 ${MOBILE_ROW_TARGET_CLASS} ${isSelected ? 'selected' : ''} ${isDragging ? 'cursor-grabbing shadow-lg ring-1 ring-accent/30 bg-elevated' : 'cursor-grab'}`}
      role="button"
      tabIndex={0}
      data-testid="session-card"
      data-session-id={session.id}
      onClick={isDragging ? undefined : onSelect}
      onKeyDown={(e) => {
        // Only the card's own keys select it. Keys aimed at nested controls
        // (PR chips, the "+N" strip and its portaled chips, the rename
        // input) bubble here too; selecting on them would start a terminal
        // attach whose focusAfterAttach then yanks focus out of that control.
        if (e.target !== e.currentTarget) return
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
          {dragHandleListeners ? (
            // On coarse pointers the icon doubles as the drag handle.
            // touch-action:none keeps the browser from claiming the pan for
            // scrolling, which would pointercancel the drag at activation;
            // the padding widens the hit target without growing the icon.
            <span
              {...dragHandleListeners}
              data-testid="drag-handle"
              aria-label="Drag to reorder"
              style={{ touchAction: 'none' }}
              className="-my-1 -ml-1 flex items-center py-1 pl-1 cursor-grab"
            >
              <AgentIcon
                agentType={session.agentType}
                command={session.command}
                className="h-3.5 w-3.5 shrink-0 text-muted"
              />
            </span>
          ) : (
            <AgentIcon
              agentType={session.agentType}
              command={session.command}
              className="h-3.5 w-3.5 shrink-0 text-muted"
            />
          )}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSubmit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              // Without this, dragging to select text inside the input arms
              // the row's dnd-kit PointerSensor on the wrapper.
              onPointerDown={(e) => e.stopPropagation()}
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
            <span
              className={`ml-1 flex shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 ${statusPillClass[session.status]} pulse-approval`}
              onAnimationEnd={handlePulseAnimationEnd}
            >
              <HandIcon width={ICON_SIZE.pill} height={ICON_SIZE.pill} aria-label="Needs input" />
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

        {/* Line 3: PR chips */}
        {session.prs && session.prs.length > 0 && (
          <PrChips prs={session.prs} />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1"
          style={contextMenuPosition ?? undefined}
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
              <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
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
              <Copy01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              Duplicate
            </button>
          )}
          {onHibernate && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onHibernate()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title="Close the live window and keep this session ready to wake"
            >
              <Moon01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              Hibernate
            </button>
          )}
          {session.logFilePath && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                if (session.logFilePath) {
                  copyText(session.logFilePath)
                }
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.logFilePath}
            >
              <File06Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
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
                <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
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
