import { afterEach, expect, test } from 'bun:test'
import { initDatabase, type NewAgentSessionRecord } from '../db'
import { OwnershipMatcher } from '../ownership/matcher'
import { createStartupLifecycle, type VerificationDecision } from '../startupVerify'
import type { Session } from '../../shared/types'
import { OwnershipObserver } from '../ownership/observer'
import type { Observation, OwnershipWindow } from '../ownership/probe'

const databases: ReturnType<typeof initDatabase>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function fixture() {
  const db = initDatabase({ path: ':memory:' }); databases.push(db)
  const windows: OwnershipWindow[] = [{ tmuxWindow: 'ab:@1', agentType: 'codex', agentboardTags: { runId: 'run', serverPid: 1 } }]
  const result: Observation = { window: 'ab:@1', pane: '%1', agent: 'codex', status: 'resolved', pid: 10, started: 'start', sessionId: 'new', transcript: '/new.jsonl' }
  const changed: unknown[][] = []; const missing: Observation[] = []
  const matcher = new OwnershipMatcher({ db, windows: () => windows,
    changed: (...args) => { changed.push(args); windows[0].agentSessionId = args[0] },
    missing: result => { missing.push(result) },
  })
  function insert(id = 'new', patch: Partial<NewAgentSessionRecord> = {}) {
    db.insertSession({ sessionId: id, logFilePath: `/${id}.jsonl`, agentType: 'codex',
      projectPath: '/project', slug: null, displayName: id, createdAt: '2026-01-01', lastActivityAt: '2026-01-01',
      lastUserMessage: 'tes', currentWindow: null, isHibernating: false, lastResumeError: null,
      lastKnownLogSize: 100, isCodexExec: false, launchCommand: null, ...patch })
  }
  return { db, windows, result, matcher, insert, changed, missing }
}

test('matches an idle short-prompt transcript without reading scrollback or log growth', () => {
  const f = fixture(); f.insert(); f.matcher.accept(f.result, f.windows[0])
  expect(f.db.getSessionById('new')?.currentWindow).toBe('ab:@1')
  expect(f.changed).toEqual([['new', 'ab:@1', null]])
  expect(f.matcher.allows('ab:@1', 'wrong')).toBe(false)
  expect(f.matcher.allows('ab:@1', 'new')).toBe(true)
})

test('switches sessions atomically and releases the old claim without hibernating it', () => {
  const f = fixture(); f.insert(); f.insert('old', { currentWindow: 'ab:@1' }); f.windows[0].agentSessionId = 'old'
  f.matcher.accept(f.result, f.windows[0])
  expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('new')
  expect(f.db.getSessionById('old')?.isHibernating).toBe(false)
  expect(f.changed).toEqual([['new', 'ab:@1', 'old']])
})

test('failed claim rolls back release of the previous session', () => {
  const f = fixture(); f.insert(); f.insert('old', { currentWindow: 'ab:@1' }); f.windows[0].agentSessionId = 'old'
  f.db.claimCurrentWindow = () => null
  expect(() => f.matcher.accept(f.result, f.windows[0])).toThrow()
  expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('old')
  expect(f.changed).toEqual([])
})

test('unknown transcript preserves the previous match and requests discovery', () => {
  const f = fixture(); f.insert('old', { currentWindow: 'ab:@1' }); f.windows[0].agentSessionId = 'old'
  f.matcher.accept(f.result, f.windows[0])
  expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('old')
  expect(f.missing).toEqual([f.result])
  f.insert(); f.matcher.accept(f.result, f.windows[0])
  expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('new')
})

test('does not steal a target from another pane', () => {
  const f = fixture(); f.insert('new', { currentWindow: 'ab:@2' })
  f.matcher.accept(f.result, f.windows[0])
  expect(f.db.getSessionByWindow('ab:@2')?.sessionId).toBe('new')
  expect(f.db.getSessionByWindow('ab:@1')).toBeNull()
})

test('rejects wrong provider, exec and transcript identities', () => {
  for (const patch of [{ agentType: 'claude' as const }, { isCodexExec: true }, { logFilePath: '/wrong.jsonl' }]) {
    const f = fixture(); f.insert('new', patch); f.matcher.accept(f.result, f.windows[0])
    expect(f.db.getSessionByWindow('ab:@1')).toBeNull()
  }
})

