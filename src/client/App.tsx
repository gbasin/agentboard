import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ServerMessage } from '@shared/types'
import Header from './components/Header'
import SessionList from './components/SessionList'
import Terminal from './components/Terminal'
import NewSessionModal from './components/NewSessionModal'
import SettingsModal from './components/SettingsModal'
import { useSessionStore } from './stores/sessionStore'
import {
  useSettingsStore,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './stores/settingsStore'
import { useThemeStore } from './stores/themeStore'
import { useWebSocket } from './hooks/useWebSocket'
import { useVisualViewport } from './hooks/useVisualViewport'
import { sortSessions } from './utils/sessions'
import { getEffectiveModifier, matchesModifier } from './utils/device'

interface ServerInfo {
  port: number
  tailscaleIp: string | null
  protocol: string
}

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)

  const sessions = useSessionStore((state) => state.sessions)
  const agentSessions = useSessionStore((state) => state.agentSessions)
  const selectedSessionId = useSessionStore(
    (state) => state.selectedSessionId
  )
  const setSessions = useSessionStore((state) => state.setSessions)
  const setAgentSessions = useSessionStore((state) => state.setAgentSessions)
  const updateSession = useSessionStore((state) => state.updateSession)
  const setSelectedSessionId = useSessionStore(
    (state) => state.setSelectedSessionId
  )
  const hasLoaded = useSessionStore((state) => state.hasLoaded)
  const connectionStatus = useSessionStore(
    (state) => state.connectionStatus
  )
  const connectionError = useSessionStore((state) => state.connectionError)
  const clearExitingSession = useSessionStore((state) => state.clearExitingSession)

  const theme = useThemeStore((state) => state.theme)
  const defaultProjectDir = useSettingsStore(
    (state) => state.defaultProjectDir
  )
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const updatePresetModifiers = useSettingsStore(
    (state) => state.updatePresetModifiers
  )
  const lastProjectPath = useSettingsStore((state) => state.lastProjectPath)
  const setLastProjectPath = useSettingsStore(
    (state) => state.setLastProjectPath
  )
  const addRecentPath = useSettingsStore((state) => state.addRecentPath)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth)
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth)

  const { sendMessage, subscribe } = useWebSocket()

  // Handle mobile keyboard viewport adjustments
  useVisualViewport()

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
        setSessions(message.sessions)
      }
      if (message.type === 'session-update') {
        updateSession(message.session)
      }
      if (message.type === 'session-created') {
        // Add session to list immediately (don't wait for async refresh)
        const currentSessions = useSessionStore.getState().sessions
        if (!currentSessions.some((s) => s.id === message.session.id)) {
          setSessions([message.session, ...currentSessions])
        }
        setSelectedSessionId(message.session.id)
        addRecentPath(message.session.projectPath)
      }
      if (message.type === 'session-removed') {
        const currentSessions = useSessionStore.getState().sessions
        const nextSessions = currentSessions.filter(
          (session) => session.id !== message.sessionId
        )
        if (nextSessions.length !== currentSessions.length) {
          setSessions(nextSessions)
        }
      }
      if (message.type === 'agent-sessions') {
        setAgentSessions(message.active, message.inactive)
      }
      if (message.type === 'session-orphaned') {
        const currentSessions = useSessionStore.getState().sessions
        const nextSessions = currentSessions.filter(
          (session) => session.agentSessionId?.trim() !== message.session.sessionId
        )
        if (nextSessions.length !== currentSessions.length) {
          setSessions(nextSessions)
        }
      }
      if (message.type === 'session-resume-result') {
        if (message.ok && message.session) {
          // Add resumed session to list immediately
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
        // Clear from exiting state since kill failed - session remains active
        clearExitingSession(message.sessionId)
        setServerError(message.message)
        window.setTimeout(() => setServerError(null), 6000)
      }
    })

    return () => { unsubscribe() }
  }, [
    selectedSessionId,
    addRecentPath,
    clearExitingSession,
    sendMessage,
    setSelectedSessionId,
    setSessions,
    setAgentSessions,
    subscribe,
    updateSession,
  ])

  const selectedSession = useMemo(() => {
    return (
      sessions.find((session) => session.id === selectedSessionId) || null
    )
  }, [selectedSessionId, sessions])

  // Track last viewed project path
  useEffect(() => {
    if (selectedSession?.projectPath) {
      setLastProjectPath(selectedSession.projectPath)
    }
  }, [selectedSession?.projectPath, setLastProjectPath])

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

  // Auto-select first session on mobile when sessions load
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches
    if (isMobile && hasLoaded && selectedSessionId === null && sortedSessions.length > 0) {
      setSelectedSessionId(sortedSessions[0].id)
    }
  }, [hasLoaded, selectedSessionId, sortedSessions, setSelectedSessionId])

  const markSessionExiting = useSessionStore((state) => state.markSessionExiting)

  const handleKillSession = useCallback((sessionId: string) => {
    // Mark as exiting before sending kill to preserve session data for exit animation
    markSessionExiting(sessionId)
    sendMessage({ type: 'session-kill', sessionId })
  }, [markSessionExiting, sendMessage])

  useEffect(() => {
    const effectiveModifier = getEffectiveModifier(shortcutModifier)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      // Use event.code for consistent detection across browsers
      // (event.key fails in Chrome/Arc on macOS due to Option dead keys)
      const code = event.code
      const isShortcut = matchesModifier(event, effectiveModifier)

      // Bracket navigation: [mod]+[ / ]
      if (isShortcut && (code === 'BracketLeft' || code === 'BracketRight')) {
        event.preventDefault()
        const currentIndex = sortedSessions.findIndex(s => s.id === selectedSessionId)
        if (currentIndex === -1 && sortedSessions.length > 0) {
          setSelectedSessionId(sortedSessions[0].id)
          return
        }
        const delta = code === 'BracketLeft' ? -1 : 1
        const newIndex = (currentIndex + delta + sortedSessions.length) % sortedSessions.length
        setSelectedSessionId(sortedSessions[newIndex].id)
        return
      }

      // New session: [mod]+N
      if (isShortcut && code === 'KeyN') {
        event.preventDefault()
        if (!isModalOpen) {
          setIsModalOpen(true)
        }
        return
      }

      // Kill session: [mod]+X
      if (isShortcut && code === 'KeyX') {
        event.preventDefault()
        if (selectedSessionId && !isModalOpen) {
          handleKillSession(selectedSessionId)
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isModalOpen, selectedSessionId, setSelectedSessionId, sortedSessions, handleKillSession, shortcutModifier])

  const handleNewSession = () => setIsModalOpen(true)
  const handleOpenSettings = () => setIsSettingsOpen(true)

  const handleCreateSession = (
    projectPath: string,
    name?: string,
    command?: string
  ) => {
    sendMessage({ type: 'session-create', projectPath, name, command })
    setLastProjectPath(projectPath)
  }

  const handleResumeSession = (sessionId: string) => {
    sendMessage({ type: 'session-resume', sessionId })
  }

  const handleRenameSession = (sessionId: string, newName: string) => {
    sendMessage({ type: 'session-rename', sessionId, newName })
  }

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
          tailscaleIp={serverInfo?.tailscaleIp ?? null}
        />
        <SessionList
          sessions={sessions}
          inactiveSessions={agentSessions.inactive}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
          onRename={handleRenameSession}
          onResume={handleResumeSession}
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
        sessions={sortedSessions}
        connectionStatus={connectionStatus}
        sendMessage={sendMessage}
        subscribe={subscribe}
        onClose={() => setSelectedSessionId(null)}
        onSelectSession={setSelectedSessionId}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onRenameSession={handleRenameSession}
        onOpenSettings={handleOpenSettings}
        onResumeSession={handleResumeSession}
        inactiveSessions={agentSessions.inactive}
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
        onUpdateModifiers={updatePresetModifiers}
        lastProjectPath={lastProjectPath}
        activeProjectPath={selectedSession?.projectPath}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  )
}
