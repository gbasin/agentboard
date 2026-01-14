import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AgentSession, Session } from '@shared/types'
import { sortSessions } from '../utils/sessions'
import { useSettingsStore } from './settingsStore'
import { safeStorage } from '../utils/storage'

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'

interface SessionState {
  sessions: Session[]
  agentSessions: { active: AgentSession[]; inactive: AgentSession[] }
  selectedSessionId: string | null
  hasLoaded: boolean
  connectionStatus: ConnectionStatus
  connectionError: string | null
  setSessions: (sessions: Session[]) => void
  setAgentSessions: (active: AgentSession[], inactive: AgentSession[]) => void
  updateSession: (session: Session) => void
  setSelectedSessionId: (sessionId: string | null) => void
  setConnectionStatus: (status: ConnectionStatus) => void
  setConnectionError: (error: string | null) => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      agentSessions: { active: [], inactive: [] },
      selectedSessionId: null,
      hasLoaded: false,
      connectionStatus: 'connecting',
      connectionError: null,
      setSessions: (sessions) => {
        const selected = get().selectedSessionId
        let newSelectedId: string | null = selected
        if (
          selected !== null &&
          !sessions.some((session) => session.id === selected)
        ) {
          // Auto-select first session (by sort order) when current one is deleted
          const { sessionSortMode, sessionSortDirection } =
            useSettingsStore.getState()
          const sorted = sortSessions(sessions, {
            mode: sessionSortMode,
            direction: sessionSortDirection,
          })
          newSelectedId = sorted[0]?.id ?? null
        }
        set({
          sessions,
          hasLoaded: true,
          selectedSessionId: newSelectedId,
        })
      },
      setAgentSessions: (active, inactive) =>
        set({
          agentSessions: { active, inactive },
        }),
      updateSession: (session) =>
        set((state) => ({
          sessions: state.sessions.map((existing) =>
            existing.id === session.id ? session : existing
          ),
        })),
      setSelectedSessionId: (sessionId) => set({ selectedSessionId: sessionId }),
      setConnectionStatus: (status) => set({ connectionStatus: status }),
      setConnectionError: (error) => set({ connectionError: error }),
    }),
    {
      name: 'agentboard-session',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ selectedSessionId: state.selectedSessionId }),
    }
  )
)
