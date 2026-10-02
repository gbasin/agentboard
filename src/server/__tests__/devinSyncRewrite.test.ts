// devinSyncRewrite.test.ts - Full mirror rewrites stream message rows to disk
// instead of materializing a session's whole history in memory.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { syncDevinSessions } from '../devinSync'
import {
  addMessage,
  addSession,
  createDevinDb,
  fileId,
  openDb,
  paths,
  readLines,
  useDevinSyncFixture,
} from './devinSyncFixture'

useDevinSyncFixture()

const originalPrepare = SQLiteDatabase.prototype.prepare

afterEach(() => {
  SQLiteDatabase.prototype.prepare = originalPrepare
})

/**
 * Record the SQL of every statement whose rows are fetched with .all(), and
 * count rows pulled through iterate() on the full-history read.
 */
function instrumentStatements(): { allSqls: string[]; rowsPulled: () => number } {
  const allSqls: string[] = []
  let pulled = 0
  SQLiteDatabase.prototype.prepare = function (
    this: SQLiteDatabase,
    sql: string,
    ...rest: unknown[]
  ) {
    const stmt = originalPrepare.call(this, sql, ...(rest as [])) as ReturnType<
      SQLiteDatabase['prepare']
    >
    const all = stmt.all.bind(stmt)
    ;(stmt as { all: unknown }).all = (...args: unknown[]) => {
      allSqls.push(sql)
      return all(...(args as []))
    }
    const iterate = stmt.iterate.bind(stmt)
    ;(stmt as { iterate: unknown }).iterate = function* (...args: unknown[]) {
      for (const row of iterate(...(args as []))) {
        pulled += 1
        yield row
      }
    }
    return stmt
  } as typeof originalPrepare
  return { allSqls, rowsPulled: () => pulled }
}

