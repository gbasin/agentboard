/** Compare old polling SQL, indexed reads and worker snapshots on a DB COPY.
 * Usage: bun scripts/bench-polling-reads.ts /tmp/private-copy.db
 * Initializes indexes on the supplied copy. Never pass a running instance's DB.
 */
import { isDeepStrictEqual } from 'node:util'
import { initDatabase } from '../src/server/db'
import { SessionCatalog } from '../src/server/persistence/catalog'
import { SessionReadClient } from '../src/server/sessionReadClient'
import { readImportCandidates, readPollSnapshot, sessionListsSql } from '../src/server/sessionReads'
import { mapRow } from '../src/server/sessionRecord'

const filename = process.argv[2]
if (!filename) throw new Error('Pass a private database copy')
const db = initDatabase({ path: filename, exclusive: true })
const reader = new SessionReadClient(db.db.filename)
new SessionCatalog(db.db, 'benchmark')
const cutoff = new Date(Date.now() - 72 * 3600000).toISOString()
const oldSql = `SELECT * FROM agent_sessions WHERE current_window IS NOT NULL
  OR is_hibernating=1 OR (is_hibernating=0 AND ($cutoff IS NULL OR last_activity_at>$cutoff))
  ORDER BY (current_window IS NULL), CASE WHEN current_window IS NULL THEN last_activity_at END DESC, session_id`
function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }
}
async function measure(operation: () => unknown | Promise<unknown>) {
  const times: number[] = []
  for (let i = 0; i < 25; i++) {
    const start = performance.now()
    await operation()
    times.push(performance.now() - start)
  }
  return summarize(times)
}
try {
  const oldRows = db.db.query(oldSql).all({ $cutoff: cutoff }) as Record<string, unknown>[]
  const newRows = db.db.query(sessionListsSql(true)).all({ $cutoff: cutoff }) as Record<string, unknown>[]
  if (!isDeepStrictEqual(oldRows, newRows)) throw new Error('Query results differ')
  const local = readPollSnapshot(db.db, { maxAgeHours: 72 })
  const remote = await reader.snapshot({ maxAgeHours: 72 })
  if (!isDeepStrictEqual(local, remote)) throw new Error('Worker snapshot differs')
  const results = {
    rows: oldRows.length,
    messageCharacters: oldRows.map(mapRow).reduce((sum, row) => sum + (row.lastUserMessage?.length ?? 0), 0),
    parity: true,
    oldQuery: await measure(() => db.db.query(oldSql).all({ $cutoff: cutoff })),
    indexedQuery: await measure(() => db.db.query(sessionListsSql(true)).all({ $cutoff: cutoff })),
    workerSnapshotIncludingKeysAndTransfer: await measure(() => reader.snapshot({ maxAgeHours: 72 })),
    importScan: await measure(() => readImportCandidates(db.db)),
    workerImportScanIncludingTransfer: await measure(() => reader.importCandidates()),
    plan: db.db.query(`EXPLAIN QUERY PLAN ${sessionListsSql(true)}`).all({ $cutoff: cutoff }),
  }
  console.log(JSON.stringify(results, null, 2))
} finally {
  reader.dispose()
  db.close()
}
