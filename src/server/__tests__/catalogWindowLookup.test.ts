/** Window lookup plans and identity invariants across catalog upgrades. */
import { afterEach, expect, test } from 'bun:test'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionCatalog } from '../persistence/catalog'
import { sessionSelect } from '../persistence/historyQuery'

const databases: SessionDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const db = initDatabase({ path: ':memory:' })
  databases.push(db)
  return { db: db.db, catalog: new SessionCatalog(db.db, 'host-a') }
}

function bind(catalog: SessionCatalog, name: string, window: string, epoch: string) {
  const session = catalog.create({ name, projectPath: '/project', command: 'sh' })
  const run = catalog.beginRun(session.id, `launch-${name}`)
  catalog.bind(session.id, run.id, window, epoch)
  return session.id
}

test('epoch-free lookups constrain both host and window on fresh and upgraded catalogs', () => {
  const { db, catalog } = setup()
  const assertPlan = () => {
    const statement = db.prepare(`EXPLAIN QUERY PLAN ${sessionSelect} WHERE host_id=? AND current_window=?`)
    const plan = statement.all('host-a', 'ab:@missing') as { detail: string }[]
    statement.finalize()
    expect(plan.some(({ detail }) => detail.includes('(host_id=? AND current_window=?)'))).toBe(true)
  }
  assertPlan()
  // Existing catalogs already passed the schema version gate.
  db.exec('DROP INDEX board_window_lookup')
  const id = bind(catalog, 'original', 'ab:@1', 'epoch-1')
  const before = db.query('SELECT * FROM board_sessions').all()
  const reopened = new SessionCatalog(db, 'host-a')
  new SessionCatalog(db, 'host-a') // Repeated startup must be idempotent.
  assertPlan()
  expect(db.query('SELECT * FROM board_sessions').all()).toEqual(before)
  expect(reopened.byWindow('ab:@1')?.id).toBe(id)
})

test('window lookups preserve host and epoch isolation and exclude unbound sessions', () => {
  const { db, catalog } = setup()
  const other = new SessionCatalog(db, 'host-b')
  const a = bind(catalog, 'a', 'ab:@1', 'epoch-1')
  const b = bind(other, 'b', 'ab:@1', 'epoch-1')
  expect(catalog.byWindow('ab:@1')?.id).toBe(a)
  expect(other.byWindow('ab:@1')?.id).toBe(b)
  expect(catalog.byWindow('ab:@missing')).toBeNull()
  expect(catalog.byWindow('ab:@1', 'wrong-epoch')).toBeNull()

  // The new lookup index must not prohibit window reuse across epochs.
  const next = bind(catalog, 'next', 'ab:@1', 'epoch-2')
  expect(catalog.byWindow('ab:@1', 'epoch-1')?.id).toBe(a)
  expect(catalog.byWindow('ab:@1', 'epoch-2')?.id).toBe(next)
  expect(() => bind(catalog, 'duplicate', 'ab:@1', 'epoch-2')).toThrow()
  catalog.transition(a, 'archived')
  expect(catalog.byWindow('ab:@1', 'epoch-1')).toBeNull()
  expect(catalog.byWindow('ab:@1')?.id).toBe(next)
  expect(catalog.get(a)?.state).toBe('archived')
})
