// The audit migration and its only writer (execution-safety-recovery D6):
// the migration applies on a fresh database and on a baseline copy, twice
// over; duplicate calls and outcomes are no-ops; the store exposes no update
// or delete; and reads keyset-page newest first with the filters. Every
// database lives in a temporary directory.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { applyBaselineSchema } from '../dbSafety/baseline'
import { MIGRATIONS, readSchemaVersion } from '../dbSafety/migrations'
import { OutboundStore, type OutboundCallInsert } from '../outbound/store'

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-outbound-store-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const NOW = '2026-01-01T00:00:00.000Z'

function call(overrides: Partial<OutboundCallInsert> = {}): OutboundCallInsert {
  return {
    id: 'obc-1',
    teamId: '/repo/.git',
    sessionId: 'chat-1',
    spawnId: 'sp-1',
    tool: 'Bash',
    toolUseId: 'tu-1',
    command: 'git push',
    truncated: false,
    rule: 'git-push',
    verdict: 'allowed',
    destination: 'github:origin',
    matches: '[]',
    classifierVersion: 1,
    cwd: '/repo',
    createdAt: NOW,
    ...overrides,
  }
}

describe('the outbound-audit migration (3.3)', () => {
  test('a fresh database records every version through outbound-audit and creates the tables, twice over', () => {
    expect(MIGRATIONS.find(migration => migration.name === 'outbound-audit')).toMatchObject({ version: 9 })
    expect(MIGRATIONS.at(-1)).toMatchObject({ name: 'team-approval-defaults' })
    for (let i = 0; i < 2; i++) {
      const db = initDatabase({ path: dbPath })
      expect(readSchemaVersion(db.db)).toBe(MIGRATIONS.at(-1)!.version)
      const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'outbound_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      expect(tables).toEqual(['outbound_acknowledgements', 'outbound_calls', 'outbound_outcomes'])
      db.close()
    }
  })

  test('a baseline database migrates with every row and column intact', () => {
    const before = new Database(dbPath)
    applyBaselineSchema(before)
    before.exec(`INSERT INTO app_settings (key, value) VALUES ('theme', 'dark')`)
    before.close()
    const db = initDatabase({ path: dbPath })
    expect(readSchemaVersion(db.db)).toBe(MIGRATIONS.at(-1)!.version)
    expect((db.db.prepare("SELECT value FROM app_settings WHERE key = 'theme'").get() as { value: string }).value).toBe('dark')
    db.close()
  })
})

