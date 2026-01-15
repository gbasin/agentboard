import { describe, expect, test } from 'bun:test'
import type { LogEntrySnapshot } from '../logPollData'
import type { SessionSnapshot } from '../logMatchGate'
import { getEntriesNeedingMatch, shouldRunMatching } from '../logMatchGate'

function makeEntry(
  overrides: Partial<LogEntrySnapshot> = {}
): LogEntrySnapshot {
  return {
    logPath: 'log-1',
    mtime: 1_700_000_000_000,
    birthtime: 1_699_000_000_000,
    sessionId: 'session-1',
    projectPath: '/proj',
    agentType: 'claude',
    isCodexSubagent: false,
    logTokenCount: 10,
    ...overrides,
  }
}

describe('logMatchGate', () => {
  test('filters entries based on tokens, sessions, and activity', () => {
    const entries: LogEntrySnapshot[] = [
      makeEntry({ sessionId: null }),
      makeEntry({ sessionId: 'session-low', logPath: 'log-low', logTokenCount: 2 }),
      makeEntry({ sessionId: 'session-missing', logPath: 'log-missing' }),
      makeEntry({
        sessionId: 'session-stale',
        logPath: 'log-stale',
        mtime: 1_800_000_000_001,
      }),
      makeEntry({
        sessionId: 'session-active',
        logPath: 'log-active',
        mtime: 1_800_000_000_000,
      }),
      makeEntry({
        sessionId: 'session-invalid',
        logPath: 'log-invalid',
        mtime: 1_800_000_000_100,
      }),
    ]

    const sessions: SessionSnapshot[] = [
      {
        sessionId: 'session-stale',
        logFilePath: 'log-stale',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
      },
      {
        sessionId: 'session-active',
        logFilePath: 'log-active',
        currentWindow: '2',
        lastActivityAt: '2025-01-01T00:00:00Z',
      },
      {
        sessionId: 'session-invalid',
        logFilePath: 'log-invalid',
        currentWindow: null,
        lastActivityAt: 'not-a-date',
      },
    ]

    const needs = getEntriesNeedingMatch(entries, sessions, { minTokens: 5 })
    expect(needs.map((entry) => entry.sessionId)).toEqual([
      'session-missing',
      'session-stale',
      'session-invalid',
    ])
  })

  test('shouldRunMatching reports when work exists', () => {
    expect(shouldRunMatching([], [], { minTokens: 1 })).toBe(false)

    const entries = [makeEntry({ sessionId: 'session-match' })]
    const sessions: SessionSnapshot[] = []
    expect(shouldRunMatching(entries, sessions, { minTokens: 1 })).toBe(true)
  })
})
