import { describe, expect, test } from 'bun:test'
import type { AgentSession, Session } from '@shared/types'
import { freezeListOrderDuringDrag, getUniqueProjects } from '../utils/sessions'

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

const baseHistory: AgentSession = {
  sessionId: 'history-1',
  logFilePath: '/tmp/log.jsonl',
  projectPath: '/tmp/alpha',
  agentType: 'claude',
  displayName: 'alpha',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-01T00:00:00.000Z',
  isActive: false,
}

function makeSession(overrides: Partial<Session>): Session {
  return { ...baseSession, ...overrides }
}

function makeHistory(overrides: Partial<AgentSession>): AgentSession {
  return { ...baseHistory, ...overrides }
}

describe('getUniqueProjects', () => {
  test('dedupes and sorts project paths by most recent activity', () => {
    const sessions = [
      makeSession({ id: 'a', projectPath: '/tmp/beta', lastActivity: '2024-01-01T01:00:00.000Z' }),
      makeSession({ id: 'b', projectPath: '/tmp/alpha', lastActivity: '2024-01-01T03:00:00.000Z' }),
      makeSession({ id: 'c', projectPath: '/tmp/alpha', lastActivity: '2024-01-01T02:00:00.000Z' }),
    ]
    const history = [
      makeHistory({ sessionId: 'history-2', projectPath: '/tmp/charlie', lastActivityAt: '2024-01-01T04:00:00.000Z' }),
      makeHistory({ sessionId: 'history-3', projectPath: '/tmp/beta', lastActivityAt: '2024-01-01T00:30:00.000Z' }),
    ]

    // Sorted by most recent activity: charlie (04:00), alpha (03:00), beta (01:00)
    expect(getUniqueProjects(sessions, history)).toEqual([
      '/tmp/charlie',
      '/tmp/alpha',
      '/tmp/beta',
    ])
  })

  test('ignores empty project paths', () => {
    const sessions = [
      makeSession({ id: 'empty', projectPath: '   ' }),
    ]
    const history = [
      makeHistory({ sessionId: 'empty-history', projectPath: '' }),
    ]

    expect(getUniqueProjects(sessions, history)).toEqual([])
  })
})

describe('freezeListOrderDuringDrag', () => {
  test('passes the live order through when there is no snapshot', () => {
    const sessions = [makeSession({ id: 'a' }), makeSession({ id: 'b' })]
    expect(freezeListOrderDuringDrag(sessions, null)).toBe(sessions)
  })

  test('keeps the snapshot order when the live order re-sorts mid-drag', () => {
    const snapshot = ['a', 'b', 'c']
    const live = [
      makeSession({ id: 'c' }),
      makeSession({ id: 'a' }),
      makeSession({ id: 'b' }),
    ]
    expect(freezeListOrderDuringDrag(live, snapshot).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('appends sessions that appear mid-drag at the end', () => {
    const snapshot = ['a', 'b']
    const live = [
      makeSession({ id: 'new' }),
      makeSession({ id: 'a' }),
      makeSession({ id: 'b' }),
    ]
    expect(freezeListOrderDuringDrag(live, snapshot).map((s) => s.id)).toEqual([
      'a',
      'b',
      'new',
    ])
  })

  test('drops sessions that disappear mid-drag', () => {
    const snapshot = ['a', 'b', 'c']
    const live = [makeSession({ id: 'a' }), makeSession({ id: 'c' })]
    expect(freezeListOrderDuringDrag(live, snapshot).map((s) => s.id)).toEqual([
      'a',
      'c',
    ])
  })

  test('handles simultaneous reorder, add, and remove', () => {
    const snapshot = ['a', 'b', 'c', 'd']
    const live = [
      makeSession({ id: 'd' }),
      makeSession({ id: 'x' }),
      makeSession({ id: 'a' }),
      makeSession({ id: 'c' }),
    ]
    expect(freezeListOrderDuringDrag(live, snapshot).map((s) => s.id)).toEqual([
      'a',
      'c',
      'd',
      'x',
    ])
  })

  test('returns a fresh array containing the live session objects', () => {
    const snapshot = ['a', 'b']
    const liveA = makeSession({ id: 'a', name: 'updated-name' })
    const live = [liveA, makeSession({ id: 'b' })]
    const frozen = freezeListOrderDuringDrag(live, snapshot)
    expect(frozen[0]).toBe(liveA)
    expect(frozen).not.toBe(live)
  })
})
