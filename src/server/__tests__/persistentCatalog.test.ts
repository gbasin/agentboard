import { afterEach, describe, expect, test } from 'bun:test'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionCatalog } from '../persistence/catalog'
import { PersistentSessions } from '../persistence/manager'
import type { SessionManager } from '../SessionManager'
import type { Session } from '../../shared/types'

const databases: SessionDatabase[] = []
function setup() {
  const db = initDatabase({ path: ':memory:' })
  databases.push(db)
  return { db, catalog: new SessionCatalog(db.db, 'host-test') }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const input = {
  name: 'A-Runtime',
  projectPath: '/project',
  command: 'sh',
  lastActivityAt: '2020-01-01T00:00:00.000Z',
}

describe('durable catalog', () => {
  test('saves a session before any provider log or process exists', () => {
    const { db, catalog } = setup()
    const created = catalog.create(input)
    const reopened = new SessionCatalog(db.db, 'host-test')
    expect(reopened.get(created.id)?.name).toBe('A-Runtime')
    expect(reopened.get(created.id)?.providerId).toBeNull()
    expect(reopened.history().sessions).toHaveLength(1)
  })
  test('keeps old names searchable and archives without deleting', () => {
    const { catalog } = setup()
    const saved = catalog.create(input)
    catalog.rename(saved.id, 'A-Updated')
    catalog.transition(saved.id, 'archived')
    catalog.pin(saved.id, true)
    expect(
      catalog.history({ q: 'A-Runtime', pinned: true }).sessions[0]?.name
    ).toBe('A-Updated')
    expect(catalog.history({ hours: 24 }).sessions).toHaveLength(0)
    expect(catalog.events(saved.id).map((e) => e.kind)).toContain('renamed')
  })
  test('launch requests are idempotent and concurrent requests cannot create two open runs', () => {
    const { catalog } = setup()
    const saved = catalog.create(input)
    const run = catalog.beginRun(saved.id, 'request-1')
    expect(catalog.beginRun(saved.id, 'request-1')).toEqual({
      id: run.id,
      reused: true,
    })
    expect(() => catalog.beginRun(saved.id, 'request-2')).toThrow(
      'already running or starting'
    )
    catalog.bind(saved.id, run.id, 'ab:@1', 'epoch1')
    catalog.transition(saved.id, 'interrupted')
    const second = catalog.beginRun(saved.id, 'request-2')
    expect(second.id).not.toBe(run.id)
    expect(() => catalog.bind(saved.id, run.id, 'ab:@1', 'epoch1')).toThrow(
      'no longer current'
    )
  })
  test('history pages cover all equal-time records exactly once', () => {
    const { catalog } = setup()
    for (let n = 0; n < 7; n++) catalog.create({ ...input, name: `A-${n}` })
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = catalog.history({ limit: 2, cursor })
      ids.push(...page.sessions.map((s) => s.id))
      cursor = page.nextCursor || undefined
    } while (cursor)
    expect(ids).toHaveLength(7)
    expect(new Set(ids).size).toBe(7)
    expect(() => catalog.history({ cursor: 'invalid' })).toThrow(
      'Invalid history cursor'
    )
    expect(catalog.history({ q: '%' }).sessions).toHaveLength(0)
  })
  test('merges a discovery import into its managed session', () => {
    const { catalog } = setup()
    catalog.create({
      ...input,
      name: 'Imported',
      providerId: 'provider',
      origin: 'imported',
      pinned: true,
    })
    const managed = catalog.create(input)
    catalog.associate(managed.id, 'provider', 'codex')
    expect(catalog.history().sessions).toHaveLength(1)
    expect(catalog.get(managed.id)?.name).toBe('A-Runtime')
    expect(catalog.get(managed.id)?.pinned).toBe(true)
  })
})

