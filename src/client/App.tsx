import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ServerMessage } from '@shared/types'
import Header from './components/Header'
import SessionList from './components/SessionList'
import Terminal from './components/Terminal'
import NewSessionModal from './components/NewSessionModal'
import SettingsModal from './components/SettingsModal'
import { useSessionStore } from './stores/sessionStore'
import { useSettingsStore } from './stores/settingsStore'
import { useThemeStore } from './stores/themeStore'
import { useWebSocket } from './hooks/useWebSocket'
import { useVisualViewport } from './hooks/useVisualViewport'
import { sortSessions } from './utils/sessions'

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const sessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore(
    (state) => state.selectedSessionId
  )
  const setSessions = useSessionStore((state) => state.setSessions)
  const updateSession = useSessionStore((state) => state.updateSession)
  const setSelectedSessionId = useSessionStore(
    (state) => state.setSelectedSessionId
  )
  const hasLoaded = useSessionStore((state) => state.hasLoaded)
  const connectionStatus = useSessionStore(
    (state) => state.connectionStatus
  )
  const connectionError = useSessionStore((state) => state.connectionError)

  const theme = useThemeStore((state) => state.theme)
  const defaultProjectDir = useSettingsStore(
    (state) => state.defaultProjectDir
  )
  const defaultCommand = useSettingsStore((state) => state.defaultCommand)
  const lastProjectPath = useSettingsStore((state) => state.lastProjectPath)
  const setLastProjectPath = useSettingsStore(
    (state) => state.setLastProjectPath
  )

  const { sendMessage, subscribe } = useWebSocket()

  // Handle mobile keyboard viewport adjustments
  useVisualViewport()

  useEffect(() => {
    const unsubscribe = subscribe((message: ServerMessage) => {
      if (message.type === 'sessions') {
        setSessions(message.sessions)
      }
      if (message.type === 'session-update') {
        updateSession(message.session)
      }
      if (message.type === 'session-created') {
        setSelectedSessionId(message.session.id)
      }
      if (message.type === 'error') {
        setServerError(message.message)
        window.setTimeout(() => setServerError(null), 6000)
      }
    })

    return () => { unsubscribe() }
  }, [sendMessage, setSelectedSessionId, setSessions, subscribe, updateSession])

  const selectedSession = useMemo(() => {
    return sessions.find((session) => session.id === selectedSessionId) || null
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

  const sortedSessions = useMemo(
    () =>
      sortSessions(sessions, {
        mode: sessionSortMode,
        direction: sessionSortDirection,
      }),
    [sessions, sessionSortMode, sessionSortDirection]
  )

  const handleKillSession = useCallback((sessionId: string) => {
    sendMessage({ type: 'session-kill', sessionId })
  }, [sendMessage])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!(event.metaKey || event.ctrlKey)) return

      const key = event.key

      // Cmd+Shift+A: New session (Agent)
      if (!event.altKey && event.shiftKey && key.toLowerCase() === 'a') {
        event.preventDefault()
        if (!isModalOpen) {
          setIsModalOpen(true)
        }
        return
      }

      // Cmd+Shift+X: Kill current session
      if (!event.altKey && event.shiftKey && key.toLowerCase() === 'x') {
        event.preventDefault()
        if (selectedSessionId && !isModalOpen) {
          handleKillSession(selectedSessionId)
        }
        return
      }

      // Other shortcuts require no shift and no modal open
      if (event.shiftKey || isModalOpen) return

      const activeElement = document.activeElement
      if (activeElement instanceof HTMLElement) {
        const tagName = activeElement.tagName
        const isTerminalFocus = activeElement.closest('.xterm') !== null
        if (
          activeElement.isContentEditable ||
          (!isTerminalFocus &&
            (tagName === 'INPUT' ||
              tagName === 'TEXTAREA' ||
              tagName === 'SELECT'))
        ) {
          return
        }
      }

      // Ctrl+1-9: Switch sessions (works in Safari without conflicts)
      if (!event.ctrlKey || event.metaKey || !/^[1-9]$/.test(key)) return

      const index = Number(key) - 1
      const target = sortedSessions[index]
      if (!target) return

      event.preventDefault()
      setSelectedSessionId(target.id)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isModalOpen, selectedSessionId, setSelectedSessionId, sortedSessions, handleKillSession])

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

  const handleRenameSession = (sessionId: string, newName: string) => {
    sendMessage({ type: 'session-rename', sessionId, newName })
  }

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left column: header + sidebar - hidden on mobile when session selected */}
      <div className={`flex h-full w-full flex-col md:w-60 lg:w-72 md:shrink-0 ${selectedSession ? 'hidden md:flex' : ''}`}>
        <Header
          connectionStatus={connectionStatus}
          onNewSession={handleNewSession}
        />
        <SessionList
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
          onRename={handleRenameSession}
          loading={!hasLoaded}
          error={connectionError || serverError}
        />
      </div>

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
      />

      <NewSessionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateSession}
        defaultProjectDir={defaultProjectDir}
        defaultCommand={defaultCommand}
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
