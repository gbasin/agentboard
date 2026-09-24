import { describe, expect, test } from 'bun:test'
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

describe('syncDevinSessions', () => {
  test('returns null when sessions.db does not exist', () => {
    expect(syncDevinSessions(paths.outDir)).toBeNull()
    expect(fs.existsSync(paths.outDir)).toBe(false)
  })

  test('writes one JSONL per session with meta + kept messages', () => {
    const db = createDevinDb()
    addSession(db, 'flawless-bobolink', '/Users/x/proj', 'Fix the bug')
    addMessage(db, 'flawless-bobolink', 'system', 'system info')
    addMessage(db, 'flawless-bobolink', 'user', 'hello devin')
    addMessage(db, 'flawless-bobolink', 'assistant', 'working on it')
    addMessage(db, 'flawless-bobolink', 'tool', 'tool output')
    db.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.sessions).toBe(1)
    expect(result?.rewritten).toBe(1)

    const logPath = path.join(paths.outDir, 'flawless-bobolink.jsonl')
    const lines = readLines(logPath)
    // meta line + 4 kept messages
    expect(lines).toHaveLength(5)
    expect(lines[0].sessionId).toBe('flawless-bobolink')
    expect(lines[0].cwd).toBe('/Users/x/proj')
    expect(lines[0].agent).toBe('devin')
    expect(typeof lines[0].timestamp).toBe('string')
    expect(lines[2].type).toBe('user')
    expect((lines[2].message as { content: string }).content).toBe(
      'hello devin'
    )
  })

  test('mirrors assistant tool_calls and tool results with call ids', () => {
    const db = createDevinDb()
    addSession(db, 's-tools', '/p', null)
    db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, chat_message, created_at)
       VALUES ('s-tools', 0, $chat, 1700000050)`
    ).run({
      $chat: JSON.stringify({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'exec_0#abc',
            name: 'exec',
            arguments: { command: 'gh pr create --title x' },
            index: 0,
            kind: 'function',
          },
        ],
      }),
    })
    db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, chat_message, created_at)
       VALUES ('s-tools', 0, $chat, 1700000051)`
    ).run({
      $chat: JSON.stringify({
        role: 'tool',
        tool_call_id: 'exec_0#abc',
        content: 'https://github.com/o/r/pull/1',
      }),
    })
    db.close()

    syncDevinSessions(paths.outDir)
    const lines = readLines(path.join(paths.outDir, 's-tools.jsonl'))
    expect(lines).toHaveLength(3)

    const callMsg = lines[1].message as {
      toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
    }
    expect(callMsg.toolCalls).toEqual([
      {
        id: 'exec_0#abc',
        name: 'exec',
        arguments: { command: 'gh pr create --title x' },
      },
    ])

    const toolMsg = lines[2].message as {
      role: string
      content: string
      toolCallId?: string
    }
    expect(toolMsg.role).toBe('tool')
    expect(toolMsg.toolCallId).toBe('exec_0#abc')
    expect(toolMsg.content).toContain('pull/1')
  })

  test('rewrites existing mirrors when format version changes', () => {
    const db = createDevinDb()
    addSession(db, 's-fmt', '/p', null)
    addMessage(db, 's-fmt', 'user', 'hello')
    db.close()

    syncDevinSessions(paths.outDir)
    const logPath = path.join(paths.outDir, 's-fmt.jsonl')
    expect(readLines(logPath)).toHaveLength(2)

    // Simulate a pre-format-version sync state: next sync must rewrite.
    const statePath = path.join(paths.outDir, '.sync-state.json')
    fs.writeFileSync(statePath, fs.readFileSync(statePath, 'utf8').replace('"formatVersion":3', '"formatVersion":1'))

    const result = syncDevinSessions(paths.outDir)
    expect(result?.rewritten).toBe(1)
    expect(result?.appended).toBe(0)
  })

  test('drops internal user rows without is_user_input flag', () => {
    const db = createDevinDb()
    addSession(db, 's-internal', '/p', null)
    const insert = (chat: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO message_nodes (session_id, node_id, chat_message, created_at)
           VALUES ('s-internal', 0, $chat, 1700000050)`
        )
        .run({ $chat: JSON.stringify(chat) })
    // cache-keepalive / summarization rows: is_user_input null -> dropped
    insert({ role: 'user', content: 'continue', metadata: { is_user_input: null, telemetry: { source: 'cache_keepalive' } } })
    // genuine input -> kept
    insert({ role: 'user', content: 'real prompt', metadata: { is_user_input: true, telemetry: { source: 'user' } } })
    // no metadata at all -> kept (older CLI versions)
    insert({ role: 'user', content: 'legacy prompt' })
    db.close()

    syncDevinSessions(paths.outDir)
    const lines = readLines(path.join(paths.outDir, 's-internal.jsonl'))
    const contents = lines.map(
      (l) => (l.message as { content: string }).content
    )
    expect(contents).not.toContain('continue')
    expect(contents).toContain('real prompt')
    expect(contents).toContain('legacy prompt')
  })

  test('appends new messages on subsequent syncs', () => {
    const db = createDevinDb()
    addSession(db, 's1', '/p', null)
    addMessage(db, 's1', 'user', 'first')
    db.close()

    syncDevinSessions(paths.outDir)
    const logPath = path.join(paths.outDir, 's1.jsonl')
    expect(readLines(logPath)).toHaveLength(2)

    const db2 = new SQLiteDatabase(paths.dbPath)
    addMessage(db2, 's1', 'assistant', 'second')
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.appended).toBe(1)
    expect(result?.rewritten).toBe(0)
    expect(readLines(logPath)).toHaveLength(3)
  })

  test('removes jsonl for deleted or hidden sessions', () => {
    const db = createDevinDb()
    addSession(db, 'gone', '/p', null)
    addMessage(db, 'gone', 'user', 'hi')
    db.close()
    syncDevinSessions(paths.outDir)
    expect(fs.existsSync(path.join(paths.outDir, 'gone.jsonl'))).toBe(true)

    const db2 = new SQLiteDatabase(paths.dbPath)
    db2.exec(`UPDATE sessions SET hidden = 1 WHERE id = 'gone'`)
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.removed).toBe(1)
    expect(fs.existsSync(path.join(paths.outDir, 'gone.jsonl'))).toBe(false)
  })

  test('rewrites when messages are deleted (revert)', () => {
    const db = createDevinDb()
    addSession(db, 's2', '/p', null)
    addMessage(db, 's2', 'user', 'one')
    addMessage(db, 's2', 'assistant', 'two')
    db.close()
    syncDevinSessions(paths.outDir)

    const db2 = new SQLiteDatabase(paths.dbPath)
    db2.exec(`DELETE FROM message_nodes WHERE session_id = 's2'`)
    db2.close()

    const result = syncDevinSessions(paths.outDir)
    expect(result?.rewritten).toBe(1)
    // only the meta line remains
    expect(readLines(path.join(paths.outDir, 's2.jsonl'))).toHaveLength(1)
  })
})
