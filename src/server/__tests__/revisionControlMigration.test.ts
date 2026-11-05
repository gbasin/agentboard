// Schema migration `revision-control` (revision-control design D2), task 2.1.
// Three databases, the first two opened twice: a fresh one, and one at
// version 16 that already has execution rows — whose rows become seq 1 of
// `plan_execution_revisions` exactly once. The third reruns the migration's
// up as a no-op.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS, type Migration } from '../dbSafety/migrations'
import { REVISION_CONTROL_TABLES, revisionControlMigration } from '../plans/revisionControl/revisionControlSchema'
import { PLAN_WORKSPACE_TABLES } from '../plans/workspace/workspaceSchema'
import { VERIFICATION_TABLES } from '../verification/verificationSchema'

const UP_TO_16: readonly Migration[] = MIGRATIONS.filter(migration => migration.version <= 16)

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-revision-control-migration-'))
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

test('revision-control is migration 17, registered right after plan-supervision', () => {
  expect(revisionControlMigration.version).toBe(17)
  expect(MIGRATIONS.find(migration => migration.version === 17)).toBe(revisionControlMigration)
  expect(MIGRATIONS.find(migration => migration.version === 16)!.name).toBe('plan-supervision')
})

test('a fresh database, opened twice, gains the seven tables once', () => {
  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const after = tables(dbPath)
  expect(REVISION_CONTROL_TABLES.filter(table => table in after)).toEqual(REVISION_CONTROL_TABLES)
  const recorded = versions(dbPath)
  expect(recorded.filter(row => row.version === 17)).toEqual([{ version: 17, name: 'revision-control' }])
  expect(recorded.map(row => row.version)).toEqual(recorded.map((_, index) => index + 1))
})

test('a database at version 16 with execution rows backfills seq 1, twice, keeping every row', () => {
  const at16 = initDatabase({ path: dbPath, migrations: UP_TO_16 })
  // Two executions: one still running, one stopped, on the same plan.
  const insertExecution = at16.db.prepare(`INSERT INTO plan_executions (id, team_id, plan_id, revision, content_hash, report_id, input_hash,
    landing_mode, base_branch, base_commit, floor_json, max_parallel, merge_method, state, started_at)
    VALUES (?, 't', 'p', 3, 'hash-3', 'report-3', 'input-3', 'direct', 'master', 'base0', '{}', 2, 'merge', ?, ?)`)
  insertExecution.run('exec-1', 'running', '2026-10-01T09:00:00Z')
  insertExecution.run('exec-2', 'stopped', '2026-09-20T09:00:00Z')
  at16.close()
  const before = tables(dbPath)
  expect(REVISION_CONTROL_TABLES.filter(table => table in before)).toEqual([])
  expect(versions(dbPath).at(-1)!.version).toBe(16)

  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: MIGRATIONS }).close()
  const after = tables(dbPath)
  // Migration 21 (compact-observation-detail) drops the observation team table.
  for (const [table, rows] of Object.entries(before)) {
    if (table !== 'process_observation_teams') expect(after[table]).toEqual(rows)
  }
  // Later migrations (19 plan-workspace, 20 result-checks, 22 team-approval-defaults) also land in this upgrade.
  expect(Object.keys(after).filter(table => !(table in before)).sort())
    .toEqual([...REVISION_CONTROL_TABLES, ...PLAN_WORKSPACE_TABLES, ...VERIFICATION_TABLES, 'team_approval_defaults'].sort())
  expect(versions(dbPath).filter(row => row.version === 17)).toHaveLength(1)
  // The backfill: each execution's row, once, as seq 1.
  expect(after.plan_execution_revisions).toEqual([
    { execution_id: 'exec-1', seq: 1, revision: 3, content_hash: 'hash-3', report_id: 'report-3', input_hash: 'input-3', rationale: null, command_id: null, payload_json: null, applied_at: '2026-10-01T09:00:00Z' },
    { execution_id: 'exec-2', seq: 1, revision: 3, content_hash: 'hash-3', report_id: 'report-3', input_hash: 'input-3', rationale: null, command_id: null, payload_json: null, applied_at: '2026-09-20T09:00:00Z' },
  ])
})

test("rerunning the migration's up is a no-op beside existing rows", () => {
  const db = initDatabase({ path: dbPath, migrations: MIGRATIONS })
  db.db.prepare(`INSERT INTO plan_executions (id, team_id, plan_id, revision, content_hash, report_id, input_hash,
    landing_mode, base_branch, base_commit, floor_json, max_parallel, merge_method, state, started_at)
    VALUES ('exec-1', 't', 'p', 2, 'hash-2', 'report-2', 'input-2', 'direct', 'master', 'base0', '{}', 2, 'merge', 'running', '2026-10-01T09:00:00Z')`).run()
  db.close()
  const rerun = new Database(dbPath)
  try {
    revisionControlMigration.up(rerun)
    const before = tables(dbPath)
    expect(before.plan_execution_revisions).toHaveLength(1)
    revisionControlMigration.up(rerun)
    expect(tables(dbPath)).toEqual(before)
  } finally { rerun.close() }
})
