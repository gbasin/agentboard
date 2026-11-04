// Schema versions and the migration runner (execution-safety-recovery D13,
// D14). `schema_migrations` records each applied version's number, name, time,
// build, and pre-migration backup; `PRAGMA user_version` mirrors the highest
// for outside tools and is never read for a decision. Startup order:
// 1. read the version without writing (0 when the table is missing or empty);
// 2. refuse a database newer than this build, before any write — no override;
//    then refuse a recorded (version, name) the registry disagrees with: a
//    database a different migration lineage wrote;
// 3. take the `startup` snapshot;
// 4. only when no version is recorded, run the frozen baseline and record
//    version 1 `baseline`;
// 5. apply each pending migration in order, each gated on its checked
//    `pre-migration-<n>` backup, its `up(db)` and version row committed in
//    one `BEGIN IMMEDIATE` transaction;
// 6. then `initDatabase` compacts once into incremental auto_vacuum
//    (`compaction.ts`), outside any transaction.
// A later schema change is the next entry in MIGRATIONS (versions dense from
// 2), never an edit to the baseline (E5).
import type { Database } from 'bun:sqlite'
import { BUILD_VERSION } from '../version'
import { outboundAuditMigration } from '../outbound/migration'
import { CREATE_OBSERVATION_SOURCE_INDEXES_SQL, CREATE_PROCESS_OBSERVATIONS_SQL } from '../metrics/observations/schema'
import { contextExhaustedMigration } from '../chat/contextExhaustedMigration'
import { codexSessionMigration } from '../chat/codexSessionMigration'
import { applyBaselineSchema } from './baseline'
import { CREATE_IMPACT_TABLES_SQL } from '../strategy/impactSchema'
import { CREATE_VALIDATION_TABLES_SQL } from '../plans/validation/validationSchema'
import { applyExecutionSchema } from '../plans/execution/executionSchema'
import { migrateTaskStatusEvents } from '../team/taskStatusEventsSchema'
import { CREATE_AGENT_START_TABLES_SQL } from '../metrics/provenanceSchema'
import { CREATE_TURN_USAGE_SQL } from '../chat/chatTurnUsageStore'
import { CREATE_PROCESS_REPORT_TABLES_SQL } from '../metrics/reportSchema'
import { migrateProviderLimitWindow } from '../team/routing/limitEvents'
import { integrationMigration } from '../plans/landing/integration/integrationSchema'
import { workerChoiceMigration } from '../team/workerChoiceMigration'
import { planSupervisionMigration } from '../plans/decisions/decisionSchema'
import { revisionControlMigration } from '../plans/revisionControl/revisionControlSchema'
import { planWorkspaceMigration } from '../plans/workspace/workspaceSchema'
import { resultChecksMigration } from '../verification/verificationSchema'
import { compactObservationDetailMigration } from '../metrics/observations/compactMigration'
import { CREATE_TEAM_APPROVAL_DEFAULTS_SQL } from '../team/teamApprovalDefaults'
import type { BackupFile } from './backupFiles'
import type { BackupOutcome } from './backups'

export interface Migration {
  readonly version: number
  readonly name: string
  up(db: Database): void
}

export const BASELINE_VERSION = 1
export const BASELINE_NAME = 'baseline'

