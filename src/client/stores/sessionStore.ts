import { create } from 'zustand'
import type { Session } from '@shared/types'

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'

interface SessionState {
  sessions: Session[]
  selectedSessionId: string | null
  hasLoaded: boolean
  connectionStatus: ConnectionStatus
  connectionError: string | null
  setSessions: (sessions: Session[]) => void
  updateSession: (session: Session) => void
  setSelectedSessionId: (sessionId: string | null) => void
  setConnectionStatus: (status: ConnectionStatus) => void
  setConnectionError: (error: string | null) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  hasLoaded: false,
  connectionStatus: 'connecting',
  connectionError: null,
  setSessions: (sessions) => {
    const selected = get().selectedSessionId
    const stillExists = sessions.some((session) => session.id === selected)
    set({
      sessions,
      hasLoaded: true,
      selectedSessionId: stillExists ? selected : null,
    })
  },
  updateSession: (session) =>
    set((state) => ({
      sessions: state.sessions.map((existing) =>
        existing.id === session.id ? session : existing
      ),
    })),
  setSelectedSessionId: (sessionId) => set({ selectedSessionId: sessionId }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setConnectionError: (error) => set({ connectionError: error }),
}))
