import { afterEach, expect, test } from 'bun:test'
import { initDatabase, type SessionDatabase } from '../db'
import { PersistentSessions } from '../persistence/manager'
import type { SessionManager } from '../SessionManager'
import type { Session } from '../../shared/types'
import type { TmuxIdentity } from '../persistence/tmuxIdentity'

const databases: SessionDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = initDatabase({ path: ':memory:' })
  databases.push(db)
  let reads = 0
  let unavailable = false
  const fresh: TmuxIdentity = { epoch: 'epoch1', windows: new Map() }
  const persistence = new PersistentSessions(db, {
    setWindowOption() {}, renameWindow() {},
    killWindow() { throw new Error('reconciliation must not kill a window') },
  } as unknown as SessionManager, 'host', () => {
    reads++
    if (unavailable) throw new Error('tmux unavailable')
    return fresh
  }, pid => `epoch${pid}`, 'ab')
  const saved = persistence.catalog.create({ name: 'ike ai', projectPath: '/project', command: 'claude' })
  const run = persistence.catalog.beginRun(saved.id)
  persistence.catalog.bind(saved.id, run.id, 'ab:@1', 'epoch1')
  db.insertSession({
    sessionId: 'conv', logFilePath: '/logs/conv.jsonl', projectPath: '/project',
    agentType: 'claude', displayName: 'ike ai', slug: null,
    createdAt: '2026-10-28', lastActivityAt: '2026-10-28', lastUserMessage: null,
    currentWindow: 'ab:@1', isHibernating: false, lastResumeError: null,
    wakeStartedAt: null, lastKnownLogSize: null, isCodexExec: false, launchCommand: 'claude',
  })
  persistence.catalog.associate(saved.id, 'conv', 'claude')
  fresh.windows.set('ab:@1', { boardId: saved.id, runId: run.id })
  const live: Session = {
    id: 'ab:@1', tmuxWindow: 'ab:@1', name: 'ike ai', projectPath: '/project',
    status: 'waiting', source: 'managed', createdAt: '2026-10-28', lastActivity: '2026-10-28',
    agentboardTags: { boardId: saved.id, runId: run.id, serverPid: 1 },
  }
  return { db, persistence, saved, run, fresh, live,
    readCount: () => reads, failRead: () => { unavailable = true } }
}

test('a partial refresh cannot orphan a running conversation or create a replacement run', () => {
  const { db, persistence, saved, run, live, readCount } = fixture()
  persistence.beforeSnapshot([], 1)
  expect(persistence.catalog.get(saved.id)?.state).toBe('running')
  expect(db.getSessionById('conv')?.currentWindow).toBe('ab:@1')
  expect(db.getSessionById('conv')?.isHibernating).toBe(false)
  persistence.beforeSnapshot([live], 1)
  persistence.observe([live])
  expect(persistence.catalog.get(saved.id)?.lastRunId).toBe(run.id)
  expect(persistence.catalog.history().sessions).toHaveLength(1)
  expect(readCount()).toBe(1)
})

test('a stale identity is replaced before observation can create a duplicate catalog entry', () => {
  const { db, persistence, saved, live, readCount } = fixture()
  live.agentboardTags = { boardId: 'unknown-board', runId: 'old-run', serverPid: 1 }
  persistence.beforeSnapshot([live], 1)
  persistence.observe([live])
  expect(persistence.catalog.get(saved.id)?.state).toBe('running')
  expect(db.getSessionById('conv')?.currentWindow).toBe('ab:@1')
  expect(persistence.catalog.history().sessions).toHaveLength(1)
  expect(live.boardSessionId).toBe(saved.id)
  expect(readCount()).toBe(1)
})

test('an unavailable confirmation preserves state and skips observation', () => {
  const { db, persistence, saved, live, failRead } = fixture()
  failRead()
  live.agentboardTags = { boardId: 'unknown-board', runId: 'other', serverPid: 1 }
  persistence.beforeSnapshot([live], 1)
  persistence.observe([live])
  expect(persistence.catalog.get(saved.id)?.state).toBe('running')
  expect(db.getSessionById('conv')?.isHibernating).toBe(false)
  expect(persistence.catalog.history().sessions).toHaveLength(1)
  expect(persistence.error).toContain('tmux unavailable')
})

test('a confirmed disappearance still interrupts and releases the conversation', () => {
  const { db, persistence, saved, fresh } = fixture()
  fresh.windows.clear()
  persistence.beforeSnapshot([], 1)
  expect(persistence.catalog.get(saved.id)?.state).toBe('interrupted')
  expect(db.getSessionById('conv')?.currentWindow).toBeNull()
})

test('a confirmed replacement still releases the old claim', () => {
  const { db, persistence, saved, fresh, live } = fixture()
  fresh.windows.set('ab:@1', { boardId: 'replacement', runId: 'replacement-run' })
  live.agentboardTags = { ...fresh.windows.get('ab:@1')!, serverPid: 1 }
  persistence.beforeSnapshot([live], 1)
  expect(persistence.catalog.get(saved.id)?.state).toBe('interrupted')
  expect(db.getSessionById('conv')?.currentWindow).toBeNull()
})

test('a restart during confirmation defers reconciliation until a consistent refresh', () => {
  const { db, persistence, saved, fresh } = fixture()
  fresh.epoch = 'epoch2'
  fresh.windows.clear()
  persistence.beforeSnapshot([], 1)
  expect(persistence.catalog.get(saved.id)?.state).toBe('running')
  expect(db.getSessionById('conv')?.currentWindow).toBe('ab:@1')
  persistence.beforeSnapshot([], 2)
  expect(persistence.catalog.get(saved.id)?.state).toBe('interrupted')
  expect(db.getSessionById('conv')?.currentWindow).toBeNull()
})

test('ordinary refreshes require no additional identity reads', () => {
  const { persistence, live, readCount } = fixture()
  for (let n = 0; n < 5; n++) {
    persistence.beforeSnapshot([live], 1)
    persistence.observe([live])
  }
  expect(readCount()).toBe(0)
})
