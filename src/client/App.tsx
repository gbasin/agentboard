import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session, ServerMessage } from '@shared/types'
import Header from './components/Header'
import SessionList from './components/SessionList'
import Terminal from './components/Terminal'
import NewSessionModal from './components/NewSessionModal'
import { useSessionStore } from './stores/sessionStore'
import { useThemeStore } from './stores/themeStore'
import { useWebSocket } from './hooks/useWebSocket'
import { useNotifications } from './hooks/useNotifications'
import { useFaviconBadge } from './hooks/useFaviconBadge'
import { useVisualViewport } from './hooks/useVisualViewport'
import { sortSessions } from './utils/sessions'

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false)
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

  const { sendMessage, subscribe } = useWebSocket()
  const { notify, requestPermission } = useNotifications()

  // Handle mobile keyboard viewport adjustments
  useVisualViewport()

  useEffect(() => {
    requestPermission()
  }, [requestPermission])

  useEffect(() => {
    const unsubscribe = subscribe((message: ServerMessage) => {
      if (message.type === 'sessions') {
        setSessions(message.sessions)
      }
      if (message.type === 'session-update') {
        updateSession(message.session)
      }
      if (message.type === 'error') {
        setServerError(message.message)
        window.setTimeout(() => setServerError(null), 6000)
      }
    })

    return () => { unsubscribe() }
  }, [sendMessage, setSessions, subscribe, updateSession])

  const selectedSession = useMemo(() => {
    return sessions.find((session) => session.id === selectedSessionId) || null
  }, [selectedSessionId, sessions])

  const sortedSessions = useMemo(() => sortSessions(sessions), [sessions])

  const needsApprovalCount = useMemo(
    () => sessions.filter((session) => session.status === 'needs_approval').length,
    [sessions]
  )

  useFaviconBadge(needsApprovalCount > 0)

  const previousStatuses = useRef<Map<string, Session['status']>>(new Map())

  useEffect(() => {
    const prev = previousStatuses.current
    for (const session of sessions) {
      const previousStatus = prev.get(session.id)
      if (
        session.status === 'needs_approval' &&
        previousStatus !== 'needs_approval'
      ) {
        notify('Agentboard', `${session.name} needs approval.`)
      }
      prev.set(session.id, session.status)
    }
  }, [notify, sessions])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isModalOpen) return
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.shiftKey || event.altKey) return

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

      const key = event.key
      if (!/^[1-9]$/.test(key)) return

      const index = Number(key) - 1
      const target = sortedSessions[index]
      if (!target) return

      event.preventDefault()
      setSelectedSessionId(target.id)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isModalOpen, setSelectedSessionId, sortedSessions])

  const handleNewSession = () => setIsModalOpen(true)

  const handleCreateSession = (projectPath: string, name?: string) => {
    sendMessage({ type: 'session-create', projectPath, name })
  }

  const handleKillSession = (sessionId: string) => {
    sendMessage({ type: 'session-kill', sessionId })
  }

  const handleRenameSession = (sessionId: string, newName: string) => {
    sendMessage({ type: 'session-rename', sessionId, newName })
  }

  const handleRefresh = () => {
    sendMessage({ type: 'session-refresh' })
  }

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header
        connectionStatus={connectionStatus}
        needsApprovalCount={needsApprovalCount}
        onNewSession={handleNewSession}
        onRefresh={handleRefresh}
      />

      <div className="flex min-h-0 flex-1">
        {/* Sidebar - hidden on mobile when session selected */}
        <div className={`w-full shrink-0 md:w-60 lg:w-72 ${selectedSession ? 'hidden md:block' : ''}`}>
          <SessionList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelect={setSelectedSessionId}
            onKill={handleKillSession}
            onRename={handleRenameSession}
            loading={!hasLoaded}
            error={connectionError || serverError}
          />
        </div>

        {/* Terminal - hero element */}
        <Terminal
          session={selectedSession}
          connectionStatus={connectionStatus}
          sendMessage={sendMessage}
          subscribe={subscribe}
          onClose={() => setSelectedSessionId(null)}
          pendingApprovals={needsApprovalCount}
        />
      </div>

      <NewSessionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateSession}
      />
    </div>
  )
}
