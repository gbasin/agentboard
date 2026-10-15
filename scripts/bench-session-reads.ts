/**
 * Timing harness for the catalog read paths implicated by production
 * sync_db_slow events. Run against a copy of the production db:
 *
 *   sqlite3 ~/.agentboard/agentboard.db ".backup '/tmp/x/agentboard.db'"
 *   bun run scripts/bench-session-reads.ts /tmp/x/agentboard.db
 *
 * Prints EXPLAIN QUERY PLAN + min/median/max ms for each hot query.
 * Query *count* per poll cycle is the metric that matters under memory
 * pressure — every page-in is O(10-100ms) of event-loop block.
 */
import { Database } from 'bun:sqlite'

const path = process.argv[2] ?? '/tmp/ab-perf-dev/data/agentboard.db'
const db = new Database(path)
db.exec('PRAGMA busy_timeout=100')

const hostId =
  (
    db
      .query('SELECT DISTINCT host_id FROM board_sessions LIMIT 1')
      .get() as { host_id: string } | null
  )?.host_id ?? null
if (!hostId) {
  console.error('no board_sessions rows in this db')
  process.exit(1)
}
const cutoff72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()

const QUERIES: Record<string, { sql: string; args: unknown[] }> = {
  catalog_active: {
    sql: `SELECT * FROM board_sessions WHERE host_id=? AND state IN ('running','starting')`,
    args: [hostId],
  },
  known_session_keys: {
    sql: `SELECT session_id, log_file_path, project_path, slug, agent_type, is_codex_exec FROM agent_sessions`,
    args: [],
  },
  session_lists: {
    sql: `SELECT * FROM agent_sessions
          WHERE current_window IS NOT NULL OR is_hibernating = 1
             OR (is_hibernating = 0 AND ($cutoff IS NULL OR last_activity_at > $cutoff))
          ORDER BY (current_window IS NULL),
                   CASE WHEN current_window IS NULL THEN last_activity_at END DESC,
                   session_id`,
    args: [cutoff72h],
  },
  import_candidates: {
    sql: `SELECT session_id AS id FROM agent_sessions a WHERE a.is_codex_exec=0 AND NOT EXISTS
          (SELECT 1 FROM session_conversations c WHERE c.provider_id=a.session_id) ORDER BY id LIMIT 100`,
    args: [],
  },
}

// The implemented path: candidate scan, then ONE indexed IN() fetch.
function benchImport() {
  const ids = (
    db
      .query(QUERIES.import_candidates.sql)
      .all() as { id: string }[]
  ).map((r) => r.id)
  const sql = `SELECT * FROM agent_sessions WHERE session_id IN (${ids
    .map(() => '?')
    .join(',')})`
  const stmt = db.query(sql)
  const times: number[] = []
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now()
    stmt.all(...(ids as never[]))
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const med = times[Math.floor(times.length / 2)]
  console.log(
    `${'import_fetch_batch'.padEnd(22)} min=${times[0].toFixed(2)}ms med=${med.toFixed(2)}ms max=${times[times.length - 1].toFixed(2)}ms (${ids.length} rows)`
  )
}

function bench(name: string, sql: string, args: unknown[]) {
  const stmt = db.query(sql)
  // EXPLAIN takes the real bound args — plan shape can depend on bindings.
  const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as {
    detail: string
  }[]
  const times: number[] = []
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now()
    if (args.length) stmt.all(...(args as never[]))
    else stmt.all()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const med = times[Math.floor(times.length / 2)]
  console.log(
    `${name.padEnd(22)} min=${times[0].toFixed(2)}ms med=${med.toFixed(2)}ms max=${times[times.length - 1].toFixed(2)}ms`
  )
  for (const row of plan) console.log(`  ${row.detail}`)
}

for (const [name, q] of Object.entries(QUERIES)) bench(name, q.sql, q.args)
benchImport()
