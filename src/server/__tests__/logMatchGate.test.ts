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
    size: 1000,
    sessionId: 'session-1',
    projectPath: '/proj',
    agentType: 'claude',
    isCodexSubagent: false,
    isCodexExec: false,
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
        lastKnownLogSize: 500, // Different from entry.size (1000), so needs match
      },
      {
        sessionId: 'session-active',
        logFilePath: 'log-active',
        currentWindow: '2',
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 1000,
      },
      {
        sessionId: 'session-invalid',
        logFilePath: 'log-invalid',
        currentWindow: null,
        lastActivityAt: 'not-a-date',
        lastKnownLogSize: 500, // Different from entry.size (1000), so needs match
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

  test('codex exec sessions are always skipped (headless), but path patterns only skip orphans', () => {
    const entries: LogEntrySnapshot[] = [
      makeEntry({ sessionId: 'session-codex-exec', logPath: 'log-exec', isCodexExec: true, agentType: 'codex' }),
      makeEntry({ sessionId: 'session-tmp', logPath: 'log-tmp', projectPath: '/tmp/test-project' }),
      makeEntry({ sessionId: 'session-normal', logPath: 'log-normal' }),
    ]
    const sessions: SessionSnapshot[] = []

    // Codex exec sessions are always skipped (they're headless by definition)
    // Path-based patterns (like /tmp/*) only skip orphan sessions, not new sessions
    const needs = getEntriesNeedingMatch(entries, sessions, {
      minTokens: 0,
      skipMatchingPatterns: ['<codex-exec>', '/tmp/*'],
    })
    expect(needs.map((e) => e.sessionId)).toEqual(['session-tmp', 'session-normal'])
  })

  test('codex exec sessions are skipped even without skip patterns configured', () => {
    const entries: LogEntrySnapshot[] = [
      makeEntry({ sessionId: 'session-codex-exec', logPath: 'log-exec', isCodexExec: true, agentType: 'codex' }),
      makeEntry({ sessionId: 'session-normal', logPath: 'log-normal' }),
    ]
    const sessions: SessionSnapshot[] = []

    // Codex exec sessions are always skipped regardless of skipMatchingPatterns
    const needs = getEntriesNeedingMatch(entries, sessions, {
      minTokens: 0,
      skipMatchingPatterns: [],
    })
    expect(needs.map((e) => e.sessionId)).toEqual(['session-normal'])
  })

  test('skips orphan sessions matching codex-exec pattern', () => {
    const entries: LogEntrySnapshot[] = [
      makeEntry({
        sessionId: 'session-orphan-exec',
        logPath: 'log-orphan-exec',
        isCodexExec: true,
        agentType: 'codex',
        mtime: 1_800_000_000_001,
      }),
      makeEntry({
        sessionId: 'session-orphan-normal',
        logPath: 'log-orphan-normal',
        mtime: 1_800_000_000_001,
      }),
    ]
    const sessions: SessionSnapshot[] = [
      {
        sessionId: 'session-orphan-exec',
        logFilePath: 'log-orphan-exec',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 500, // Different size to trigger re-match check
      },
      {
        sessionId: 'session-orphan-normal',
        logFilePath: 'log-orphan-normal',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 500, // Different size to trigger re-match
      },
    ]

    const needs = getEntriesNeedingMatch(entries, sessions, {
      minTokens: 0,
      skipMatchingPatterns: ['<codex-exec>'],
    })
    // Only the normal orphan should need matching (codex-exec is always skipped)
    expect(needs.map((e) => e.sessionId)).toEqual(['session-orphan-normal'])
  })

  test('skips orphan sessions in temp directories when pattern is set', () => {
    const entries: LogEntrySnapshot[] = [
      makeEntry({
        sessionId: 'session-orphan-tmp',
        logPath: 'log-orphan-tmp',
        projectPath: '/tmp/test-project',
        mtime: 1_800_000_000_001,
      }),
      makeEntry({
        sessionId: 'session-orphan-normal',
        logPath: 'log-orphan-normal',
        projectPath: '/Users/test/project',
        mtime: 1_800_000_000_001,
      }),
    ]
    const sessions: SessionSnapshot[] = [
      {
        sessionId: 'session-orphan-tmp',
        logFilePath: 'log-orphan-tmp',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 500, // Different size
      },
      {
        sessionId: 'session-orphan-normal',
        logFilePath: 'log-orphan-normal',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 500, // Different size to trigger re-match
      },
    ]

    const needs = getEntriesNeedingMatch(entries, sessions, {
      minTokens: 0,
      skipMatchingPatterns: ['/tmp/*'],
    })
    // Only the normal orphan should need matching
    expect(needs.map((e) => e.sessionId)).toEqual(['session-orphan-normal'])
  })

  test('codex-exec pattern is case-insensitive', () => {
    const entries: LogEntrySnapshot[] = [
      makeEntry({
        sessionId: 'session-orphan-exec',
        logPath: 'log-orphan-exec',
        isCodexExec: true,
        agentType: 'codex',
        mtime: 1_800_000_000_001,
      }),
    ]
    const sessions: SessionSnapshot[] = [
      {
        sessionId: 'session-orphan-exec',
        logFilePath: 'log-orphan-exec',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 500, // Different size
      },
    ]

    // Should work with different case variations - codex exec is always skipped
    for (const pattern of ['<codex-exec>', '<CODEX-EXEC>', '<Codex-Exec>']) {
      const needs = getEntriesNeedingMatch(entries, sessions, {
        minTokens: 0,
        skipMatchingPatterns: [pattern],
      })
      expect(needs).toEqual([])
    }
  })

  test('pattern matching is case-insensitive for paths (orphans only)', () => {
    const entries: LogEntrySnapshot[] = [
      makeEntry({ sessionId: 'session-tmp', logPath: 'log-tmp', projectPath: '/TMP/Test', mtime: 1_800_000_000_001 }),
      makeEntry({ sessionId: 'session-normal', logPath: 'log-normal', projectPath: '/Users/test', mtime: 1_800_000_000_001 }),
    ]
    // Must be orphan sessions (with session records but no currentWindow) for skip patterns to apply
    const sessions: SessionSnapshot[] = [
      {
        sessionId: 'session-tmp',
        logFilePath: 'log-tmp',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 500, // Different size
      },
      {
        sessionId: 'session-normal',
        logFilePath: 'log-normal',
        currentWindow: null,
        lastActivityAt: '2025-01-01T00:00:00Z',
        lastKnownLogSize: 500, // Different size to trigger re-match
      },
    ]

    const needs = getEntriesNeedingMatch(entries, sessions, {
      minTokens: 0,
      skipMatchingPatterns: ['/tmp/*'],
    })
    expect(needs.map((e) => e.sessionId)).toEqual(['session-normal'])
  })
})
