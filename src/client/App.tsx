import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session, ServerMessage } from '@shared/types'
import Header from './components/Header'
import Dashboard from './components/Dashboard'
import Terminal from './components/Terminal'
import NewSessionModal from './components/NewSessionModal'
import { useSessionStore } from './stores/sessionStore'
import { useWebSocket } from './hooks/useWebSocket'
import { useNotifications } from './hooks/useNotifications'
import { useFaviconBadge } from './hooks/useFaviconBadge'

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

  const { sendMessage, subscribe } = useWebSocket()
  const { notify, requestPermission } = useNotifications()

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

  const handleNewSession = () => setIsModalOpen(true)

  const handleCreateSession = (projectPath: string, name?: string) => {
    sendMessage({ type: 'session-create', projectPath, name })
  }

  const handleKillSession = (sessionId: string) => {
    sendMessage({ type: 'session-kill', sessionId })
  }

  const handleRefresh = () => {
    sendMessage({ type: 'session-refresh' })
  }

  return (
    <div className="min-h-screen pb-10">
      <Header
        connectionStatus={connectionStatus}
        needsApprovalCount={needsApprovalCount}
        onNewSession={handleNewSession}
        onRefresh={handleRefresh}
      />

      <Dashboard
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        onSelect={setSelectedSessionId}
        onKill={handleKillSession}
        loading={!hasLoaded}
        error={connectionError || serverError}
      />

      <div className="px-6">
        <Terminal
          session={selectedSession}
          connectionStatus={connectionStatus}
          sendMessage={sendMessage}
          subscribe={subscribe}
          onClose={() => setSelectedSessionId(null)}
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
