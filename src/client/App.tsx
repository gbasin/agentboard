import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, ServerMessage, Session, SessionKillSource } from '@shared/types'
import Header from './components/Header'
import SessionList from './components/SessionList'
import Terminal from './components/Terminal'
import NewSessionModal from './components/NewSessionModal'
import SettingsModal from './components/SettingsModal'
import { ToastViewport } from './components/Toast'
import { useSessionStore } from './stores/sessionStore'
import {
  useSettingsStore,
  useSettingsHasHydrated,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './stores/settingsStore'
import { useThemeStore } from './stores/themeStore'
import { useWebSocket } from './hooks/useWebSocket'
import { invalidateSnapshotCache } from './hooks/useTerminal'
import { useVisualViewport } from './hooks/useVisualViewport'
import { sortSessions } from './utils/sessions'
import { flushSync } from 'react-dom'
import { setClientLogLevel } from './utils/clientLog'
import { getEffectiveModifier, matchesModifier } from './utils/device'
import { playPermissionSound, playIdleSound, primeAudio, needsUserGesture } from './utils/sound'

interface ServerInfo {
  port: number
  tailscaleIp: string | null
  protocol: string
}

function filterAgentSessions(
  sessions: AgentSession[],
  projectFilters: string[],
  hostFilters: string[]
) {
  let next = sessions
  if (projectFilters.length > 0) {
    next = next.filter((session) => projectFilters.includes(session.projectPath))
  }
  if (hostFilters.length > 0) {
    next = next.filter((session) => hostFilters.includes(session.host ?? ''))
  }
  return next
}

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [newSessionInitialHost, setNewSessionInitialHost] = useState<string | undefined>(undefined)
  const [newSessionInitialPath, setNewSessionInitialPath] = useState<string | undefined>(undefined)
  const [newSessionInitialCommand, setNewSessionInitialCommand] = useState<string | undefined>(undefined)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [pendingHibernatingSession, setPendingHibernatingSession] =
    useState<AgentSession | null>(null)

  const sessions = useSessionStore((state) => state.sessions)
  const agentSessions = useSessionStore((state) => state.agentSessions)
  const agentSessionsEpoch = useSessionStore((state) => state.agentSessionsEpoch)
  const selectedSessionId = useSessionStore(
    (state) => state.selectedSessionId
  )
  const selectedHibernatingSessionId = useSessionStore(
    (state) => state.selectedHibernatingSessionId
  )
  const setSessions = useSessionStore((state) => state.setSessions)
  const setAgentSessions = useSessionStore((state) => state.setAgentSessions)
  const setActiveAgentSessions = useSessionStore(
    (state) => state.setActiveAgentSessions
  )
  const setHostStatuses = useSessionStore((state) => state.setHostStatuses)
  const updateSession = useSessionStore((state) => state.updateSession)
  const setSelectedSessionId = useSessionStore(
    (state) => state.setSelectedSessionId
  )
  const setSelectedHibernatingSessionId = useSessionStore(
    (state) => state.setSelectedHibernatingSessionId
  )
  const hasLoaded = useSessionStore((state) => state.hasLoaded)
  const connectionStatus = useSessionStore(
    (state) => state.connectionStatus
  )
  const connectionError = useSessionStore((state) => state.connectionError)
  const clearExitingSession = useSessionStore((state) => state.clearExitingSession)
  const markSessionExiting = useSessionStore((state) => state.markSessionExiting)
  const setRemoteAllowControl = useSessionStore((state) => state.setRemoteAllowControl)
  const setRemoteAllowAttach = useSessionStore((state) => state.setRemoteAllowAttach)
  const setHostLabel = useSessionStore((state) => state.setHostLabel)
  const hostStatuses = useSessionStore((state) => state.hostStatuses)
  const remoteAllowControl = useSessionStore((state) => state.remoteAllowControl)
  const hostLabel = useSessionStore((state) => state.hostLabel)

  const theme = useThemeStore((state) => state.theme)
  const settingsHydrated = useSettingsHasHydrated()
  const defaultProjectDir = useSettingsStore(
    (state) => state.defaultProjectDir
  )
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const lastProjectPath = useSettingsStore((state) => state.lastProjectPath)
  const setLastProjectPath = useSettingsStore(
    (state) => state.setLastProjectPath
  )
  const addRecentPath = useSettingsStore((state) => state.addRecentPath)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth)
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth)
  const projectFilters = useSettingsStore((state) => state.projectFilters)
  const hostFilters = useSettingsStore((state) => state.hostFilters)
  const soundOnPermission = useSettingsStore((state) => state.soundOnPermission)
  const soundOnIdle = useSettingsStore((state) => state.soundOnIdle)

  const connectionEpoch = useSessionStore((state) => state.connectionEpoch)
  const { sendMessage, subscribe, getConnectionEpoch } = useWebSocket()

  // Handle mobile keyboard viewport adjustments
  useVisualViewport()

  // Prime audio on user interaction. Persistent listener (not once) because Safari
  // suspends AudioContext after sleep/wake and needs a fresh gesture to resume.
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!soundOnPermission && !soundOnIdle) return

    let primed = false
    const unlockAudio = () => {
      // After initial prime, only re-prime when wake detection flags it
      if (primed && !needsUserGesture()) return
      primed = true
      void primeAudio()
    }

    document.addEventListener('click', unlockAudio, { passive: true })
    document.addEventListener('keydown', unlockAudio, { passive: true })
    document.addEventListener('touchstart', unlockAudio, { passive: true })

    return () => {
      document.removeEventListener('click', unlockAudio)
      document.removeEventListener('keydown', unlockAudio)
      document.removeEventListener('touchstart', unlockAudio)
    }
  }, [soundOnPermission, soundOnIdle])

  // Sidebar resize handling
  const isResizing = useRef(false)
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    // Guard for SSR/test environments where document.addEventListener may not exist
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = e.clientX
      setSidebarWidth(
        Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, newWidth))
      )
    }

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setSidebarWidth])

  useEffect(() => {
    const unsubscribe = subscribe((message: ServerMessage) => {
      if (message.type === 'sessions') {
        // Detect status transitions for sound notifications before updating
        const currentSessions = useSessionStore.getState().sessions
        const { soundOnPermission, soundOnIdle } = useSettingsStore.getState()

        if (soundOnPermission || soundOnIdle) {
          for (const nextSession of message.sessions) {
            const prevSession = currentSessions.find((s) => s.id === nextSession.id)
            if (prevSession && prevSession.status !== nextSession.status) {
              if (prevSession.status !== 'permission' && nextSession.status === 'permission' && soundOnPermission) {
                void playPermissionSound()
              }
              if (prevSession.status === 'working' && nextSession.status === 'waiting' && soundOnIdle) {
                void playIdleSound()
              }
            }
          }
        }

        // Discard pending kills from a previous connection — the first
        // snapshot after reconnect is authoritative.  Uses getConnectionEpoch()
        // (reads manager directly) instead of a render-dependent ref so the
        // check is correct even if this message arrives before React re-renders.
        if (pendingKills.current.size > 0) {
          const currentEpoch = getConnectionEpoch()
          for (const [id, entry] of pendingKills.current) {
            if (entry.epoch !== currentEpoch) {
              pendingKills.current.delete(id)
            }
          }
        }

        // Filter out sessions with pending kills so stale refresh snapshots
        // don't re-add optimistically removed sessions (causes multi-second
        // delay before the session card finally disappears).
        // Note: we intentionally do NOT clear pendingKills here — only
        // kill-failed clears entries (for rollback).  Entries persist until
        // reconnect (epoch mismatch) so stale async refreshes can't
        // resurrect the killed session even after session-removed arrives.
        const nextSessions = pendingKills.current.size > 0
          ? message.sessions.filter((session) => !pendingKills.current.has(session.id))
          : message.sessions

        const {
          selectedSessionId: previousSelectedSessionId,
          selectedHibernatingSessionId: previousSelectedHibernatingSessionId,
        } = useSessionStore.getState()
        const removedSelectedAgentSessionId =
          previousSelectedSessionId !== null &&
          previousSelectedHibernatingSessionId === null &&
          !nextSessions.some((session) => session.id === previousSelectedSessionId)
            ? currentSessions.find((session) => session.id === previousSelectedSessionId)?.agentSessionId?.trim() ?? null
            : null

        if (removedSelectedAgentSessionId) {
          // Another client hibernates the live session before the hibernating bucket updates.
          pendingHibernateSelectionRef.current = removedSelectedAgentSessionId
        }

        setSessions(nextSessions)

        const pendingWakeSelectionId = pendingWakeSelectionRef.current
        const {
          selectedSessionId: currentSelectedSessionId,
          selectedHibernatingSessionId: currentSelectedHibernatingSessionId,
        } = useSessionStore.getState()
        const { projectFilters, hostFilters } = useSettingsStore.getState()
        if (
          pendingWakeSelectionId &&
          currentSelectedSessionId === null &&
          currentSelectedHibernatingSessionId === null
        ) {
          const matchingSession = nextSessions.find((session) => {
            if (session.agentSessionId?.trim() !== pendingWakeSelectionId) {
              return false
            }
            if (
              projectFilters.length > 0 &&
              !projectFilters.includes(session.projectPath)
            ) {
              return false
            }
            if (
              hostFilters.length > 0 &&
              !hostFilters.includes(session.host ?? '')
            ) {
              return false
            }
            return true
          })
          if (matchingSession) {
            pendingWakeSelectionRef.current = null
            setSelectedSessionId(matchingSession.id)
          }
        }
      }
      if (message.type === 'host-status') {
        setHostStatuses(message.hosts)
      }
      if (message.type === 'server-config') {
        setRemoteAllowControl(message.remoteAllowControl)
        setRemoteAllowAttach(message.remoteAllowAttach)
        setHostLabel(message.hostLabel)
        if (message.clientLogLevel) {
          setClientLogLevel(message.clientLogLevel)
        }
      }
      if (message.type === 'session-update') {
        // Detect status transitions for sound notifications
        // Capture previous status BEFORE updating to ensure we have the old value
        const currentSessions = useSessionStore.getState().sessions
        const prevSession = currentSessions.find((s) => s.id === message.session.id)
        const prevStatus = prevSession?.status
        const nextStatus = message.session.status

        updateSession(message.session)

        // Only play sounds for known sessions (skip new/unknown sessions)
        if (prevStatus) {
          const { soundOnPermission, soundOnIdle } = useSettingsStore.getState()

          if (prevStatus !== 'permission' && nextStatus === 'permission' && soundOnPermission) {
            void playPermissionSound()
          }
          if (prevStatus === 'working' && nextStatus === 'waiting' && soundOnIdle) {
            void playIdleSound()
          }
        }
      }
      if (message.type === 'session-created') {
        // Add session to list immediately (don't wait for async refresh)
        const currentSessions = useSessionStore.getState().sessions
        if (!currentSessions.some((s) => s.id === message.session.id)) {
          setSessions([message.session, ...currentSessions])
        }
        setSelectedSessionId(message.session.id)
        addRecentPath(message.session.projectPath)

        // Auto-add to filter if filters are active and project isn't included
        const { projectFilters, setProjectFilters } = useSettingsStore.getState()
        if (projectFilters.length > 0 && !projectFilters.includes(message.session.projectPath)) {
          setProjectFilters([...projectFilters, message.session.projectPath])
        }
      }
      if (message.type === 'session-removed') {
        // Do NOT clear pendingKills here — stale async refreshes (e.g. the
        // periodic 2s refresh) can arrive AFTER session-removed and re-add
        // the killed window if the tmux process hasn't fully exited yet.
        // Keeping the entry in pendingKills filters
        // those stale broadcasts.  Cleanup happens on reconnect (epoch mismatch)
        // or kill-failed (rollback).
        invalidateSnapshotCache(message.sessionId)
        const currentSessions = useSessionStore.getState().sessions
        const nextSessions = currentSessions.filter(
          (session) => session.id !== message.sessionId
        )
        if (nextSessions.length !== currentSessions.length) {
          setSessions(nextSessions)
        }
      }
      if (message.type === 'agent-sessions') {
        const active = Array.isArray(message.active) ? message.active : []
        const hibernating = Array.isArray(message.hibernating) ? message.hibernating : []
        const history = Array.isArray(message.history) ? message.history : []
        const { selectedHibernatingSessionId: currentSelectedHibernatingSessionId } =
          useSessionStore.getState()
        const pendingHibernateSelectionId = pendingHibernateSelectionRef.current
        if (
          currentSelectedHibernatingSessionId &&
          !hibernating.some(
            (session) => session.sessionId === currentSelectedHibernatingSessionId
          )
        ) {
          pendingWakeSelectionRef.current = currentSelectedHibernatingSessionId
        }
        setAgentSessions(active, hibernating, history)
        setPendingHibernatingSession((current) =>
          current &&
          hibernating.some((session) => session.sessionId === current.sessionId)
            ? null
            : current
        )
        if (
          pendingHibernateSelectionId &&
          hibernating.some((session) => session.sessionId === pendingHibernateSelectionId)
        ) {
          pendingHibernateSelectionRef.current = null
          setSelectedHibernatingSessionId(pendingHibernateSelectionId)
        } else if (pendingHibernateSelectionId) {
          pendingHibernateSelectionRef.current = null
        }
      }
      if (message.type === 'agent-sessions-active') {
        setActiveAgentSessions(Array.isArray(message.active) ? message.active : [])
      }
      if (message.type === 'session-orphaned') {
        // When a session is superseded by slug (plan→execute transition),
        // don't remove the card — session-activated will update it in place.
        if (!message.supersededBy) {
          const currentSessions = useSessionStore.getState().sessions
          const nextSessions = currentSessions.filter(
            (session) => session.agentSessionId?.trim() !== message.session.sessionId
          )
          if (nextSessions.length !== currentSessions.length) {
            setSessions(nextSessions)
          }
        }
      }
      if (message.type === 'session-activated') {
        // Update the session card's agent metadata in place (e.g., after slug supersede
        // or orphan rematch). Merges onto existing card — no-op if no card matches.
        const existing = useSessionStore.getState().sessions.find(
          (s) => s.tmuxWindow === message.window
        )
        if (existing) {
          updateSession({
            ...existing,
            agentSessionId: message.session.sessionId,
            agentSessionName: message.session.displayName,
            logFilePath: message.session.logFilePath,
            isPinned: message.session.isPinned,
            lastUserMessage: message.session.lastUserMessage ?? existing.lastUserMessage,
          })
        }
      }
      if (message.type === 'session-wake-result') {
        if (message.ok && message.session) {
          setPendingHibernatingSession((current) =>
            current?.sessionId === message.sessionId ? null : current
          )
          // Add woken session to list immediately
          const currentSessions = useSessionStore.getState().sessions
          if (!currentSessions.some((s) => s.id === message.session!.id)) {
            setSessions([message.session, ...currentSessions])
          }
          setSelectedSessionId(message.session.id)
        } else if (!message.ok) {
          setServerError(`${message.error?.code}: ${message.error?.message}`)
          window.setTimeout(() => setServerError(null), 6000)
        }
      }
      if (message.type === 'session-hibernate-result') {
        if (message.ok) {
          if (message.session) {
            setPendingHibernatingSession(message.session)
          }
          setSelectedHibernatingSessionId(message.sessionId)
        } else {
          setServerError(message.error ?? 'Failed to hibernate session')
          window.setTimeout(() => setServerError(null), 6000)
        }
      }
      if (message.type === 'terminal-error') {
        if (!message.sessionId || message.sessionId === selectedSessionId) {
          setServerError(`${message.code}: ${message.message}`)
          window.setTimeout(() => setServerError(null), 6000)
        }
      }
      if (message.type === 'terminal-ready') {
        if (message.sessionId === selectedSessionId) {
          setServerError(null)
        }
      }
      if (message.type === 'error') {
        setServerError(message.message)
        window.setTimeout(() => setServerError(null), 6000)
      }
      if (message.type === 'kill-failed') {
        // Restore optimistically removed session from pending-kill snapshot
        // (not exitingSessions, which may have been cleared by animation timer)
        const pending = pendingKills.current.get(message.sessionId)
        if (pending) {
          const currentSessions = useSessionStore.getState().sessions
          // Guard: a `sessions` broadcast may have re-added the session already
          if (!currentSessions.some(s => s.id === message.sessionId)) {
            setSessions([pending.session, ...currentSessions])
          }
          if (pending.wasSelected) {
            setSelectedSessionId(message.sessionId)
          }
          pendingKills.current.delete(message.sessionId)
        }
        clearExitingSession(message.sessionId)
        setServerError(message.message)
        window.setTimeout(() => setServerError(null), 6000)
      }
      if (message.type === 'session-move-to-history-result') {
        if (!message.ok && message.error) {
          setServerError(message.error)
          window.setTimeout(() => setServerError(null), 6000)
        }
      }
    })

    return () => { unsubscribe() }
  }, [
    selectedSessionId,
    selectedHibernatingSessionId,
    addRecentPath,
    clearExitingSession,
    sendMessage,
    setSelectedSessionId,
    setSelectedHibernatingSessionId,
    setPendingHibernatingSession,
    setSessions,
    setAgentSessions,
    setActiveAgentSessions,
    setHostStatuses,
    setRemoteAllowControl,
    setRemoteAllowAttach,
    setHostLabel,
    subscribe,
    updateSession,
  ])

  const selectedSession = useMemo(() => {
    return (
      sessions.find((session) => session.id === selectedSessionId) || null
    )
  }, [selectedSessionId, sessions])
  const hibernatingAgentSessions = agentSessions.hibernating ?? []
  const historyAgentSessions = agentSessions.history ?? []
  const filteredHibernatingSessions = useMemo(
    () => filterAgentSessions(hibernatingAgentSessions, projectFilters, hostFilters),
    [hibernatingAgentSessions, projectFilters, hostFilters]
  )
  const selectedHibernatingSession = useMemo(() => {
    return (
      filteredHibernatingSessions.find(
        (session) => session.sessionId === selectedHibernatingSessionId
      ) ||
      (pendingHibernatingSession?.sessionId === selectedHibernatingSessionId
        ? pendingHibernatingSession
        : null)
    )
  }, [
    filteredHibernatingSessions,
    pendingHibernatingSession,
    selectedHibernatingSessionId,
  ])

  // Track last viewed project path
  useEffect(() => {
    if (selectedSession?.projectPath && !selectedSession.remote) {
      setLastProjectPath(selectedSession.projectPath)
    }
  }, [selectedSession?.projectPath, selectedSession?.remote, setLastProjectPath])

  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const manualSessionOrder = useSettingsStore(
    (state) => state.manualSessionOrder
  )

  const sortedSessions = useMemo(
    () =>
      sortSessions(sessions, {
        mode: sessionSortMode,
        direction: sessionSortDirection,
        manualOrder: manualSessionOrder,
      }),
    [sessions, sessionSortMode, sessionSortDirection, manualSessionOrder]
  )

  // Apply filters to sorted sessions for keyboard navigation
  const filteredSortedSessions = useMemo(() => {
    let next = sortedSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [sortedSessions, projectFilters, hostFilters])

  const lastSelectedHibernatingSessionIdRef = useRef<string | null>(
    selectedHibernatingSessionId
  )
  const pendingHibernateSelectionRef = useRef<string | null>(null)
  const pendingWakeSelectionRef = useRef<string | null>(null)
  const lastConnectionEpochRef = useRef(connectionEpoch)

  const selectFirstVisibleTarget = useCallback(() => {
    if (filteredSortedSessions.length > 0) {
      setSelectedSessionId(filteredSortedSessions[0].id)
      return true
    }
    if (filteredHibernatingSessions.length > 0) {
      setSelectedHibernatingSessionId(filteredHibernatingSessions[0].sessionId)
      return true
    }
    return false
  }, [
    filteredSortedSessions,
    filteredHibernatingSessions,
    setSelectedSessionId,
    setSelectedHibernatingSessionId,
  ])

  useEffect(() => {
    const previousHibernatingSelectionId = lastSelectedHibernatingSessionIdRef.current

    if (
      previousHibernatingSelectionId &&
      selectedHibernatingSessionId === null &&
      !hibernatingAgentSessions.some(
        (session) => session.sessionId === previousHibernatingSelectionId
      )
    ) {
      pendingWakeSelectionRef.current = previousHibernatingSelectionId
    } else if (selectedHibernatingSessionId !== null) {
      pendingWakeSelectionRef.current = null
    }

    lastSelectedHibernatingSessionIdRef.current = selectedHibernatingSessionId
  }, [hibernatingAgentSessions, selectedHibernatingSessionId])

  useEffect(() => {
    if (!pendingHibernatingSession) return
    if (selectedHibernatingSessionId === pendingHibernatingSession.sessionId) return
    setPendingHibernatingSession(null)
  }, [pendingHibernatingSession, selectedHibernatingSessionId])

  useEffect(() => {
    if (lastConnectionEpochRef.current === connectionEpoch) {
      return
    }

    lastConnectionEpochRef.current = connectionEpoch
    pendingHibernateSelectionRef.current = null
    pendingWakeSelectionRef.current = null
    setPendingHibernatingSession(null)
  }, [connectionEpoch])

  // Auto-select first visible session when current selection is filtered out
  useEffect(() => {
    if (!hasLoaded) return
    if (selectedHibernatingSessionId) return
    if (!selectedSessionId) return
    if (filteredSortedSessions.some((session) => session.id === selectedSessionId)) {
      return
    }
    if (selectFirstVisibleTarget()) return
    setSelectedSessionId(null)
  }, [
    hasLoaded,
    selectedSessionId,
    selectedHibernatingSessionId,
    selectFirstVisibleTarget,
    setSelectedSessionId,
  ])

  useEffect(() => {
    if (!selectedHibernatingSessionId) return
    if (pendingHibernatingSession?.sessionId === selectedHibernatingSessionId) {
      return
    }
    if (agentSessionsEpoch !== connectionEpoch) {
      return
    }
    if (
      filteredHibernatingSessions.some(
        (session) => session.sessionId === selectedHibernatingSessionId
      )
    ) {
      return
    }

    const matchingLiveSession = filteredSortedSessions.find(
      (session) => session.agentSessionId?.trim() === selectedHibernatingSessionId
    )
    if (matchingLiveSession) {
      setSelectedSessionId(matchingLiveSession.id)
      return
    }

    if (selectFirstVisibleTarget()) return
    setSelectedHibernatingSessionId(null)
  }, [
    filteredHibernatingSessions,
    filteredSortedSessions,
    agentSessionsEpoch,
    pendingHibernatingSession,
    selectedHibernatingSessionId,
    selectFirstVisibleTarget,
    setSelectedSessionId,
    setSelectedHibernatingSessionId,
    connectionEpoch,
  ])

  useEffect(() => {
    const pendingWakeSelectionId = pendingWakeSelectionRef.current
    if (!pendingWakeSelectionId) return
    if (selectedHibernatingSessionId !== null) {
      pendingWakeSelectionRef.current = null
      return
    }

    const matchingLiveSession = filteredSortedSessions.find(
      (session) => session.agentSessionId?.trim() === pendingWakeSelectionId
    )
    if (matchingLiveSession) {
      pendingWakeSelectionRef.current = null
      setSelectedSessionId(matchingLiveSession.id)
      return
    }

    if (selectedSessionId !== null) {
      pendingWakeSelectionRef.current = null
      return
    }

    if (selectFirstVisibleTarget()) {
      pendingWakeSelectionRef.current = null
    }
  }, [
    filteredSortedSessions,
    selectedSessionId,
    selectedHibernatingSessionId,
    selectFirstVisibleTarget,
    setSelectedSessionId,
  ])

  // Auto-select first session on mobile when sessions load
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches
    if (
      isMobile &&
      hasLoaded &&
      selectedSessionId === null &&
      selectedHibernatingSessionId === null &&
      (filteredSortedSessions.length > 0 || filteredHibernatingSessions.length > 0)
    ) {
      selectFirstVisibleTarget()
    }
  }, [
    filteredHibernatingSessions.length,
    filteredSortedSessions.length,
    hasLoaded,
    selectFirstVisibleTarget,
    selectedSessionId,
    selectedHibernatingSessionId,
  ])

  // Pending kills: snapshot + selection state for rollback on kill-failed.
  // Separate from exitingSessions (which gets cleaned up by animation timers).
  // Each entry stores the connectionEpoch at which the kill was issued so stale
  // entries from a previous connection can be discarded on reconnect.
  const pendingKills = useRef<Map<string, { session: Session; wasSelected: boolean; epoch: number }>>(new Map())

  const handleKillSession = useCallback((
    sessionId: string,
    source: SessionKillSource = 'unknown',
  ) => {
    invalidateSnapshotCache(sessionId)
    // Snapshot session and selection state before removal for kill-failed rollback
    const { sessions: currentSessions, selectedSessionId: currentSelected } = useSessionStore.getState()
    const session = currentSessions.find(s => s.id === sessionId)
    if (session) {
      pendingKills.current.set(sessionId, {
        session,
        wasSelected: currentSelected === sessionId,
        epoch: getConnectionEpoch(),
      })
    }
    // Force synchronous DOM update so the session card disappears immediately,
    // even if the browser's main thread is busy with WebSocket messages or
    // xterm.js rendering. Without flushSync, React 18 may defer the paint.
    flushSync(() => {
      markSessionExiting(sessionId)
      setSessions(currentSessions.filter(s => s.id !== sessionId))
    })
    sendMessage({ type: 'session-kill', sessionId, source })
  }, [markSessionExiting, setSessions, sendMessage])

  useEffect(() => {
    const effectiveModifier = getEffectiveModifier(shortcutModifier)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      // Use event.code for consistent detection across browsers
      // (event.key fails in Chrome/Arc on macOS due to Option dead keys)
      const code = event.code
      const isShortcut = matchesModifier(event, effectiveModifier)

      // Bracket navigation: [mod]+[ / ]
      // When only hibernating sessions are visible, fall back to navigating
      // within the hibernating bucket so the keyboard shortcut keeps working.
      if (isShortcut && (code === 'BracketLeft' || code === 'BracketRight')) {
        event.preventDefault()
        const delta = code === 'BracketLeft' ? -1 : 1
        const activeNav = filteredSortedSessions
        if (activeNav.length === 0) {
          const hibernatingNav = filteredHibernatingSessions
          if (hibernatingNav.length === 0) return
          const currentIndex = hibernatingNav.findIndex(
            s => s.sessionId === selectedHibernatingSessionId
          )
          if (currentIndex === -1) {
            setSelectedHibernatingSessionId(hibernatingNav[0].sessionId)
            return
          }
          const newIndex =
            (currentIndex + delta + hibernatingNav.length) % hibernatingNav.length
          setSelectedHibernatingSessionId(hibernatingNav[newIndex].sessionId)
          return
        }
        const currentIndex = activeNav.findIndex(s => s.id === selectedSessionId)
        if (currentIndex === -1) {
          setSelectedSessionId(activeNav[0].id)
          return
        }
        const newIndex = (currentIndex + delta + activeNav.length) % activeNav.length
        setSelectedSessionId(activeNav[newIndex].id)
        return
      }

      // New session: [mod]+N
      if (isShortcut && code === 'KeyN') {
        event.preventDefault()
        if (!isModalOpen && settingsHydrated) {
          setIsModalOpen(true)
        }
        return
      }

      // Kill session: [mod]+X
      if (isShortcut && code === 'KeyX') {
        event.preventDefault()
        if (selectedSessionId && !isModalOpen) {
          handleKillSession(selectedSessionId, 'keyboard_shortcut')
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    isModalOpen,
    selectedSessionId,
    selectedHibernatingSessionId,
    setSelectedSessionId,
    setSelectedHibernatingSessionId,
    filteredSortedSessions,
    filteredHibernatingSessions,
    handleKillSession,
    shortcutModifier,
    settingsHydrated,
  ])

  const handleNewSession = (): boolean => {
    if (!settingsHydrated) return false
    setNewSessionInitialHost(undefined)
    setNewSessionInitialPath(undefined)
    setNewSessionInitialCommand(undefined)
    setIsModalOpen(true)
    return true
  }
  const handleOpenSettings = () => setIsSettingsOpen(true)

  const handleCreateSession = (
    projectPath: string,
    name?: string,
    command?: string,
    host?: string
  ) => {
    sendMessage({ type: 'session-create', projectPath, name, command, host })
    if (!host) setLastProjectPath(projectPath)
  }

  const handleResumeSession = (sessionId: string) => {
    sendMessage({ type: 'session-wake', sessionId })
  }

  const handleHibernateSession = useCallback((sessionId: string) => {
    sendMessage({ type: 'session-hibernate', sessionId })
  }, [sendMessage])

  const handleRenameSession = (sessionId: string, newName: string) => {
    sendMessage({ type: 'session-rename', sessionId, newName })
  }

  const handleDuplicateSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return
    sendMessage({
      type: 'session-create',
      projectPath: session.projectPath,
      command: session.command || undefined,
      host: session.remote && session.host ? session.host : undefined,
    })
  }, [sessions, sendMessage])

  const handleMoveToHistory = useCallback((sessionId: string) => {
    sendMessage({ type: 'session-move-to-history', sessionId })
  }, [sendMessage])

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Fetch server info (including Tailscale IP) on mount
  useEffect(() => {
    fetch('/api/server-info')
      .then((res) => res.json())
      .then((info: ServerInfo) => setServerInfo(info))
      .catch(() => {})
  }, [])

  const remoteHostStatuses = useMemo(() => {
    if (!hostLabel) return hostStatuses
    return hostStatuses.filter((hostStatus) => hostStatus.host !== hostLabel)
  }, [hostStatuses, hostLabel])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left column: header + sidebar - always hidden on mobile (drawer handles it) */}
      <div
        className="hidden h-full flex-col md:flex md:shrink-0"
        style={{ width: sidebarWidth }}
      >
        <Header
          connectionStatus={connectionStatus}
          onNewSession={handleNewSession}
          onOpenSettings={handleOpenSettings}
          tailscaleIp={serverInfo?.tailscaleIp ?? null}
        />
        <SessionList
          sessions={sessions}
          hibernatingSessions={hibernatingAgentSessions}
          historySessions={historyAgentSessions}
          selectedSessionId={selectedSessionId}
          selectedHibernatingSessionId={selectedHibernatingSessionId}
          onSelect={setSelectedSessionId}
          onSelectHibernating={setSelectedHibernatingSessionId}
          onRename={handleRenameSession}
          onResume={handleResumeSession}
          onHibernate={handleHibernateSession}
          onKill={handleKillSession}
          onDuplicate={handleDuplicateSession}
          onMoveToHistory={handleMoveToHistory}
          onNewSession={handleNewSession}
          loading={!hasLoaded}
          error={connectionError || serverError}
        />
      </div>

      {/* Sidebar resize handle */}
      <div
        className="hidden md:block w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-white/10 active:bg-white/20"
        onMouseDown={handleResizeStart}
      />

      {/* Terminal - full height on desktop */}
      <Terminal
        session={selectedSession}
        sessions={filteredSortedSessions}
        hibernatingSession={selectedHibernatingSession}
        hibernatingSessions={hibernatingAgentSessions}
        connectionStatus={connectionStatus}
        connectionEpoch={connectionEpoch}
        sendMessage={sendMessage}
        subscribe={subscribe}
        onClose={() => setSelectedSessionId(null)}
        onSelectSession={setSelectedSessionId}
        onSelectHibernatingSession={setSelectedHibernatingSessionId}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onRenameSession={handleRenameSession}
        onOpenSettings={handleOpenSettings}
        onResumeSession={handleResumeSession}
        onHibernateSession={handleHibernateSession}
        onMoveToHistory={handleMoveToHistory}
        historySessions={historyAgentSessions}
        loading={!hasLoaded}
        error={connectionError || serverError}
      />

      <NewSessionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateSession}
        defaultProjectDir={defaultProjectDir}
        commandPresets={commandPresets}
        defaultPresetId={defaultPresetId}
        lastProjectPath={lastProjectPath}
        activeProjectPath={selectedSession && !selectedSession.remote ? selectedSession.projectPath : undefined}
        remoteHosts={remoteHostStatuses}
        remoteAllowControl={remoteAllowControl}
        initialHost={newSessionInitialHost}
        initialPath={newSessionInitialPath}
        initialCommand={newSessionInitialCommand}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      <ToastViewport />
    </div>
  )
}
