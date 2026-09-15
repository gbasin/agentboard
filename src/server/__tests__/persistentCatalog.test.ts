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
  test('keeps workspace membership across catalog reopen', () => {
    const { catalog, db } = setup()
    const saved = catalog.create(input)
    const workspace = catalog.saveWorkspace('Team A', [saved.id, saved.id])
    expect(new SessionCatalog(db.db, 'host-test').workspaces()[0]).toEqual({
      ...workspace,
      sessionIds: [saved.id],
    })
    expect(() => catalog.saveWorkspace('Bad', ['absent'])).toThrow(
      'missing session'
    )
  })
  test('merges a discovery import into its managed session without losing workspace membership', () => {
    const { catalog } = setup()
    const imported = catalog.create({
      ...input,
      name: 'Imported',
      providerId: 'provider',
      origin: 'imported',
      pinned: true,
    })
    const workspace = catalog.saveWorkspace('Team', [imported.id])
    const managed = catalog.create(input)
    catalog.associate(managed.id, 'provider', 'codex')
    expect(catalog.history().sessions).toHaveLength(1)
    expect(catalog.get(managed.id)?.name).toBe('A-Runtime')
    expect(catalog.get(managed.id)?.pinned).toBe(true)
    expect(
      catalog.workspaces().find((w) => w.id === workspace.id)?.sessionIds
    ).toEqual([managed.id])
  })
})

describe('recovery reconciliation', () => {
  function fixture() {
    const { db } = setup()
    let snapshot = {
      epoch: 'epoch1',
      windows: new Map<string, { boardId: string; runId: string }>(),
    }
    const calls: string[] = []
    const manager = {
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
      () => snapshot
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
    }
  }
  test('a reliable empty replacement server interrupts sessions without killing windows', () => {
    const { persistence, saved, calls, setSnapshot } = fixture()
    setSnapshot({ epoch: 'epoch2', windows: new Map() })
    persistence.beforeSnapshot([])
    expect(persistence.catalog.get(saved.id)?.state).toBe('interrupted')
    expect(calls).toEqual([])
  })
  test('a transient empty worker result does not erase a live session', () => {
    const { persistence, saved } = fixture()
    persistence.beforeSnapshot([])
    expect(persistence.catalog.get(saved.id)?.state).toBe('running')
  })
  test('reused window IDs do not claim or kill another run', () => {
    const { persistence, saved, live, calls, setSnapshot } = fixture()
    setSnapshot({
      epoch: 'epoch2',
      windows: new Map([['ab:@1', { boardId: 'another', runId: 'other' }]]),
    })
    persistence.beforeSnapshot([live])
    expect(persistence.catalog.get(saved.id)?.state).toBe('interrupted')
    expect(calls).toEqual([])
  })
  test('adopts a tagged pane created before the database binding was saved', () => {
    const { persistence, saved, live, setSnapshot } = fixture()
    persistence.catalog.transition(saved.id, 'interrupted')
    const run = persistence.catalog.beginRun(saved.id)
    setSnapshot({
      epoch: 'epoch2',
      windows: new Map([['ab:@1', { boardId: saved.id, runId: run.id }]]),
    })
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
