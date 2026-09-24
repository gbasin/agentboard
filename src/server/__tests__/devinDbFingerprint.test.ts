// WAL-reset coverage for devinDbFingerprint: after a checkpoint restarts the
// WAL, later commits overwrite frames inside the old WAL size, so only the
// -shm WAL-index header changes deterministically.
import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { devinDbFingerprint } from '../devinDbFingerprint'
import { syncDevinSessions } from '../devinSync'
import {
  addMessage,
  addSession,
  createDevinDb,
  paths,
  readLines,
  useDevinSyncFixture,
} from './devinSyncFixture'

useDevinSyncFixture()

function fingerprint(): string {
  const value = devinDbFingerprint(paths.dbPath)
  if (value === null) throw new Error('fingerprint unexpectedly uncertain')
  return value
}

function parts(fingerprint: string) {
  const [db, wal, shm] = fingerprint.split('|')
  const [, walSize, , walHeader] = wal.slice('wal='.length).split(':')
  return { db, walSize, walHeader, shm }
}

describe('devinDbFingerprint', () => {
  test('changes on a commit after WAL reset even when WAL size/header do not', () => {
    const db = createDevinDb()
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = -1')
      addSession(db, 'r', '/p', null)
      for (let i = 0; i < 20; i++) addMessage(db, 'r', 'user', `bulk ${i} ${'x'.repeat(3000)}`)
      db.exec('PRAGMA wal_checkpoint(RESTART)')

      addMessage(db, 'r', 'assistant', 'commit A')
      const afterA = fingerprint()
      expect(syncDevinSessions(paths.outDir)?.rewritten).toBe(1)

      addMessage(db, 'r', 'assistant', 'commit B')
      const afterB = fingerprint()

      // The WAL alone cannot tell A from B (mtime aside, which is coarse on
      // Linux): same size, same header. The -shm header must differ.
      expect(parts(afterB).walSize).toBe(parts(afterA).walSize)
      expect(parts(afterB).walHeader).toBe(parts(afterA).walHeader)
      expect(parts(afterB).shm).not.toBe(parts(afterA).shm)
      expect(afterB).not.toBe(afterA)

      expect(syncDevinSessions(paths.outDir)?.appended).toBe(1)
      const last = readLines(path.join(paths.outDir, 'r.jsonl')).at(-1)
      expect((last?.message as { content: string }).content).toBe('commit B')
    } finally {
      db.close()
    }
  })

  test('uncertain reads return null; absent WAL/shm are certain', () => {
    const db = createDevinDb()
    addSession(db, 'u', '/p', null)
    db.close()
    // Rollback-journal db: no -wal/-shm files, still a certain fingerprint.
    expect(fingerprint()).toContain('wal=absent|shm=absent')

    const readSpy = spyOn(fs, 'readSync').mockImplementation(() => 0)
    try {
      expect(devinDbFingerprint(paths.dbPath)).toBeNull()
    } finally {
      readSpy.mockRestore()
    }
    const readErrorSpy = spyOn(fs, 'readSync').mockImplementation(() => {
      throw new Error('EIO')
    })
    try {
      expect(devinDbFingerprint(paths.dbPath)).toBeNull()
    } finally {
      readErrorSpy.mockRestore()
    }
  })

  test('an uncertain fingerprint forces SQL and is not stored', () => {
    const db = createDevinDb()
    addSession(db, 'v', '/p', null)
    addMessage(db, 'v', 'user', 'hi')
    db.close()
    syncDevinSessions(paths.outDir)

    const statePath = path.join(paths.outDir, '.sync-state.json')
    const readSpy = spyOn(fs, 'readSync').mockImplementation(() => 0)
    const prepareSpy = spyOn(SQLiteDatabase.prototype, 'prepare')
    try {
      const result = syncDevinSessions(paths.outDir)
      expect(result).toEqual({ sessions: 1, rewritten: 0, appended: 0, removed: 0 })
      expect(prepareSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      prepareSpy.mockRestore()
      readSpy.mockRestore()
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    expect(state.dbFingerprint).toBeUndefined()

    // Next certain read cannot early-exit on the missing fingerprint.
    const prepareSpy2 = spyOn(SQLiteDatabase.prototype, 'prepare')
    try {
      syncDevinSessions(paths.outDir)
      expect(prepareSpy2.mock.calls.length).toBeGreaterThan(0)
    } finally {
      prepareSpy2.mockRestore()
    }
    expect(typeof JSON.parse(fs.readFileSync(statePath, 'utf8')).dbFingerprint).toBe('string')
  })

  test('a reader does not perturb the fingerprint', () => {
    const db = createDevinDb()
    try {
      db.exec('PRAGMA journal_mode = WAL')
      addSession(db, 'q', '/p', null)
      addMessage(db, 'q', 'user', 'hi')
      const before = fingerprint()
      syncDevinSessions(paths.outDir) // opens a readonly connection
      expect(fingerprint()).toBe(before)
    } finally {
      db.close()
    }
  })
})