/** Every numbered migration after the baseline, in order; versions dense from 2. */
export const MIGRATIONS: readonly Migration[] = [
  // strategy-revision-impact D1: the proposal, decision, and request tables
  // beside the baseline's strategy_impact_reviews.
  { version: 2, name: 'strategy-impact', up: db => db.exec(CREATE_IMPACT_TABLES_SQL) },
  // plan-validation D1: the report, assessment, and decision tables. Additive,
  // no backfill: existing revisions start as Not validated.
  { version: 3, name: 'plan-validation', up: db => db.exec(CREATE_VALIDATION_TABLES_SQL) },
  // team-process-metrics D3: task status transitions, backfilled for closed tasks.
  { version: 4, name: 'task-status-events', up: migrateTaskStatusEvents },
  // team-process-metrics D2: agent-start provenance and memory manifests.
  { version: 5, name: 'agent-starts', up: db => db.exec(CREATE_AGENT_START_TABLES_SQL) },
  // team-process-metrics D1: per-turn token usage of every chat turn.
  { version: 6, name: 'chat-turn-usage', up: db => db.exec(CREATE_TURN_USAGE_SQL) },
  // team-process-metrics D6: process reports, proposals, decisions, links, and commands.
  { version: 7, name: 'process-reports', up: db => db.exec(CREATE_PROCESS_REPORT_TABLES_SQL) },
  // plan-execution D3: executions, their changes, the landing slot, attempts,
  // rounds, effects, and landing facts, plus team_messages.allowed_profiles.
  // Additive, no backfill.
  { version: 8, name: 'plan-execution', up: applyExecutionSchema },
  // execution-safety-recovery D6: the append-only outbound audit tables.
  outboundAuditMigration,
  // chat-context-exhaustion D3: the session's context-exhausted flag columns.
  contextExhaustedMigration,
  { version: 11, name: 'process-observations', up: db => db.exec(CREATE_PROCESS_OBSERVATIONS_SQL) },
  // providers-and-workers D7: limit events record their provider and the
  // rejected report's window; rows from before it read provider-less.
  { version: 12, name: 'provider-limit-window', up: migrateProviderLimitWindow },
  // integration-candidates D3: the branch records, candidates, promotions,
  // and promotion effects, with the one-running-promotion index.
  integrationMigration,
  // process-observability D10: the reconciler's ordered NOT EXISTS scans.
  { version: 14, name: 'process-observation-indexes', up: db => db.exec(CREATE_OBSERVATION_SOURCE_INDEXES_SQL) },
  // codex-chat-sessions 3.3 (ruling R1): the chat's creation-fixed runtime,
  // its resolved Codex home, and the Codex transcript path.
  codexSessionMigration,
  // plan-supervision D3: decision cards, decisions, fix and correction tasks,
  // and stall alerts. Additive, no backfill.
  planSupervisionMigration,
  // revision-control D2: holds and their change rows, pauses and their
  // targets, checkpoints, and an execution's revision history with its
  // publication rows, backfilled with seq 1 from every existing execution.
  revisionControlMigration,
  // dispatch-worker-choice D1: the sender's worker choice on group mail and
  // on dispatches. Additive, no backfill.
  workerChoiceMigration,
  // plan-workspace 1.2: the repository's Architect/Lead bindings, document
  // references, per-message context snapshots, and the keyed-command replay
  // ledger. Additive, no backfill.
  planWorkspaceMigration,
  // independent-verification D4: result checks, coverage maps, and the
  // results' coverage column. Additive, no backfill.
  resultChecksMigration,
  // compact-observation-detail D6: drops per-segment activity, tool and
  // request start rows, unmatched resolutions, the team association table,
  // non-durable ledger keys, and two unread indexes.
  compactObservationDetailMigration,
  // team-approval-default D3: one row per team for the spawned members'
  // default approval policy. Additive, no backfill: no row = not set.
  { version: 22, name: 'team-approval-defaults', up: db => db.exec(CREATE_TEAM_APPROVAL_DEFAULTS_SQL) },
]

export const RESTORE_DOC = 'docs/operations/database-backups.md'

