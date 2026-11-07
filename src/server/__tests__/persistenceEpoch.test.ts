/** Stable tmux identities must not create writes or contend with a writer. */
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { PersistentSessions } from '../persistence/manager'
import type { SessionManager } from '../SessionManager'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-epoch-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'fixture.db')
  const db = initDatabase({ path: dbPath })
  cleanups.push(() => db.close())
  const makeManager = (connection: SessionDatabase) => new PersistentSessions(
    connection,
    {} as SessionManager,
    'test-host',
    () => { throw new Error('No tmux commands allowed') },
    (pid) => `epoch${pid}`,
    'test-board',
  )
  return { db, dbPath, makeManager, manager: makeManager(db) }
}

test('unchanged snapshots generate no WAL frames, including after manager restart', () => {
  const { db, dbPath, manager, makeManager } = fixture()
  manager.beforeSnapshot([], 1)
  expect(db.getAppSetting('persistence_tmux_epoch')).toBe('epoch1')
  const reopened = initDatabase({ path: dbPath })
  cleanups.push(() => reopened.close())
  const restarted = makeManager(reopened)
  reopened.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0')
  for (let n = 0; n < 50; n++) restarted.beforeSnapshot([], 1)
  expect(restarted.error).toBeNull()
  expect(fs.statSync(`${dbPath}-wal`).size).toBe(0)
})

test('stable epoch reconciliation succeeds while a separate connection holds the write lock', () => {
  const { dbPath, manager } = fixture()
  manager.beforeSnapshot([], 1)
  const writer = new Database(dbPath)
  try {
    writer.exec('BEGIN IMMEDIATE')
    manager.beforeSnapshot([], 1)
    expect(manager.error).toBeNull()
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
  }
})

test('new epochs are persisted, failed writes retry, and unknown server identity does not advance epoch', () => {
  const { db, dbPath, manager } = fixture()
  manager.beforeSnapshot([], 1)
  const writer = new Database(dbPath)
  try {
    writer.exec('BEGIN IMMEDIATE')
    manager.beforeSnapshot([], 2)
    expect(manager.error).not.toBeNull()
    expect(db.getAppSetting('persistence_tmux_epoch')).toBe('epoch1')
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
  }
  manager.beforeSnapshot([], 2)
  expect(manager.error).toBeNull()
  expect(db.getAppSetting('persistence_tmux_epoch')).toBe('epoch2')
  manager.beforeSnapshot([], 0)
  expect(db.getAppSetting('persistence_tmux_epoch')).toBe('epoch2')
})
