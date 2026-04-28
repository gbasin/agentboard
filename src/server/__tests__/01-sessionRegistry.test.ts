import { describe, expect, test } from 'bun:test'
import { SessionRegistry } from '../SessionRegistry'
import type { AgentSession, Session } from '../../shared/types'

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

const baseAgentSession: AgentSession = {
  sessionId: 'agent-1',
  logFilePath: '/tmp/agent-1.jsonl',
  projectPath: '/tmp/project',
  agentType: 'claude',
  displayName: 'alpha',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-01T00:00:00.000Z',
  isActive: true,
  isPinned: false,
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return { ...baseSession, ...overrides }
}

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return { ...baseAgentSession, ...overrides }
}

describe('SessionRegistry', () => {
  test('replaceSessions keeps latest activity and emits removals', () => {
    const registry = new SessionRegistry()
    const sessionsEvents: Session[][] = []
    const removedIds: string[] = []

    registry.on('sessions', (sessions) => sessionsEvents.push(sessions))
    registry.on('session-removed', (sessionId) => removedIds.push(sessionId))

    const latest = makeSession({
      id: 'alpha',
      lastActivity: new Date('2024-02-02T00:00:00.000Z').toISOString(),
    })
    const toRemove = makeSession({
      id: 'bravo',
      lastActivity: new Date('2024-02-01T00:00:00.000Z').toISOString(),
    })

    registry.replaceSessions([latest, toRemove])

    const olderUpdate = makeSession({
      id: 'alpha',
      lastActivity: new Date('2023-01-01T00:00:00.000Z').toISOString(),
    })
    registry.replaceSessions([olderUpdate])

    const stored = registry.get('alpha')
    expect(stored?.lastActivity).toBe(latest.lastActivity)
    expect(removedIds).toEqual(['bravo'])
    expect(sessionsEvents).toHaveLength(2)
  })

  test('updateSession merges updates and emits event', () => {
    const registry = new SessionRegistry()
    const updates: Session[] = []
    registry.on('session-update', (session) => updates.push(session))

    const session = makeSession({ id: 'delta', name: 'delta' })
    registry.replaceSessions([session])

    const result = registry.updateSession('delta', {
      status: 'working',
      name: 'renamed',
    })

    expect(result?.status).toBe('working')
    expect(registry.get('delta')?.name).toBe('renamed')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.name).toBe('renamed')
  })

  test('updateSession returns undefined when missing', () => {
    const registry = new SessionRegistry()
    const updates: Session[] = []
    registry.on('session-update', (session) => updates.push(session))

    const result = registry.updateSession('missing', { status: 'working' })
    expect(result).toBeUndefined()
    expect(updates).toHaveLength(0)
  })

	  test('replaceSessions skips session emit when data is unchanged', () => {
	    const registry = new SessionRegistry()
	    const sessionsEvents: Session[][] = []

    registry.on('sessions', (sessions) => sessionsEvents.push(sessions))

    const session = makeSession({ id: 'alpha' })
    registry.replaceSessions([session])
    registry.replaceSessions([session])

	    expect(sessionsEvents).toHaveLength(1)
	  })

	  test('replaceSessions emits when window ownership fields change', () => {
	    const registry = new SessionRegistry()
	    const sessionsEvents: Session[][] = []

	    registry.on('sessions', (sessions) => sessionsEvents.push(sessions))

	    const session = makeSession({ id: 'alpha' })
	    registry.replaceSessions([session])
	    sessionsEvents.length = 0

	    registry.replaceSessions([
	      makeSession({
	        id: 'alpha',
	        tmuxWindow: 'agentboard:2',
	        source: 'external',
	      }),
	    ])

	    expect(sessionsEvents).toHaveLength(1)
	    expect(sessionsEvents[0][0]).toMatchObject({
	      id: 'alpha',
	      tmuxWindow: 'agentboard:2',
	      source: 'external',
	    })
	  })

	  test('setAgentSessions emits only agent-sessions-active when only active sessions change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const history = [makeAgentSession({ sessionId: 'old', isActive: false })]

    // Initial set: both change from empty defaults
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a1' })],
      [],
      history
    )
    fullEvents.length = 0
    activeEvents.length = 0

    // Change only active sessions, keep history identical
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a2' })],
      [],
      history
    )

    expect(activeEvents).toHaveLength(1)
    expect(activeEvents[0][0].sessionId).toBe('a2')
    expect(fullEvents).toHaveLength(0)
  })

  test('setAgentSessions emits only agent-sessions when only history sessions change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const active = [makeAgentSession({ sessionId: 'a1' })]

    // Initial set
    registry.setAgentSessions(
      active,
      [],
      [makeAgentSession({ sessionId: 'old', isActive: false })]
    )
    fullEvents.length = 0
    activeEvents.length = 0

    // Change only history sessions, keep active identical
    registry.setAgentSessions(
      active,
      [],
      [makeAgentSession({ sessionId: 'new-history', isActive: false })]
    )

    expect(fullEvents).toHaveLength(1)
    expect(fullEvents[0].history[0].sessionId).toBe('new-history')
    // active did not change, so no active-only event
    expect(activeEvents).toHaveLength(0)
  })

  test('setAgentSessions emits both events when both active and history change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    // Initial set
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a1' })],
      [],
      [makeAgentSession({ sessionId: 'i1', isActive: false })]
    )
    fullEvents.length = 0
    activeEvents.length = 0

    // Change both active and history
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a2' })],
      [],
      [makeAgentSession({ sessionId: 'i2', isActive: false })]
    )

    expect(activeEvents).toHaveLength(1)
    expect(activeEvents[0][0].sessionId).toBe('a2')
    expect(fullEvents).toHaveLength(1)
    expect(fullEvents[0].active[0].sessionId).toBe('a2')
    expect(fullEvents[0].history[0].sessionId).toBe('i2')
  })

  test('setAgentSessions emits nothing when nothing changes', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const active = [makeAgentSession({ sessionId: 'a1' })]
    const history = [makeAgentSession({ sessionId: 'i1', isActive: false })]

    // Initial set
    registry.setAgentSessions(active, [], history)
    fullEvents.length = 0
    activeEvents.length = 0

    // Same data again
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a1' })],
      [],
      [makeAgentSession({ sessionId: 'i1', isActive: false })]
    )

    expect(activeEvents).toHaveLength(0)
    expect(fullEvents).toHaveLength(0)
  })

  test('setAgentSessions emits full payload when hibernating sessions change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const active = [makeAgentSession({ sessionId: 'a1' })]
    const hibernating = [makeAgentSession({ sessionId: 's1', isActive: false, isPinned: true })]
    registry.setAgentSessions(active, hibernating, [])
    fullEvents.length = 0
    activeEvents.length = 0

    registry.setAgentSessions(
      active,
      [makeAgentSession({ sessionId: 's2', isActive: false, isPinned: true })],
      []
    )

    expect(activeEvents).toHaveLength(0)
    expect(fullEvents).toHaveLength(1)
    expect(fullEvents[0].hibernating[0]?.sessionId).toBe('s2')
  })

  test('agentSessionsEqual correctly compares all 12 fields of AgentSession', () => {
    const registry = new SessionRegistry()
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const base = makeAgentSession({
      sessionId: 'cmp',
      logFilePath: '/tmp/cmp.jsonl',
      projectPath: '/tmp/proj',
      agentType: 'claude',
      displayName: 'compare',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastActivityAt: '2024-01-01T00:00:00.000Z',
      isActive: true,
      host: 'host-1',
      lastUserMessage: 'hello',
      isPinned: false,
      lastResumeError: undefined,
    })

    // Establish baseline
    registry.setAgentSessions([base], [], [])
    activeEvents.length = 0

    // Identical copy should NOT emit
    registry.setAgentSessions([{ ...base }], [], [])
    expect(activeEvents).toHaveLength(0)

    // Each field change should emit. Test all 12 fields one at a time.
    const fieldChanges: Array<Partial<AgentSession>> = [
      { sessionId: 'cmp-changed' },
      { logFilePath: '/tmp/other.jsonl' },
      { projectPath: '/tmp/other' },
      { agentType: 'codex' },
      { displayName: 'renamed' },
      { createdAt: '2025-01-01T00:00:00.000Z' },
      { lastActivityAt: '2025-01-01T00:00:00.000Z' },
      { isActive: false },
      { host: 'host-2' },
      { lastUserMessage: 'changed' },
      { isPinned: true },
      { lastResumeError: 'error occurred' },
    ]

    for (const change of fieldChanges) {
      // Reset to baseline
      registry.setAgentSessions([base], [], [])
      activeEvents.length = 0

      // Apply single field change
      registry.setAgentSessions([{ ...base, ...change }], [], [])
      expect(activeEvents).toHaveLength(1)
    }
  })
})
