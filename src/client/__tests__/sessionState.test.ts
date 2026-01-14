import { beforeEach, describe, expect, test } from 'bun:test'
import type { Session } from '@shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { sortSessions } from '../utils/sessions'

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/Users/example/project',
  status: 'waiting',
  lastActivity: new Date('2024-01-01T00:00:00.000Z').toISOString(),
  createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
  source: 'managed',
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return { ...baseSession, ...overrides }
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    agentSessions: { active: [], inactive: [] },
    selectedSessionId: null,
    hasLoaded: false,
    connectionStatus: 'connecting',
    connectionError: null,
  })
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showSessionIdPrefix: false,
  })
})

describe('sortSessions', () => {
  test('orders by status then last activity when mode is status', () => {
    const sessions = [
      makeSession({
        id: 'working',
        status: 'working',
        lastActivity: new Date('2024-01-02T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'waiting-newer',
        status: 'waiting',
        lastActivity: new Date('2024-01-03T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'waiting-older',
        status: 'waiting',
        lastActivity: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'unknown',
        status: 'unknown',
        lastActivity: new Date('2024-01-04T00:00:00.000Z').toISOString(),
      }),
    ]

    const sorted = sortSessions(sessions, { mode: 'status', direction: 'desc' })
    expect(sorted.map((session) => session.id)).toEqual([
      'waiting-newer',
      'waiting-older',
      'working',
      'unknown',
    ])
  })

  test('orders by createdAt descending when mode is created with desc', () => {
    const sessions = [
      makeSession({
        id: 'oldest',
        createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'middle',
        createdAt: new Date('2024-01-02T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'newest',
        createdAt: new Date('2024-01-03T00:00:00.000Z').toISOString(),
      }),
    ]

    const sorted = sortSessions(sessions, { mode: 'created', direction: 'desc' })
    expect(sorted.map((session) => session.id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ])
  })

  test('orders by createdAt ascending when mode is created with asc', () => {
    const sessions = [
      makeSession({
        id: 'newest',
        createdAt: new Date('2024-01-03T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'oldest',
        createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'middle',
        createdAt: new Date('2024-01-02T00:00:00.000Z').toISOString(),
      }),
    ]

    const sorted = sortSessions(sessions, { mode: 'created', direction: 'asc' })
    expect(sorted.map((session) => session.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ])
  })
})

describe('useSessionStore', () => {
  test('auto-selects a session when current selection is missing', () => {
    useSessionStore.setState({ selectedSessionId: 'missing' })

    // With default 'created' + 'desc' mode, newest session is selected first
    const sessions = [
      makeSession({
        id: 'older',
        status: 'waiting',
        createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      }),
      makeSession({
        id: 'newer',
        status: 'working',
        createdAt: new Date('2024-01-02T00:00:00.000Z').toISOString(),
      }),
    ]

    useSessionStore.getState().setSessions(sessions)

    // Default sort is by createdAt desc, so 'newer' should be selected
    expect(useSessionStore.getState().selectedSessionId).toBe('newer')
    expect(useSessionStore.getState().hasLoaded).toBe(true)
  })

  test('preserves selection when session still exists', () => {
    const sessions = [
      makeSession({ id: 'keep', status: 'working' }),
      makeSession({ id: 'other', status: 'waiting' }),
    ]
    useSessionStore.setState({ selectedSessionId: 'keep' })

    useSessionStore.getState().setSessions(sessions)

    expect(useSessionStore.getState().selectedSessionId).toBe('keep')
  })

  test('updates a session in place', () => {
    const sessions = [
      makeSession({ id: 'first', status: 'waiting' }),
      makeSession({ id: 'second', status: 'working' }),
    ]
    useSessionStore.setState({ sessions })

    useSessionStore
      .getState()
      .updateSession({ ...sessions[0], status: 'unknown' })

    const updated = useSessionStore
      .getState()
      .sessions.find((session) => session.id === 'first')
    expect(updated?.status).toBe('unknown')
  })

  test('setSessions keeps null selection when none chosen', () => {
    useSessionStore.setState({ selectedSessionId: null })
    useSessionStore.getState().setSessions([makeSession({ id: 'only' })])

    const state = useSessionStore.getState()
    expect(state.selectedSessionId).toBeNull()
    expect(state.hasLoaded).toBe(true)
  })

  test('setSelectedSessionId updates selection', () => {
    useSessionStore.getState().setSelectedSessionId('session-1')
    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
  })

  test('setConnectionStatus and error update state', () => {
    useSessionStore.getState().setConnectionStatus('connected')
    useSessionStore.getState().setConnectionError('boom')

    const state = useSessionStore.getState()
    expect(state.connectionStatus).toBe('connected')
    expect(state.connectionError).toBe('boom')
  })

  test('updateSession ignores missing session ids', () => {
    const sessions = [
      makeSession({ id: 'first', status: 'waiting' }),
    ]
    useSessionStore.setState({ sessions })

    useSessionStore
      .getState()
      .updateSession({ ...sessions[0], id: 'missing', status: 'unknown' })

    expect(useSessionStore.getState().sessions).toEqual(sessions)
  })
})