describe('syncDevinSessions full rewrite', () => {
  test('streams rows to disk in chunks instead of loading the history first', () => {
    const db = createDevinDb()
    addSession(db, 's-big', '/p', null)
    const body = 'x'.repeat(8 * 1024)
    const messageCount = 300 // ~2.4MB, several write chunks
    for (let i = 0; i < messageCount; i++) addMessage(db, 's-big', 'assistant', `${i}:${body}`)
    db.close()

    const { allSqls, rowsPulled } = instrumentStatements()
    const pulledAtWrite: number[] = []
    const realWriteSync = fs.writeSync
    const writeSpy = spyOn(fs, 'writeSync').mockImplementation(((
      ...args: Parameters<typeof fs.writeSync>
    ) => {
      pulledAtWrite.push(rowsPulled())
      return realWriteSync(...args)
    }) as typeof fs.writeSync)
    let result: ReturnType<typeof syncDevinSessions>
    try {
      result = syncDevinSessions(paths.outDir)
    } finally {
      writeSpy.mockRestore()
    }

    expect(result?.rewritten).toBe(1)
    expect(allSqls.filter((sql) => sql.includes('chat_message'))).toEqual([])
    // Several chunked writes, the first while most rows were still unread.
    expect(pulledAtWrite.length).toBeGreaterThan(1)
    expect(pulledAtWrite[0]).toBeLessThan(messageCount / 2)
    expect(rowsPulled()).toBe(messageCount)
    expect(readLines(path.join(paths.outDir, 's-big.jsonl'))).toHaveLength(messageCount + 1)
  })

  test('writes a mirror larger than one write chunk intact', () => {
    const db = createDevinDb()
    addSession(db, 's-large', '/p', 'Large')
    const body = 'x'.repeat(8 * 1024)
    const messageCount = 300 // ~2.4MB of content, several write chunks
    for (let i = 0; i < messageCount; i++) {
      addMessage(db, 's-large', i % 2 === 0 ? 'assistant' : 'tool', `${i}:${body}`)
    }
    // Dropped rows still advance lastRowId/rowCount.
    addMessage(db, 's-large', 'unknown-role', 'dropped')
    db.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.rewritten).toBe(1)

    const logPath = path.join(paths.outDir, 's-large.jsonl')
    const lines = readLines(logPath)
    expect(lines).toHaveLength(messageCount + 1)
    expect(lines[0].type).toBe('system')
    lines.slice(1).forEach((line, i) => {
      expect((line.message as { content: string }).content).toBe(`${i}:${body}`)
    })
    expect(fs.readFileSync(logPath, 'utf8').endsWith('\n')).toBe(true)

    const state = JSON.parse(
      fs.readFileSync(path.join(paths.outDir, '.sync-state.json'), 'utf8')
    ) as {
      sessions: Record<string, { lastRowId: number; rowCount: number; fileSize: number }>
    }
    expect(state.sessions['s-large']).toEqual({
      lastRowId: messageCount + 1,
      rowCount: messageCount + 1,
      fileSize: fs.statSync(logPath).size,
    })
    expect(fs.readdirSync(paths.outDir).filter((name) => name.includes('.tmp-'))).toEqual([])

    // The recorded size matches the file, so the next cycle trusts the mirror.
    const again = syncDevinSessions(paths.outDir)
    expect(again?.rewritten).toBe(0)
  })

  test('a mid-stream write failure drops only that session; later rewrites still run', () => {
    const body = 'x'.repeat(8 * 1024)
    const db = createDevinDb()
    addSession(db, 's1', '/p', 'Large')
    for (let i = 0; i < 300; i++) addMessage(db, 's1', 'assistant', `${i}:${body}`)
    db.close()
    expect(syncDevinSessions(paths.outDir)?.rewritten).toBe(1)
    const s1Path = path.join(paths.outDir, 's1.jsonl')
    const s1Before = fileId(s1Path)

    // Shrink s1 (forces a rewrite) and add two new sessions (first syncs are
    // rewrites too). s1 is scanned first, so its rewrite runs before theirs.
    const db2 = openDb()
    db2.prepare(`DELETE FROM message_nodes WHERE row_id = 1`).run()
    addSession(db2, 's2', '/p', 'Two')
    addMessage(db2, 's2', 'user', 'two')
    addSession(db2, 's3', '/p', 'Three')
    addMessage(db2, 's3', 'user', 'three')
    db2.close()

    // The first write is s1's first ~1MB flush, inside the row iteration.
    const writeSpy = spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    let result: ReturnType<typeof syncDevinSessions>
    try {
      result = syncDevinSessions(paths.outDir)
    } finally {
      writeSpy.mockRestore()
    }

    expect(result?.rewritten).toBe(2)
    expect(fileId(s1Path)).toBe(s1Before)
    expect(fs.readdirSync(paths.outDir).filter((name) => name.includes('.tmp-'))).toEqual([])
    const state = JSON.parse(
      fs.readFileSync(path.join(paths.outDir, '.sync-state.json'), 'utf8')
    ) as { sessions: Record<string, unknown> }
    expect(Object.keys(state.sessions).sort()).toEqual(['s2', 's3'])
    expect(readLines(path.join(paths.outDir, 's2.jsonl'))).toHaveLength(2)
    expect(readLines(path.join(paths.outDir, 's3.jsonl'))).toHaveLength(2)
  })

  test('sweeps mirror temp files left by a killed process', () => {
    const db = createDevinDb()
    addSession(db, 's1', '/p', 'One')
    addMessage(db, 's1', 'user', 'hi')
    db.close()
    fs.mkdirSync(paths.outDir, { recursive: true })
    const stale = path.join(paths.outDir, 's1.jsonl.tmp-999999')
    const staleGone = path.join(paths.outDir, 'gone.jsonl.tmp-999999')
    fs.writeFileSync(stale, 'partial')
    fs.writeFileSync(staleGone, 'partial')

    const result = syncDevinSessions(paths.outDir)

    expect(result?.rewritten).toBe(1)
    expect(result?.removed).toBe(0)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(staleGone)).toBe(false)
    expect(readLines(path.join(paths.outDir, 's1.jsonl'))).toHaveLength(2)
  })
})
