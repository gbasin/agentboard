import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AgentSession, HostStatus, Session } from '@shared/types'
import { sortSessions } from '../utils/sessions'
import { useSettingsStore } from './settingsStore'
import { createTabStorage } from '../utils/storage'

const SESSION_PERSIST_KEY = 'agentboard-session'
const tabStorage = createTabStorage(SESSION_PERSIST_KEY)

function sessionsEqualById(a: Session, b: Session): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.tmuxWindow === b.tmuxWindow &&
    a.projectPath === b.projectPath &&
    a.status === b.status &&
    a.lastActivity === b.lastActivity &&
    a.createdAt === b.createdAt &&
    a.source === b.source &&
    a.host === b.host &&
    a.remote === b.remote &&
    a.command === b.command &&
    a.agentType === b.agentType &&
    a.agentSessionId === b.agentSessionId &&
    a.agentSessionName === b.agentSessionName &&
    a.logFilePath === b.logFilePath &&
    a.isPinned === b.isPinned &&
    a.lastUserMessage === b.lastUserMessage
  )
}

/** Compare two session arrays for structural equality, ignoring order. */
function sessionsEqual(a: Session[], b: Session[]): boolean {
  if (a.length !== b.length) return false
  const byId = new Map(a.map((session) => [session.id, session]))
  for (const next of b) {
    const current = byId.get(next.id)
    if (!current || !sessionsEqualById(current, next)) {
      return false
    }
  }
  return true
}

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

interface SessionState {
  sessions: Session[]
  agentSessions: { active: AgentSession[]; sleeping: AgentSession[]; inactive: AgentSession[] }
  hostStatuses: HostStatus[]
  // Sessions being animated out - keyed by session ID, value is the session data
  exitingSessions: Map<string, Session>
  selectedSessionId: string | null
  selectedSleepingSessionId: string | null
  hasLoaded: boolean
  connectionStatus: ConnectionStatus
  connectionError: string | null
  connectionEpoch: number
  setSessions: (sessions: Session[]) => void
  setAgentSessions: (
    active: AgentSession[],
    sleeping: AgentSession[],
    inactive: AgentSession[]
  ) => void
  setActiveAgentSessions: (active: AgentSession[]) => void
  setHostStatuses: (hosts: HostStatus[]) => void
  updateSession: (session: Session) => void
  setSelectedSessionId: (sessionId: string | null) => void
  setSelectedSleepingSessionId: (sessionId: string | null) => void
  setConnectionStatus: (status: ConnectionStatus) => void
  setConnectionError: (error: string | null) => void
  setConnectionState: (status: ConnectionStatus, error: string | null, epoch: number) => void
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

function normalizePersistedSelectedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizeAgentSessionList(value: unknown): AgentSession[] {
  return Array.isArray(value) ? value : []
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      agentSessions: { active: [], sleeping: [], inactive: [] },
      hostStatuses: [],
      exitingSessions: new Map(),
      selectedSessionId: null,
      selectedSleepingSessionId: null,
      hasLoaded: false,
      connectionStatus: 'connecting',
      connectionError: null,
      connectionEpoch: 0,
      remoteAllowControl: false,
      remoteAllowAttach: false,
      hostLabel: null,
      setSessions: (sessions) => {
        const state = get()
        const selected = state.selectedSessionId
        const selectedSleeping = state.selectedSleepingSessionId
        const currentSessions = state.sessions
        const exitingSessions = state.exitingSessions

        // Skip redundant snapshots to avoid unnecessary re-renders/animation churn.
        // Keep activity timestamps in equality so status sorting and badges stay fresh.
        if (state.hasLoaded && sessionsEqual(currentSessions, sessions)) {
          return
        }

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
          if (selectedSleeping === null) {
            // Auto-select first session (by sort order) when current one is deleted
            const { sessionSortMode, sessionSortDirection } =
              useSettingsStore.getState()
            const sorted = sortSessions(sessions, {
              mode: sessionSortMode,
              direction: sessionSortDirection,
            })
            newSelectedId = sorted[0]?.id ?? null
          } else {
            newSelectedId = null
          }
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
      setAgentSessions: (active, sleeping, inactive) =>
        set((state) => {
          const nextAgentSessions = {
            active: normalizeAgentSessionList(active),
            sleeping: normalizeAgentSessionList(sleeping),
            inactive: normalizeAgentSessionList(inactive),
          }

          return {
            agentSessions: nextAgentSessions,
            selectedSleepingSessionId:
              state.selectedSleepingSessionId &&
              !nextAgentSessions.sleeping.some(
                (session) => session.sessionId === state.selectedSleepingSessionId
              )
                ? null
                : state.selectedSleepingSessionId,
          }
        }),
      setActiveAgentSessions: (active) =>
        set((state) => ({
          agentSessions: {
            active: normalizeAgentSessionList(active),
            sleeping: state.agentSessions.sleeping,
            inactive: state.agentSessions.inactive,
          },
        })),
      setHostStatuses: (hosts) => set({ hostStatuses: hosts }),
      updateSession: (session) =>
        set((state) => ({
          sessions: state.sessions.map((existing) =>
            existing.id === session.id ? session : existing
          ),
        })),
      setSelectedSessionId: (sessionId) =>
        set({
          selectedSessionId: sessionId,
          ...(sessionId !== null ? { selectedSleepingSessionId: null } : {}),
        }),
      setSelectedSleepingSessionId: (sessionId) =>
        set({
          selectedSleepingSessionId: sessionId,
          ...(sessionId !== null ? { selectedSessionId: null } : {}),
        }),
      setConnectionStatus: (status) => set({ connectionStatus: status }),
      setConnectionError: (error) => set({ connectionError: error }),
      setConnectionState: (status, error, epoch) => set({ connectionStatus: status, connectionError: error, connectionEpoch: epoch }),
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
      name: SESSION_PERSIST_KEY,
      storage: createJSONStorage(() => tabStorage),
      partialize: (state) => ({
        selectedSessionId: state.selectedSessionId,
        selectedSleepingSessionId: state.selectedSleepingSessionId,
      }),
      merge: (persistedState, currentState) => {
        const state = persistedState as Partial<SessionState> | undefined
        return {
          ...currentState,
          selectedSessionId: normalizePersistedSelectedId(state?.selectedSessionId),
          selectedSleepingSessionId: normalizePersistedSelectedId(
            state?.selectedSleepingSessionId
          ),
        }
      },
    }
  )
)