const CREATE_SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  backup_path TEXT
);
`

/** What the runner needs from DatabaseBackups; null for an in-memory database. */
export interface MigrationBackups {
  dir: string
  snapshotSync(reason: 'startup' | `pre-migration-${number}`): BackupOutcome
  rotate(): void
  /** The newest backup for a reason that passes its integrity check now. */
  newestGood(reason: `pre-migration-${number}`): BackupFile | null
}

export interface MigrateOptions {
  backups: MigrationBackups | null
  migrations?: readonly Migration[]
  appVersion?: string
  now?: () => Date
}

/** A start this database must refuse; the message is for the owner, whole. */
export class DatabaseStartupError extends Error {
  override readonly name = 'DatabaseStartupError'
}

/** The newest version a set of migrations reaches (the baseline when empty). */
export function newestVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return Math.max(BASELINE_VERSION, ...migrations.map(migration => migration.version))
}

/** The recorded version, read without writing: 0 for a missing table or no rows. */
export function readSchemaVersion(db: Database): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  if (!table) return 0
  const row = db.prepare('SELECT max(version) AS version FROM schema_migrations').get() as { version: number | null }
  return row.version ?? 0
}

/** Registry shape: dense versions from 2, unique names (a programming error, thrown before any write). */
export function checkMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== BASELINE_VERSION + 1 + index) {
      throw new Error(`migration ${migration.name} has version ${migration.version}; expected ${BASELINE_VERSION + 1 + index}`)
    }
  })
}

/** D14: the owner's message for a database a newer build migrated. */
export function newerDatabaseMessage(input: {
  dbPath: string
  dbVersion: number
  buildVersion: number
  backupsDir: string | null
  /** The newest checked `pre-migration-<buildVersion + 1>` backup, if any. */
  backup: BackupFile | null
}): string {
  const reason = `pre-migration-${input.buildVersion + 1}` as const
  const backup = input.backup
  const where = input.backupsDir ?? 'the backups directory'
  const named = backup
    ? `The newest backup taken before version ${input.buildVersion + 1} is ${where}/${backup.name}.`
    : `No ${reason} backup was found in ${where}.`
  return [
    `Database ${input.dbPath} is at schema version ${input.dbVersion}, but this build knows only up to version ${input.buildVersion}.`,
    'A newer build migrated it, and this build refuses to write to it; nothing was changed.',
    named,
    `To go back to this build, restore that backup by following ${RESTORE_DOC}, or run a build that knows version ${input.dbVersion}.`,
  ].join(' ')
}

/** The recorded versions, ascending — dense from 1 when healthy. */
function recordedVersions(db: Database): number[] {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  if (!table) return []
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
    .map(row => row.version)
}

/** The first recorded (version, name) the registry disagrees with, if any. */
export function recordedNameMismatch(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): { version: number; recorded: string; expected: string } | null {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  if (!table) return null
  const expected = new Map<number, string>([[BASELINE_VERSION, BASELINE_NAME], ...migrations.map(m => [m.version, m.name] as const)])
  const rows = db.prepare('SELECT version, name FROM schema_migrations').all() as Array<{ version: number; name: string }>
  for (const row of rows) {
    const name = expected.get(row.version)
    // A recorded version above the build's newest was already refused; one
    // the registry knows by a different name marks a different lineage.
    if (name !== undefined && name !== row.name) return { version: row.version, recorded: row.name, expected: name }
  }
  return null
}

/** D14: the owner's message for a database a different migration lineage wrote. */
export function nameMismatchMessage(input: {
  dbPath: string
  version: number
  recorded: string
  expected: string
  backupsDir: string | null
  /** The newest checked `pre-migration-<version>` backup, if any. */
  backup: BackupFile | null
}): string {
  const reason = `pre-migration-${input.version}` as const
  const where = input.backupsDir ?? 'the backups directory'
  const named = input.backup
    ? `The newest backup taken before version ${input.version} is ${where}/${input.backup.name}.`
    : `No ${reason} backup was found in ${where}.`
  return [
    `Database ${input.dbPath} records schema version ${input.version} as "${input.recorded}", but this build knows that version as "${input.expected}".`,
    'A different set of migrations wrote it, and this build refuses to write to it; nothing was changed.',
    named,
    `To recover, restore that backup by following ${RESTORE_DOC}, or run a build whose version ${input.version} is "${input.recorded}".`,
  ].join(' ')
}

/** Bring the database to the newest known version, or throw DatabaseStartupError (D13–D15). */
export function migrateSchema(db: Database, dbPath: string, options: MigrateOptions): void {
  const migrations = options.migrations ?? MIGRATIONS
  checkMigrations(migrations)
  const buildVersion = newestVersion(migrations)
  const appVersion = options.appVersion ?? BUILD_VERSION
  const now = options.now ?? (() => new Date())
  const backups = options.backups

  const dbVersion = readSchemaVersion(db)
  if (dbVersion > buildVersion) {
    throw new DatabaseStartupError(newerDatabaseMessage({
      dbPath, dbVersion, buildVersion, backupsDir: backups?.dir ?? null,
      backup: backups?.newestGood(`pre-migration-${buildVersion + 1}`) ?? null,
    }))
  }
  // A gap in the recorded versions (1 and 3, no 2) would silently skip the
  // missing migration — the runner starts from the newest recorded version —
  // so it refuses before any write, like a mismatched name.
  const recorded = recordedVersions(db)
  const gapAt = recorded.findIndex((version, index) => version !== index + 1)
  if (gapAt !== -1) {
    throw new DatabaseStartupError(
      `Database ${dbPath} records schema versions [${recorded.join(', ')}], not dense from version 1: version ${gapAt + 1} is missing. This build refuses to write to it; nothing was changed. Restore a backup by following ${RESTORE_DOC}, or run the build that recorded these versions.`,
    )
  }
  const mismatch = recordedNameMismatch(db, migrations)
  if (mismatch !== null) {
    throw new DatabaseStartupError(nameMismatchMessage({
      dbPath,
      version: mismatch.version,
      recorded: mismatch.recorded,
      expected: mismatch.expected,
      backupsDir: backups?.dir ?? null,
      backup: backups?.newestGood(`pre-migration-${mismatch.version}`) ?? null,
    }))
  }

  if (backups) {
    backups.rotate()
    // A failed startup snapshot is logged and shown, never fatal: it gates nothing.
    backups.snapshotSync('startup')
  }

  let version = dbVersion
  if (version === 0) {
    const baseline = () => {
      applyBaselineSchema(db)
      db.exec(CREATE_SCHEMA_MIGRATIONS_SQL)
      record(db, { version: BASELINE_VERSION, name: BASELINE_NAME, appliedAt: now(), appVersion, backupPath: null })
    }
    // A database with no tables at all cannot reach the baseline's legacy
    // paths that open their own transaction, so it runs as one transaction:
    // atomic, and one commit instead of one per statement. A database written
    // before versions runs the steps exactly as before, each committing alone.
    if (isEmpty(db)) db.transaction(baseline).immediate()
    else baseline()
    version = BASELINE_VERSION
  }

  for (const migration of migrations) {
    if (migration.version <= version) continue
    const reason = `pre-migration-${migration.version}` as const
    let backupPath: string | null = null
    if (backups) {
      const backup = backups.snapshotSync(reason)
      if (!backup.ok) {
        throw new DatabaseStartupError(
          `Migration ${migration.version} (${migration.name}) did not start: its ${reason} backup ${backup.path ?? `in ${backups.dir}`} failed (${backup.error}). The database stays at version ${version}.`,
        )
      }
      backupPath = backup.path
    }
    try {
      db.transaction(() => {
        migration.up(db)
        record(db, { version: migration.version, name: migration.name, appliedAt: now(), appVersion, backupPath })
      }).immediate()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new DatabaseStartupError(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${detail}. The database stays at version ${version}; its backup is ${backupPath ?? 'none (in-memory database)'}.`,
      )
    }
    version = migration.version
  }
}

function isEmpty(db: Database): boolean {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()
}

function record(db: Database, row: { version: number; name: string; appliedAt: Date; appVersion: string; backupPath: string | null }): void {
  db.prepare(`INSERT INTO schema_migrations (version, name, applied_at, app_version, backup_path)
    VALUES ($version, $name, $appliedAt, $appVersion, $backupPath)`).run({
    $version: row.version,
    $name: row.name,
    $appliedAt: row.appliedAt.toISOString(),
    $appVersion: row.appVersion,
    $backupPath: row.backupPath,
  })
  // A mirror for outside tools, written with the row (inside the migration's transaction).
  db.exec(`PRAGMA user_version = ${Math.trunc(row.version)}`)
}