test('does not undo stop or wake intent on either session', () => {
  for (const id of ['old', 'new']) for (const patch of [{ isHibernating: true }, { wakeStartedAt: '2026-10-18' }]) {
    const f = fixture(); f.insert(); f.insert('old', { currentWindow: 'ab:@1' }); f.windows[0].agentSessionId = 'old'
    f.db.updateSession(id, patch); f.matcher.accept(f.result, f.windows[0])
    expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('old')
  }
})

test('database changes ahead of registry invalidate the probe', () => {
  const f = fixture(); f.insert(); f.insert('other', { currentWindow: 'ab:@1' })
  f.matcher.accept(f.result, f.windows[0])
  expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('other')
  expect(f.matcher.get(f.windows[0])).toBeUndefined()
})

test('inspection failure preserves a confirmed association and evidence', async () => {
  const f = fixture(); f.insert(); f.matcher.accept(f.result, f.windows[0])
  f.matcher.accept({ ...f.result, status: 'unresolved', reason: 'ambiguous' }, f.windows[0])
  const observer = new OwnershipObserver({ windows: () => f.windows, probe: async () => { throw new Error('lsof failed') },
    accept: (result, window) => f.matcher.accept(result, window), log: () => {} })
  await observer.observe()
  expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('new')
  expect(f.matcher.get(f.windows[0])?.sessionId).toBe('new')
})

test('a replaced run or tmux server cannot reuse ownership evidence', () => {
  for (const tags of [{ runId: 'next', serverPid: 1 }, { runId: 'run', serverPid: 2 }]) {
    const f = fixture(); f.insert(); f.matcher.accept(f.result, f.windows[0])
    f.windows[0].agentboardTags = tags
    expect(f.matcher.get(f.windows[0])).toBeUndefined()
    expect(f.matcher.allows('ab:@1', 'other')).toBe(true)
  }
})

test('a late probe cannot switch a replaced run', async () => {
  const f = fixture(); f.insert()
  const observer = new OwnershipObserver({ windows: () => f.windows, probe: async () => {
    f.windows[0].agentboardTags!.runId = 'new-run'; return [f.result]
  }, accept: (result, window) => f.matcher.accept(result, window), log: () => {} })
  await observer.observe()
  expect(f.db.getSessionByWindow('ab:@1')).toBeNull()
})

test('Claude registry evidence binds a known Claude transcript without Codex path assumptions', () => {
  const f = fixture(); f.windows[0].agentType = 'claude'; f.insert('new', { agentType: 'claude' })
  f.matcher.accept({ ...f.result, agent: 'claude', transcript: undefined }, f.windows[0])
  expect(f.db.getSessionByWindow('ab:@1')?.sessionId).toBe('new')
})


test('startup verification accepts ownership with an unrelated window name and no scrollback', async () => {
  const f = fixture(); f.insert(); f.matcher.accept(f.result, f.windows[0])
  const window: Session = { ...f.windows[0], id: 'ab:@1', agentType: 'codex', name: 'renamed', source: 'managed',
    agentboardTags: { boardId: 'board', runId: 'run', serverPid: 1 },
    projectPath: '/project', status: 'waiting', createdAt: '2026-01-01', lastActivity: '2026-01-01' }
  let decisions: Map<string, VerificationDecision> | undefined
  const lifecycle = createStartupLifecycle({
    config: { tmuxSession: 'ab', tmuxTimeoutMs: 1, pruneWsSessions: false, logMatchWorker: false, rgThreads: 1 },
    db: f.db, registry: { getAll: () => [window], replaceSessions: () => {} },
    sessionManager: { scrubLeakedGlobalEnvironmentAsync: async () => [] },
    hasOwnership: window => Boolean(f.matcher.get(window)), sockets: new Set(), canPruneWsSessions: false,
    hydrateSessionsWithAgentSessions: (sessions, options) => { decisions = options?.precomputedVerifications; return sessions },
    applyForceWorkingOverrides: sessions => sessions, mergeRemoteSessions: sessions => sessions, updateDormantAgentSessions: () => {},
  })
  await lifecycle.completeStartupVerification()
  expect(decisions?.get('new')).toEqual({ verification: { status: 'verified', bestMatch: null }, nameMatches: false })
})


test('ownership claims preserve launch metadata without replacing an existing resume command', () => {
  for (const command of [null, 'codex --profile custom']) {
    const f = fixture(); f.insert('new', { launchCommand: command })
    f.windows[0].name = 'cool-key'; f.windows[0].command = 'codex'
    f.matcher.accept(f.result, f.windows[0])
    expect(f.db.getSessionById('new')).toMatchObject({ displayName: 'cool-key', launchCommand: command ?? 'codex' })
  }
})
