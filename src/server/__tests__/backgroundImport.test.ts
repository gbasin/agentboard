import { afterEach, expect, test } from 'bun:test'
import { initDatabase, type SessionDatabase } from '../db'
import { PersistentSessions } from '../persistence/manager'
import type { SessionManager } from '../SessionManager'
import type { SessionReader } from '../sessionReads'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture() {
  const db = initDatabase({ path: ':memory:' })
  cleanup.push(() => db.close())
  let resolve!: (ids: string[]) => void
  let reject!: (error: Error) => void
  let calls = 0
  const reader: SessionReader = {
    snapshot: async () => { throw new Error('unused') },
    importCandidates: () => {
      calls++
      return new Promise((yes, no) => { resolve = yes; reject = no })
    },
  }
  const manager = new PersistentSessions(db, {} as SessionManager, 'test', undefined, (pid) => `epoch-${pid}`, 'ab', reader)
  cleanup.push(() => manager.dispose())
  manager.beforeSnapshot([], 1)
  return { db, manager, calls: () => calls, resolve: (ids: string[]) => resolve(ids), reject: (error: Error) => reject(error) }
}
function insert(db: SessionDatabase, id: string) {
  db.insertSession({ sessionId: id, logFilePath: `/logs/${id}`, projectPath: '/project',
    slug: null, agentType: 'claude', displayName: id, createdAt: '2026-01-01',
    lastActivityAt: '2026-01-01', lastUserMessage: 'original', currentWindow: null,
    isHibernating: false, lastResumeError: null, lastKnownLogSize: 1,
    isCodexExec: false, launchCommand: null })
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('background import coalesces refreshes and rechecks association and lifecycle at completion', async () => {
  const f = fixture()
  insert(f.db, 'associated')
  insert(f.db, 'changed')
  insert(f.db, 'exec')
  f.manager.observe([])
  f.manager.observe([])
  expect(f.calls()).toBe(1)
  const saved = f.manager.catalog.create({ name: 'custom', projectPath: '/project', command: '', providerId: 'associated' })
  f.db.updateSession('changed', { isHibernating: true, lastUserMessage: 'latest' })
  f.db.updateSession('exec', { isCodexExec: true })
  f.resolve(['associated', 'changed', 'exec', 'deleted'])
  await settle()
  expect(f.manager.catalog.byProvider('associated')?.id).toBe(saved.id)
  expect(f.manager.catalog.byProvider('associated')?.name).toBe('custom')
  expect(f.manager.catalog.byProvider('changed')?.state).toBe('hibernating')
  expect(f.manager.catalog.byProvider('changed')?.preview).toBe('latest')
  expect(f.manager.catalog.byProvider('exec')).toBeNull()
  f.manager.observe([])
  expect(f.calls()).toBe(2)
  f.resolve([])
  await settle()
})

test('failed import can retry; shutdown discards pending candidates', async () => {
  const f = fixture()
  insert(f.db, 'pending')
  f.manager.observe([])
  f.reject(new Error('read failed'))
  await settle()
  expect(f.manager.error).toContain('read failed')
  f.manager.observe([])
  expect(f.calls()).toBe(2)
  f.manager.dispose()
  f.resolve(['pending'])
  await settle()
  expect(f.manager.catalog.byProvider('pending')).toBeNull()
})
