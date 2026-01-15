import { describe, expect, test } from 'bun:test'
import { deriveDisplayName, toAgentSession } from '../agentSessions'
import type { AgentSessionRecord } from '../db'

const baseRecord: AgentSessionRecord = {
  id: 1,
  sessionId: 'session-12345678-abcdef',
  logFilePath: '/tmp/session.jsonl',
  projectPath: '/projects/alpha',
  agentType: 'claude',
  displayName: 'Alpha Project',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-02T00:00:00.000Z',
  currentWindow: 'agentboard:1',
}

describe('agentSessions', () => {
  test('toAgentSession maps record and active state', () => {
    const active = toAgentSession(baseRecord)
    expect(active.sessionId).toBe(baseRecord.sessionId)
    expect(active.isActive).toBe(true)

    const inactive = toAgentSession({ ...baseRecord, currentWindow: null })
    expect(inactive.isActive).toBe(false)
  })

  test('deriveDisplayName uses fallback, leaf, and session id', () => {
    expect(deriveDisplayName('/projects/alpha', 'session-12345678', '  custom  ')).toBe(
      'custom'
    )
    expect(deriveDisplayName('/projects/alpha', 'session-12345678')).toBe('alpha')
    expect(deriveDisplayName('', 'session-12345678')).toBe('session-')
  })
})