describe('recovery reconciliation', () => {
  function fixture() {
    const { db } = setup()
    // The injected identity feeds the mutation paths (launch/resume/stop);
    // beforeSnapshot reads tags from the enumerated sessions instead.
    let snapshot = {
      epoch: 'epoch1',
      windows: new Map<string, { boardId: string; runId: string }>(),
    }
    const calls: string[] = []
    const manager = {
      ensureSession() {},
      listWindows: () => [live],
      setWindowOption() {},
      renameWindow() {},
      killWindow(w: string) {
        calls.push(w)
      },
    } as unknown as SessionManager
    const persistence = new PersistentSessions(
      db,
      manager,
      'host-test',
      () => snapshot,
      (pid) => `epoch${pid}`
    )
    const saved = persistence.catalog.create(input)
    const run = persistence.catalog.beginRun(saved.id)
    persistence.catalog.bind(saved.id, run.id, 'ab:@1', 'epoch1')
    snapshot.windows.set('ab:@1', { boardId: saved.id, runId: run.id })
    const live: Session = {
      id: 'ab:@1',
      name: input.name,
      tmuxWindow: 'ab:@1',
      projectPath: '/project',
      status: 'unknown',
      createdAt: '2020-01-01',
      lastActivity: '2020-01-01',
      source: 'managed',
      agentboardTags: { boardId: saved.id, runId: run.id, serverPid: 1 },
    }
    return {
      persistence,
      saved,
      run,
      live,
      calls,
      setSnapshot: (value: typeof snapshot) => {
        snapshot = value
      },
      setTags: (boardId: string, runId: string, serverPid = 1) => {
        live.agentboardTags = { boardId, runId, serverPid }
      },
    }
  }
  test('a reliable empty replacement server interrupts sessions without killing windows', () => {
    const { persistence, saved, calls } = fixture()
    persistence.beforeSnapshot([], 2)
    expect(persistence.catalog.get(saved.id)?.state).toBe('interrupted')
    expect(calls).toEqual([])
  })
  test('an old launch request cannot return a later run of the same session', () => {
    const { persistence, saved, setSnapshot } = fixture()
    persistence.catalog.transition(saved.id, 'interrupted')
    const old = persistence.catalog.beginRun(saved.id, 'old-request')
    persistence.catalog.bind(saved.id, old.id, 'ab:@1', 'epoch1')
    persistence.catalog.transition(saved.id, 'interrupted')
    const current = persistence.catalog.beginRun(saved.id, 'new-request')
    persistence.catalog.bind(saved.id, current.id, 'ab:@1', 'epoch1')
    setSnapshot({
      epoch: 'epoch1',
      windows: new Map([['ab:@1', { boardId: saved.id, runId: current.id }]]),
    })
    expect(() =>
      persistence.launch('/project', 'A', 'sh', {
        boardId: saved.id,
        operationId: 'old-request',
      })
    ).toThrow('already exists')
    expect(persistence.catalog.get(saved.id)?.lastRunId).toBe(current.id)
  })
  test('an enumeration without a server pid does not reconcile a live session', () => {
    const { persistence, saved } = fixture()
    persistence.beforeSnapshot([])
    expect(persistence.catalog.get(saved.id)?.state).toBe('running')
  })
  test('reused window IDs do not claim or kill another run', () => {
    const { persistence, saved, live, calls, setTags } = fixture()
    setTags('another', 'other', 2)
    persistence.beforeSnapshot([live])
    expect(persistence.catalog.get(saved.id)?.state).toBe('interrupted')
    expect(calls).toEqual([])
  })
  test('adopts a tagged pane created before the database binding was saved', () => {
    const { persistence, saved, live, setTags } = fixture()
    persistence.catalog.transition(saved.id, 'interrupted')
    const run = persistence.catalog.beginRun(saved.id)
    setTags(saved.id, run.id, 2)
    persistence.beforeSnapshot([live])
    expect(persistence.catalog.get(saved.id)?.state).toBe('running')
    expect(persistence.catalog.get(saved.id)?.epoch).toBe('epoch2')
  })
  test('finishes a persisted hibernation intent after a backend crash', () => {
    const { persistence, saved, live, calls } = fixture()
    persistence.db.db
      .query('UPDATE board_sessions SET requested_state=? WHERE id=?')
      .run('hibernating', saved.id)
    const sessions = [live]
    persistence.beforeSnapshot(sessions)
    expect(calls).toEqual(['ab:@1'])
    expect(sessions).toHaveLength(0)
    expect(persistence.catalog.get(saved.id)?.state).toBe('hibernating')
  })
})
