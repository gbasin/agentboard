// Schema migration `plan-workspace` (plan-workspace 1.2). Two databases each
// open twice: a fresh one, and one at version 18 that already has the plan,
// turn-usage, and session tables with rows. Each gains the four tables once
// and keeps every earlier row.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS, type Migration } from '../dbSafety/migrations'
import { PLAN_WORKSPACE_TABLES, planWorkspaceMigration } from '../plans/workspace/workspaceSchema'
import { VERIFICATION_TABLES } from '../verification/verificationSchema'

const UP_TO_18: readonly Migration[] = MIGRATIONS.filter(migration => migration.version <= 18)

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-workspace-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function tables(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true })
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all() as Array<{ name: string }>)
      .map(row => row.name)
    return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
  } finally { db.close() }
}

function versions(file: string): Array<{ version: number; name: string }> {
  const db = new Database(file, { readonly: true })
  try {
    return db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string }>
  } finally { db.close() }
}

test('plan-workspace is migration 19, registered right after worker-choice', () => {
  expect(planWorkspaceMigration.version).toBe(19)
  expect(MIGRATIONS.find(migration => migration.version === 19)).toBe(planWorkspaceMigration)
  expect(MIGRATIONS.find(migration => migration.version === 18)!.name).toBe('worker-choice')
})

test('a fresh database, opened twice, gains the four tables once', () => {
  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const after = tables(dbPath)
  expect(PLAN_WORKSPACE_TABLES.filter(table => table in after)).toEqual(PLAN_WORKSPACE_TABLES)
  const recorded = versions(dbPath)
  expect(recorded.filter(row => row.version === 19)).toEqual([{ version: 19, name: 'plan-workspace' }])
  expect(recorded.map(row => row.version)).toEqual(recorded.map((_, index) => index + 1))
})

test('a database at version 18 with plan and session rows upgrades, twice, keeping every row', () => {
  const at18 = initDatabase({ path: dbPath, migrations: UP_TO_18 })
  at18.db.prepare(`INSERT INTO plans (id, team_id, title, lifecycle, current_approved_revision, creator_kind, creator_session, created_at, updated_at)
    VALUES ('p', 't', 'Wave', 'open', NULL, 'human', NULL, 'now', 'now')`).run()
  at18.db.prepare(`INSERT INTO chat_turn_usage (session_id, turn_id, team_id, group_id, profile_id, model, task_id, start_id, ok, input_tokens,
    output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, ended_at) VALUES ('s', 'turn', 't', 'g', 'p', 'm', 'task', NULL, 1, 1, 2, 3, 4, 5, 'now')`).run()
  at18.close()
  const before = tables(dbPath)
  expect(PLAN_WORKSPACE_TABLES.filter(table => table in before)).toEqual([])
  expect(['plans', 'chat_turn_usage'].filter(table => table in before)).toHaveLength(2)
  expect(versions(dbPath).at(-1)!.version).toBe(18)

  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const after = tables(dbPath)
  // Migration 21 (compact-observation-detail) drops the observation team table.
  for (const [table, rows] of Object.entries(before)) {
    if (table !== 'process_observation_teams') expect(after[table]).toEqual(rows)
  }
  // Migrations 20 (result-checks) and 22 (team-approval-defaults) also land in this upgrade.
  expect(Object.keys(after).filter(table => !(table in before)).sort())
    .toEqual([...PLAN_WORKSPACE_TABLES, ...VERIFICATION_TABLES, 'team_approval_defaults'].sort())
  expect(versions(dbPath).filter(row => row.version === 19)).toHaveLength(1)
})

test("rerunning the migration's up is a no-op", () => {
  initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const db = new Database(dbPath)
  db.prepare(`INSERT INTO plan_workspace_chats (team_id, role, session_id, version, bound_at) VALUES ('t', 'lead', 's', 1, 'now')`).run()
  const before = tables(dbPath)
  planWorkspaceMigration.up(db)
  planWorkspaceMigration.up(db)
  db.close()
  expect(tables(dbPath)).toEqual(before)
})
