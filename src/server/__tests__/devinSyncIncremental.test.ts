// Incremental-sync behaviour: idle early exit, per-session skip, append of
// only new rows, and full-rewrite fallbacks when history changes.
import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { syncDevinSessions } from '../devinSync'
import {
  addMessage,
  addSession,
  createDevinDb,
  openDb,
  paths,
  readLines,
  statNs,
  useDevinSyncFixture,
} from './devinSyncFixture'

useDevinSyncFixture()

describe('syncDevinSessions incremental', () => {
  test('initial sync writes all sessions and records db fingerprint', () => {
    const db = createDevinDb()
    addSession(db, 'a', '/p', null)
    addSession(db, 'b', '/q', null)
    addMessage(db, 'a', 'user', 'a1')
    addMessage(db, 'a', 'assistant', 'a2')
    addMessage(db, 'b', 'user', 'b1')
    db.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result).toEqual({ sessions: 2, rewritten: 2, appended: 0, removed: 0 })
    expect(readLines(path.join(paths.outDir, 'a.jsonl'))).toHaveLength(3)
    expect(readLines(path.join(paths.outDir, 'b.jsonl'))).toHaveLength(2)
    const state = JSON.parse(fs.readFileSync(path.join(paths.outDir, '.sync-state.json'), 'utf8'))
    expect(typeof state.dbFingerprint).toBe('string')
    expect(state.sessionCount).toBe(2)
    expect(state.sessions.a.rowCount).toBe(2)
  })

  test('unchanged db exits early without preparing any statement', () => {
    const db = createDevinDb()
    addSession(db, 'idle', '/p', null)
    addMessage(db, 'idle', 'user', 'hi')
    db.close()
    syncDevinSessions(paths.outDir)

    const statePath = path.join(paths.outDir, '.sync-state.json')
    const logPath = path.join(paths.outDir, 'idle.jsonl')
    const stateMtime = statNs(statePath)
    const logMtime = statNs(logPath)

    // No statement is prepared on the idle path: SQLite is never touched.
    const prepareSpy = spyOn(SQLiteDatabase.prototype, 'prepare')
    try {
      const result = syncDevinSessions(paths.outDir)
      expect(result).toEqual({ sessions: 1, rewritten: 0, appended: 0, removed: 0 })
      expect(prepareSpy).toHaveBeenCalledTimes(0)
      // Sanity: the spy does observe a real sync once the db changes.
      fs.utimesSync(paths.dbPath, new Date(), new Date(Date.now() + 5000))
      syncDevinSessions(paths.outDir)
      expect(prepareSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      prepareSpy.mockRestore()
    }
    // The utimes-triggered sync rewrote state but left the unchanged log alone.
    expect(statNs(statePath)).not.toBe(stateMtime)
    expect(statNs(logPath)).toBe(logMtime)
  })

  test('idle early exit leaves sync state untouched', () => {
    const db = createDevinDb()
    addSession(db, 'idle2', '/p', null)
    db.close()
    syncDevinSessions(paths.outDir)
    const statePath = path.join(paths.outDir, '.sync-state.json')
    const stateMtime = statNs(statePath)
    expect(syncDevinSessions(paths.outDir)?.sessions).toBe(1)
    expect(statNs(statePath)).toBe(stateMtime)
  })

  test('append cycle reads only rows after lastRowId', () => {
    const db = createDevinDb()
    addSession(db, 'inc', '/p', null)
    addMessage(db, 'inc', 'user', 'old')
    db.close()
    syncDevinSessions(paths.outDir)

    const db2 = openDb()
    addMessage(db2, 'inc', 'assistant', 'new')
    db2.close()

    const prepareSpy = spyOn(SQLiteDatabase.prototype, 'prepare')
    let prepared: string[] = []
    try {
      expect(syncDevinSessions(paths.outDir)?.appended).toBe(1)
      prepared = prepareSpy.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' '))
    } finally {
      prepareSpy.mockRestore()
    }
    const rowReads = prepared.filter((sql) => sql.includes('chat_message'))
    expect(rowReads).toHaveLength(1)
    expect(rowReads[0]).toContain('row_id > $afterRowId')
  })

  test('append adds exactly the new rows and skips unchanged sessions', () => {
    const db = createDevinDb()
    addSession(db, 'grow', '/p', null)
    addSession(db, 'still', '/q', null)
    addMessage(db, 'grow', 'user', 'g1')
    addMessage(db, 'still', 'user', 's1')
    db.close()
    syncDevinSessions(paths.outDir)

    const growPath = path.join(paths.outDir, 'grow.jsonl')
    const stillPath = path.join(paths.outDir, 'still.jsonl')
    const before = fs.readFileSync(growPath, 'utf8')
    const stillMtime = statNs(stillPath)

    const db2 = openDb()
    addMessage(db2, 'grow', 'assistant', 'g2')
    addMessage(db2, 'grow', 'system', 'g3')
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result).toEqual({ sessions: 2, rewritten: 0, appended: 1, removed: 0 })
    const after = fs.readFileSync(growPath, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    const added = after
      .slice(before.length)
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line).message as { content: string }).content)
    expect(added).toEqual(['g2', 'g3'])
    expect(statNs(stillPath)).toBe(stillMtime)

    const state = JSON.parse(fs.readFileSync(path.join(paths.outDir, '.sync-state.json'), 'utf8'))
    expect(state.sessions.grow.rowCount).toBe(3)
  })

  test('filtered-only new rows advance state without touching the file', () => {
    const db = createDevinDb()
    addSession(db, 'f', '/p', null)
    addMessage(db, 'f', 'user', 'real')
    db.close()
    syncDevinSessions(paths.outDir)
    const logPath = path.join(paths.outDir, 'f.jsonl')
    const before = fs.readFileSync(logPath, 'utf8')

    const db2 = openDb()
    addMessage(db2, 'f', 'developer', 'dropped role')
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result).toEqual({ sessions: 1, rewritten: 0, appended: 0, removed: 0 })
    expect(fs.readFileSync(logPath, 'utf8')).toBe(before)
    const state = JSON.parse(fs.readFileSync(path.join(paths.outDir, '.sync-state.json'), 'utf8'))
    expect(state.sessions.f.rowCount).toBe(2)
  })

  test('replaced tail (same count, higher max row_id) triggers full rewrite', () => {
    const db = createDevinDb()
    addSession(db, 't', '/p', null)
    addMessage(db, 't', 'user', 'keep')
    addMessage(db, 't', 'assistant', 'reverted')
    db.close()
    syncDevinSessions(paths.outDir)

    const db2 = openDb()
    db2.exec(`DELETE FROM message_nodes WHERE session_id = 't' AND chat_message LIKE '%reverted%'`)
    addMessage(db2, 't', 'assistant', 'replacement')
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.rewritten).toBe(1)
    expect(result?.appended).toBe(0)
    const contents = readLines(path.join(paths.outDir, 't.jsonl'))
      .slice(1)
      .map((line) => (line.message as { content: string }).content)
    expect(contents).toEqual(['keep', 'replacement'])
  })

  test('truncated prefix with net growth triggers full rewrite', () => {
    const db = createDevinDb()
    addSession(db, 'm', '/p', null)
    addMessage(db, 'm', 'user', 'first')
    addMessage(db, 'm', 'assistant', 'middle')
    db.close()
    syncDevinSessions(paths.outDir)

    const db2 = openDb()
    db2.exec(`DELETE FROM message_nodes WHERE session_id = 'm' AND chat_message LIKE '%first%'`)
    addMessage(db2, 'm', 'user', 'new1')
    addMessage(db2, 'm', 'assistant', 'new2')
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.rewritten).toBe(1)
    const contents = readLines(path.join(paths.outDir, 'm.jsonl'))
      .slice(1)
      .map((line) => (line.message as { content: string }).content)
    expect(contents).toEqual(['middle', 'new1', 'new2'])
  })

  test('rewrites a mirror deleted out from under an unchanged session', () => {
    const db = createDevinDb()
    addSession(db, 'x', '/p', null)
    addSession(db, 'y', '/p', null)
    addMessage(db, 'x', 'user', 'hi')
    db.close()
    syncDevinSessions(paths.outDir)
    fs.unlinkSync(path.join(paths.outDir, 'x.jsonl'))

    const db2 = openDb()
    addMessage(db2, 'y', 'user', 'poke') // change the db so sync runs
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.rewritten).toBe(1) // x: missing file forces a rewrite
    expect(result?.appended).toBe(1) // y: empty prefix intact, append
    expect(readLines(path.join(paths.outDir, 'x.jsonl'))).toHaveLength(2)
  })

  test('hidden session is removed while visible ones are skipped', () => {
    const db = createDevinDb()
    addSession(db, 'hide-me', '/p', null)
    addSession(db, 'keep-me', '/p', null)
    addMessage(db, 'hide-me', 'user', 'bye')
    addMessage(db, 'keep-me', 'user', 'stay')
    db.close()
    syncDevinSessions(paths.outDir)
    const keepMtime = statNs(path.join(paths.outDir, 'keep-me.jsonl'))

    const db2 = openDb()
    db2.exec(`UPDATE sessions SET hidden = 1 WHERE id = 'hide-me'`)
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result).toEqual({ sessions: 1, rewritten: 0, appended: 0, removed: 1 })
    expect(fs.existsSync(path.join(paths.outDir, 'hide-me.jsonl'))).toBe(false)
    expect(statNs(path.join(paths.outDir, 'keep-me.jsonl'))).toBe(keepMtime)
    const state = JSON.parse(fs.readFileSync(path.join(paths.outDir, '.sync-state.json'), 'utf8'))
    expect(Object.keys(state.sessions)).toEqual(['keep-me'])
  })

  test('detects WAL-only writes from a live writer connection', () => {
    const db = createDevinDb()
    db.exec('PRAGMA journal_mode = WAL')
    addSession(db, 'w', '/p', null)
    addMessage(db, 'w', 'user', 'one')
    try {
      expect(syncDevinSessions(paths.outDir)?.rewritten).toBe(1)
      expect(syncDevinSessions(paths.outDir)?.rewritten).toBe(0)

      addMessage(db, 'w', 'assistant', 'two')
      expect(fs.existsSync(`${paths.dbPath}-wal`)).toBe(true)
      expect(syncDevinSessions(paths.outDir)?.appended).toBe(1)
      expect(readLines(path.join(paths.outDir, 'w.jsonl'))).toHaveLength(3)
    } finally {
      db.close()
    }
  })
})
