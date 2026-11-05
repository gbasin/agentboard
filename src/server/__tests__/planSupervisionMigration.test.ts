// Schema migration `plan-supervision` (plan-supervision design D3), task 3.1.
// Two databases each open twice: a fresh one, and one at version 15 that
// already has the plan, execution, and turn-usage tables with rows. Each
// gains the four tables once and keeps every earlier row.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS, type Migration } from '../dbSafety/migrations'
import { planSupervisionMigration } from '../plans/decisions/decisionSchema'
import { REVISION_CONTROL_TABLES } from '../plans/revisionControl/revisionControlSchema'
import { PLAN_WORKSPACE_TABLES } from '../plans/workspace/workspaceSchema'
import { VERIFICATION_TABLES } from '../verification/verificationSchema'

const SUPERVISION_TABLES = ['plan_decision_cards', 'plan_decisions', 'plan_fix_tasks', 'plan_stall_alerts']
const UP_TO_15: readonly Migration[] = MIGRATIONS.filter(migration => migration.version <= 15)

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-supervision-migration-'))
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

test('plan-supervision is migration 16, registered right after codex-chat-runtime', () => {
  expect(planSupervisionMigration.version).toBe(16)
  expect(MIGRATIONS.find(migration => migration.version === 16)).toBe(planSupervisionMigration)
  expect(MIGRATIONS.find(migration => migration.version === 15)!.name).toBe('codex-chat-runtime')
})

test('a fresh database, opened twice, gains the four tables once', () => {
  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const after = tables(dbPath)
  expect(SUPERVISION_TABLES.filter(table => table in after)).toEqual(SUPERVISION_TABLES)
  const recorded = versions(dbPath)
  expect(recorded.filter(row => row.version === 16)).toEqual([{ version: 16, name: 'plan-supervision' }])
  expect(recorded.map(row => row.version)).toEqual(recorded.map((_, index) => index + 1))
})

test('a database at version 15 with plan rows upgrades, twice, keeping every row', () => {
  const at15 = initDatabase({ path: dbPath, migrations: UP_TO_15 })
  at15.db.prepare(`INSERT INTO plan_change_landings (plan_id, change, execution_id, team_id, mechanism, head_sha, base_sha, merge_sha, landed_at, tree_verified)
    VALUES ('p', 'alpha', 'e', 't', 'direct', 'h', 'b', 'm', 'now', 1)`).run()
  at15.db.prepare(`INSERT INTO chat_turn_usage (session_id, turn_id, team_id, group_id, profile_id, model, task_id, start_id, ok, input_tokens,
    output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, ended_at) VALUES ('s', 'turn', 't', 'g', 'p', 'm', 'task', NULL, 1, 1, 2, 3, 4, 5, 'now')`).run()
  at15.close()
  const before = tables(dbPath)
  expect(SUPERVISION_TABLES.filter(table => table in before)).toEqual([])
  expect(['plans', 'plan_change_landings', 'plan_integration_candidates', 'chat_turn_usage'].filter(table => table in before)).toHaveLength(4)
  expect(versions(dbPath).at(-1)!.version).toBe(15)

  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const after = tables(dbPath)
  // Migration 21 (compact-observation-detail) drops the observation team table.
  for (const [table, rows] of Object.entries(before)) {
    if (table !== 'process_observation_teams') expect(after[table]).toEqual(rows)
  }
  // Later migrations (17 revision-control, 19 plan-workspace, 20 result-checks,
  // 22 team-approval-defaults) also land in this upgrade.
  expect(Object.keys(after).filter(table => !(table in before)).sort())
    .toEqual([...SUPERVISION_TABLES, ...REVISION_CONTROL_TABLES, ...PLAN_WORKSPACE_TABLES, ...VERIFICATION_TABLES, 'team_approval_defaults'].sort())
  expect(versions(dbPath).filter(row => row.version === 16)).toHaveLength(1)
})

test("rerunning the migration's up is a no-op", () => {
  initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const db = new Database(dbPath)
  db.prepare(`INSERT INTO plan_fix_tasks (task_id, team_id, plan_id, source_kind, source_id, created_at) VALUES ('task-x', 't', 'p', 'override', 'd', 'now')`).run()
  const before = tables(dbPath)
  planSupervisionMigration.up(db)
  planSupervisionMigration.up(db)
  db.close()
  expect(tables(dbPath)).toEqual(before)
})
