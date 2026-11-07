import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type NewAgentSessionRecord, type SessionDatabase } from '../db'
import { SessionReadClient } from '../sessionReadClient'
import { SessionCatalog } from '../persistence/catalog'
import { readImportCandidates } from '../sessionReads'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-read-test-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filename = path.join(dir, 'test.db')
  const db = initDatabase({ path: filename })
  cleanup.push(() => db.close())
  new SessionCatalog(db.db, 'test')
  const reader = new SessionReadClient(filename)
  cleanup.push(() => reader.dispose())
  return { db, reader }
}

function insert(db: SessionDatabase, id: string, fields: Partial<NewAgentSessionRecord> = {}) {
  const now = new Date().toISOString()
  return db.insertSession({
    sessionId: id, logFilePath: `/logs/${id}.jsonl`, projectPath: '/project',
    slug: null, agentType: 'claude', displayName: id, createdAt: now,
    lastActivityAt: now, lastUserMessage: '🙂'.repeat(3000), currentWindow: null,
    isHibernating: false, lastResumeError: null, lastKnownLogSize: 20,
    isCodexExec: false, launchCommand: null, ...fields,
  })
}

test('worker snapshots preserve full records, ordering, keys and committed changes', async () => {
  const { db, reader } = fixture()
  insert(db, 'active', { currentWindow: 'ab:@1' })
  insert(db, 'hibernating', { isHibernating: true, lastActivityAt: '2000-01-01T00:00:00.000Z' })
  insert(db, 'old', { lastActivityAt: '2000-01-01T00:00:00.000Z' })
  insert(db, 'recent')
  const snapshot = await reader.snapshot({ maxAgeHours: 72 })
  expect(snapshot.lists).toEqual(db.getSessionLists({ maxAgeHours: 72 }))
  expect(snapshot.knownSessions).toEqual(db.getKnownSessionKeys())
  expect(snapshot.lists.history.map((row) => row.sessionId)).toEqual(['recent'])
  expect(snapshot.lists.active[0].lastUserMessage).toBe('🙂'.repeat(3000))

  // The reader must end its transaction after each request and see the next
  // committed hibernate/claim immediately, with no TTL or stale WAL snapshot.
  db.orphanSession('active', { hibernate: true })
  db.claimCurrentWindow('recent', 'ab:@1')
  const next = await reader.snapshot({ maxAgeHours: 72, paths: ['/logs/recent.jsonl', '/missing'] })
  expect(next.lists).toEqual(db.getSessionLists({ maxAgeHours: 72 }))
  expect(next.knownSessions.map((row) => row.sessionId)).toEqual(['recent'])
  const unbounded = await reader.snapshot({ paths: [] })
  expect(unbounded.lists).toEqual(db.getSessionLists())
  expect(unbounded.knownSessions).toEqual([])
})

test('worker import scan has the same limit and exclusions and sees new associations', async () => {
  const { db, reader } = fixture()
  db.db.transaction(() => {
    for (let i = 0; i < 105; i++) insert(db, `candidate-${i}`)
    insert(db, 'exec', { isCodexExec: true })
  })()
  const ids = await reader.importCandidates()
  expect(ids).toEqual(readImportCandidates(db.db))
  expect(ids).toHaveLength(100)
  const catalog = new SessionCatalog(db.db, 'test')
  catalog.create({ name: 'mapped', projectPath: '/project', command: '', providerId: ids[0] })
  const next = await reader.importCandidates()
  expect(next).not.toContain(ids[0])
  expect(next).not.toContain('exec')
})

test('SQLite lock waits stay off the event loop, fail explicitly, and can retry', async () => {
  const { db, reader } = fixture()
  insert(db, 'one')
  // Deliberate lock pressure confined to this throwaway database. Unlike
  // allocating swap, this deterministically stalls I/O without stressing prod.
  db.db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')
  let beats = 0
  const timer = setInterval(() => beats++, 10)
  try {
    await expect(reader.snapshot({})).rejects.toThrow()
    expect(beats).toBeGreaterThan(3)
  } finally {
    clearInterval(timer)
    db.db.exec('ROLLBACK')
  }
  expect((await reader.snapshot({})).lists.history).toHaveLength(1)
})

test('dispose rejects pending and future reads without applying a late response', async () => {
  const { reader } = fixture()
  const pending = reader.snapshot({})
  reader.dispose()
  await expect(pending).rejects.toThrow('disposed')
  await expect(reader.importCandidates()).rejects.toThrow('disposed')
})
