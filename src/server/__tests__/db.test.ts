import { describe, expect, test, afterEach } from 'bun:test'
import { initDatabase, generateSyntheticId } from '../db'
import type { AgentType } from '../../shared/types'

const now = new Date('2026-01-01T00:00:00.000Z').toISOString()

function makeSession(overrides: Partial<{
  sessionId: string
  logFilePath: string
  projectPath: string
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  currentWindow: string | null
  sessionSource: 'log' | 'synthetic'
}> = {}) {
  return {
    sessionId: 'session-abc',
    logFilePath: '/tmp/session-abc.jsonl',
    projectPath: '/tmp/alpha',
    agentType: 'claude' as const,
    displayName: 'alpha',
    createdAt: now,
    lastActivityAt: now,
    currentWindow: 'agentboard:1',
    sessionSource: 'log' as const,
    ...overrides,
  }
}

describe('db', () => {
  const db = initDatabase({ path: ':memory:' })

  afterEach(() => {
    db.db.exec('DELETE FROM agent_sessions')
  })

  test('insert/get/update/orphan session records', () => {
    const session = makeSession()
    const inserted = db.insertSession(session)
    expect(inserted.id).toBeGreaterThan(0)
    expect(inserted.sessionId).toBe(session.sessionId)

    const byId = db.getSessionById(session.sessionId)
    expect(byId?.logFilePath).toBe(session.logFilePath)

    const byPath = db.getSessionByLogPath(session.logFilePath)
    expect(byPath?.sessionId).toBe(session.sessionId)

    const byWindow = db.getSessionByWindow(session.currentWindow ?? '')
    expect(byWindow?.sessionId).toBe(session.sessionId)

    const updated = db.updateSession(session.sessionId, {
      displayName: 'beta',
      currentWindow: null,
    })
    expect(updated?.displayName).toBe('beta')
    expect(updated?.currentWindow).toBeNull()

    const active = db.getActiveSessions()
    const inactive = db.getInactiveSessions()
    expect(active).toHaveLength(0)
    expect(inactive).toHaveLength(1)

    const orphaned = db.orphanSession(session.sessionId)
    expect(orphaned?.currentWindow).toBeNull()
  })

  test('generates deterministic synthetic ids', () => {
    const idA = generateSyntheticId('/tmp/example.jsonl')
    const idB = generateSyntheticId('/tmp/example.jsonl')
    expect(idA).toBe(idB)
  })
})
