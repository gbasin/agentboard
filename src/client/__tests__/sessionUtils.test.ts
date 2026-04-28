import { describe, expect, test } from 'bun:test'
import type { AgentSession, Session } from '@shared/types'
import { getUniqueProjects } from '../utils/sessions'

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
