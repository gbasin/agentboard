// devinSyncRewrite.test.ts - Full mirror rewrites stream message rows to disk
// instead of materializing a session's whole history in memory.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
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

const originalPrepare = SQLiteDatabase.prototype.prepare

afterEach(() => {
  SQLiteDatabase.prototype.prepare = originalPrepare
})

/** Record the SQL of every statement whose rows are fetched with .all(). */
function recordAllCalls(): string[] {
  const sqls: string[] = []
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
      sqls.push(sql)
      return all(...(args as []))
    }
    return stmt
  } as typeof originalPrepare
  return sqls
}

describe('syncDevinSessions full rewrite', () => {
  test('does not load the whole message history with .all()', () => {
    const db = createDevinDb()
    addSession(db, 's-big', '/p', null)
    addMessage(db, 's-big', 'user', 'hello')
    addMessage(db, 's-big', 'assistant', 'hi')
    db.close()

    const allCalls = recordAllCalls()
    const result = syncDevinSessions(paths.outDir)

    expect(result?.rewritten).toBe(1)
    expect(allCalls.filter((sql) => sql.includes('chat_message'))).toEqual([])
    expect(readLines(path.join(paths.outDir, 's-big.jsonl'))).toHaveLength(3)
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
})