describe('OutboundStore (the only writer)', () => {
  const opened: Array<ReturnType<typeof initDatabase>> = []
  afterEach(() => { for (const db of opened) db.close() })

  function store(): OutboundStore {
    const db = initDatabase({ path: dbPath })
    opened.push(db)
    return new OutboundStore(db.db)
  }

  test('a duplicate call and a duplicate outcome write nothing, and inserts report whether they wrote', () => {
    const outbound = store()
    expect(outbound.insertCall(call())).toBe(true)
    expect(outbound.insertCall(call({ id: 'obc-other' }))).toBe(false) // same (session, tool use)
    expect(outbound.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-1', outcome: 'completed', createdAt: NOW })).toBe(true)
    expect(outbound.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-1', outcome: 'completed', createdAt: NOW })).toBe(false)
    // A broken row throws instead of vanishing: ON CONFLICT catches only the key.
    expect(() => outbound.insertCall(call({ id: 'obc-bad', toolUseId: 'tu-bad', command: null as unknown as string }))).toThrow()
    const page = outbound.page({ teamId: '/repo/.git' })
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]!.id).toBe('obc-1')
    expect(outbound.outcomesOf('chat-1', 'tu-1')).toEqual([{ outcome: 'completed', detail: null }])
    // A different outcome of the same call is its own row.
    outbound.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-1', outcome: 'failed', detail: 'exit 1', createdAt: NOW })
    expect(outbound.outcomesOf('chat-1', 'tu-1')).toHaveLength(2)
  })

  test('the store exposes no update or delete', () => {
    const methods = Object.getOwnPropertyNames(OutboundStore.prototype).filter(name => name !== 'constructor')
    expect(methods.sort()).toEqual([
      'acknowledgementByCommand', 'callById', 'callByToolUse', 'counts', 'exclusively',
      'insertAcknowledgement', 'insertCall', 'insertOutcome', 'outcomesOf', 'page', 'unacknowledgedViolations',
    ])
    // And no statement of it ever mutates a row (E3): the append-only
    // guarantee is over the source, not the method names alone.
    const source = fs.readFileSync(import.meta.dir + '/../outbound/store.ts', 'utf8')
    expect(source).not.toMatch(/\bUPDATE\b/)
    expect(source).not.toMatch(/\bDELETE FROM\b/)
    expect(methods.some(name => /update|delete|drop|prune/i.test(name))).toBe(false)
  })

  test('keyset paging runs newest first and the filters narrow', () => {
    const outbound = store()
    for (let i = 0; i < 5; i++) {
      outbound.insertCall(call({
        id: `obc-${i}`,
        toolUseId: `tu-${i}`,
        createdAt: `2026-01-01T00:0${i}:00.000Z`,
        verdict: i % 2 === 0 ? 'violation' : 'allowed',
        rule: i < 3 ? 'git-push' : 'registry-publish',
        sessionId: i === 4 ? 'chat-2' : 'chat-1',
      }))
    }
    // Newest first.
    const all = outbound.page({ teamId: '/repo/.git' }, 10)
    expect(all.rows.map(row => row.id)).toEqual(['obc-4', 'obc-3', 'obc-2', 'obc-1', 'obc-0'])
    expect(all.cursor).toBeNull()
    // Paging walks the cursor without overlap.
    const first = outbound.page({ teamId: '/repo/.git' }, 2)
    expect(first.rows.map(row => row.id)).toEqual(['obc-4', 'obc-3'])
    expect(first.cursor).not.toBeNull()
    const second = outbound.page({ teamId: '/repo/.git' }, 2, first.cursor)
    expect(second.rows.map(row => row.id)).toEqual(['obc-2', 'obc-1'])
    // Filters combine with paging.
    const violations = outbound.page({ teamId: '/repo/.git', verdict: 'violation' }, 10)
    expect(violations.rows.map(row => row.id)).toEqual(['obc-4', 'obc-2', 'obc-0'])
    const registries = outbound.page({ teamId: '/repo/.git', rule: 'registry-publish' }, 10)
    expect(registries.rows.map(row => row.id)).toEqual(['obc-4', 'obc-3'])
    const bySession = outbound.page({ teamId: '/repo/.git', sessionId: 'chat-2' }, 10)
    expect(bySession.rows.map(row => row.id)).toEqual(['obc-4'])
    const ranged = outbound.page({ teamId: '/repo/.git', from: '2026-01-01T00:01:30.000Z', to: '2026-01-01T00:03:30.000Z' }, 10)
    expect(ranged.rows.map(row => row.id)).toEqual(['obc-3', 'obc-2'])
    // Another team reads nothing.
    expect(outbound.page({ teamId: '/other/.git' }).rows).toEqual([])
  })

  test('same-timestamp rows page by the id tie-breaker alone (M11)', () => {
    const outbound = store()
    const at = '2026-01-01T00:00:00.000Z'
    // Insertion order differs from both id directions, so only an explicit
    // `id DESC` tie-break — never the engine's unspecified equal-key order —
    // can produce the expected pages.
    for (const id of ['obc-c', 'obc-a', 'obc-e', 'obc-b', 'obc-d']) {
      outbound.insertCall(call({ id, toolUseId: `tu-${id}`, createdAt: at }))
    }
    const first = outbound.page({ teamId: '/repo/.git' }, 2)
    expect(first.rows.map(row => row.id)).toEqual(['obc-e', 'obc-d'])
    const second = outbound.page({ teamId: '/repo/.git' }, 2, first.cursor)
    expect(second.rows.map(row => row.id)).toEqual(['obc-c', 'obc-b'])
    const third = outbound.page({ teamId: '/repo/.git' }, 2, second.cursor)
    expect(third.rows.map(row => row.id)).toEqual(['obc-a'])
    expect(third.cursor).toBeNull()
    // A cursor without its separator is refused, not silently mis-read.
    expect(() => outbound.page({ teamId: '/repo/.git' }, 2, 'not-a-cursor')).toThrow(/invalid page cursor/)
    expect(() => outbound.page({ teamId: '/repo/.git' }, 2, 'x\u0000')).toThrow(/invalid page cursor/)
  })

  test('a broken outcome row is refused, never silently dropped (CC round 3)', () => {
    const outbound = store()
    // A null key or outcome violates the table: the store throws it, because
    // ON CONFLICT catches only the dedup key, never a broken row.
    expect(() => outbound.insertOutcome({ sessionId: null as unknown as string, toolUseId: 'tu-x', outcome: 'completed', createdAt: NOW })).toThrow()
    expect(() => outbound.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-x', outcome: undefined as unknown as 'completed', createdAt: NOW })).toThrow()
    expect(outbound.outcomesOf('chat-1', 'tu-x')).toEqual([])
  })

  test('an outcome before its call row is kept and joins once the row exists', () => {
    const outbound = store()
    outbound.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-late', outcome: 'completed', createdAt: NOW })
    expect(outbound.outcomesOf('chat-1', 'tu-late')).toHaveLength(1)
    outbound.insertCall(call({ id: 'obc-late', toolUseId: 'tu-late' }))
    const row = outbound.callById('obc-late')
    expect(row?.toolUseId).toBe('tu-late')
    expect(outbound.outcomesOf('chat-1', 'tu-late')).toEqual([{ outcome: 'completed', detail: null }])
  })
})
