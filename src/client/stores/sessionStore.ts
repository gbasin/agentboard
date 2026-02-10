import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AgentSession, HostStatus, Session } from '@shared/types'
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
  hostStatuses: HostStatus[]
  // Sessions being animated out - keyed by session ID, value is the session data
  exitingSessions: Map<string, Session>
  selectedSessionId: string | null
  hasLoaded: boolean
  connectionStatus: ConnectionStatus
  connectionError: string | null
  setSessions: (sessions: Session[]) => void
  setAgentSessions: (active: AgentSession[], inactive: AgentSession[]) => void
  setHostStatuses: (hosts: HostStatus[]) => void
  updateSession: (session: Session) => void
  setSelectedSessionId: (sessionId: string | null) => void
  setConnectionStatus: (status: ConnectionStatus) => void
  setConnectionError: (error: string | null) => void
  remoteAllowControl: boolean
  setRemoteAllowControl: (value: boolean) => void
  remoteAllowAttach: boolean
  setRemoteAllowAttach: (value: boolean) => void
  hostLabel: string | null
  setHostLabel: (value: string | null) => void
  // Mark a session as exiting (preserves data for exit animation)
  markSessionExiting: (sessionId: string) => void
  // Clear a session from exiting state (after animation completes)
  clearExitingSession: (sessionId: string) => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      agentSessions: { active: [], inactive: [] },
      hostStatuses: [],
      exitingSessions: new Map(),
      selectedSessionId: null,
      hasLoaded: false,
      connectionStatus: 'connecting',
      connectionError: null,
      remoteAllowControl: false,
      remoteAllowAttach: false,
      hostLabel: null,
      setSessions: (sessions) => {
        const state = get()
        const selected = state.selectedSessionId
        const currentSessions = state.sessions
        const exitingSessions = state.exitingSessions

        // Detect sessions removed by external sources (other tabs, devices, tmux).
        // Mark them as exiting so SessionList can animate them out gracefully.
        // Without this, externally-killed sessions vanish instantly causing artifacts.
        const newSessionIds = new Set(sessions.map((s) => s.id))
        const removedSessions = currentSessions.filter(
          (s) => !newSessionIds.has(s.id) && !exitingSessions.has(s.id)
        )

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

        // Only update exitingSessions if there are newly removed sessions
        if (removedSessions.length > 0) {
          const nextExitingSessions = new Map(exitingSessions)
          for (const session of removedSessions) {
            nextExitingSessions.set(session.id, session)
          }
          set({
            sessions,
            hasLoaded: true,
            selectedSessionId: newSelectedId,
            exitingSessions: nextExitingSessions,
          })
        } else {
          set({
            sessions,
            hasLoaded: true,
            selectedSessionId: newSelectedId,
          })
        }
      },
      setAgentSessions: (active, inactive) =>
        set({
          agentSessions: { active, inactive },
        }),
      setHostStatuses: (hosts) => set({ hostStatuses: hosts }),
      updateSession: (session) =>
        set((state) => ({
          sessions: state.sessions.map((existing) =>
            existing.id === session.id ? session : existing
          ),
        })),
      setSelectedSessionId: (sessionId) => set({ selectedSessionId: sessionId }),
      setConnectionStatus: (status) => set({ connectionStatus: status }),
      setConnectionError: (error) => set({ connectionError: error }),
      setRemoteAllowControl: (value) => set({ remoteAllowControl: value }),
      setRemoteAllowAttach: (value) => set({ remoteAllowAttach: value }),
      setHostLabel: (value) => set({ hostLabel: value }),
      markSessionExiting: (sessionId) => {
        const session = get().sessions.find((s) => s.id === sessionId)
        if (session) {
          const next = new Map(get().exitingSessions)
          next.set(sessionId, session)
          set({ exitingSessions: next })
        }
      },
      clearExitingSession: (sessionId) => {
        const next = new Map(get().exitingSessions)
        next.delete(sessionId)
        set({ exitingSessions: next })
      },
    }),
    {
      name: 'agentboard-session',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ selectedSessionId: state.selectedSessionId }),
    }
  )
)
