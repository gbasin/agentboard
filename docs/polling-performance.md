# Polling database reads

The October 2026 investigation used a private backup of the existing perf dev
database: 9,566 provider sessions with about 22 million stored message characters.
It did not restart, modify, or profile the running production service or tmux server.

The original diagnosis confused total stored payload with the polling result.
Normal polls include active sessions, all hibernating sessions, and 72 hours of
history. In the final benchmark that selected 197 rows and 130,697 message
characters. The old `OR` predicate still scanned the entire table to find them.
Unbounded orphan recovery has different requirements and retains all history.

`observe()` runs during the regular board refresh, normally every two seconds.
Its import-candidate query therefore runs repeatedly, including when no records
need importing. Counts of `sync_db_slow` events measure slow calls, not total
invocations. The earlier estimate of 38 import calls per hour was unsupported.

The implementation uses three disjoint `UNION ALL` branches and a partial index
on dormant state, activity time, and session ID. Bounded history uses an indexed
timestamp range. A covering `(state, id)` index serves persistence health.
Result order, full messages, and the unbounded recovery path stay compatible.
No preview column or TTL cache is needed.

A shared read-only worker handles poll snapshots, known-session keys, and
recurring import-candidate scans. It opens the explicit database path after main
thread migrations. Each polling transaction ends before the response is posted.
This follows SQLite's [WAL reader model](https://sqlite.org/wal.html) and Bun's
[read-only connection API](https://bun.sh/docs/runtime/sqlite).

The reader is separate from the matching worker so catalog imports do not wait
behind log scanning and tmux matching. The cost is another thread, a bounded 2 MiB
SQLite page cache, and a snapshot transfer back to the poller. The existing match
request then receives its usual snapshot. Polling and import each coalesce work
while a read is pending. Slow reads produce a warning without spawning replacement
workers. Errors reject explicitly and scheduled polling can retry; they never
trigger a synchronous main-thread scan as a fallback. Shutdown rejects pending
requests and asks the worker to close its connection and exit cooperatively.

Consistency traces checked during implementation:

| Step | Main connection | Reader / poller | Result |
| --- | --- | --- | --- |
| 1 | Session A is dormant, `isHibernating=false` | Reads A as an orphan candidate | Matching may proceed |
| 2 | User sets A to `isHibernating=true` | Old snapshot arrives | Snapshot remains a hint |
| 3 | Reads A again before applying a match | Content/name/Devin fallback checks current hibernation | A remains hibernating |
| 4 | Provider B becomes associated while an import scan is pending | Scan returns B's ID | Import re-reads B and preserves its association and custom name |
| 5 | Shutdown marks consumers stopped | A pending read returns | No catalog writes or matching request follows |

The import worker returns at most 100 IDs. Current provider rows and catalog
associations are checked on the main thread before writes. The first startup
import remains synchronous, before serving clients. Catalog mutations, terminal
filesystem calls, and small request-path reads also remain synchronous.

Measured on Bun 1.3.14, macOS, using 25 iterations on the private copy:

| Operation | Median | Maximum |
| --- | ---: | ---: |
| Old bounded polling SQL | 5.21 ms | 5.98 ms |
| Indexed bounded polling SQL | 0.49 ms | 1.22 ms |
| Worker snapshot, all keys, and transfer | 15.80 ms | 18.64 ms |
| Import-candidate scan | 2.02 ms | 21.56 ms |
| Worker import scan and transfer | 2.48 ms | 3.60 ms |

The query comparisons assert identical rows. Worker results are also compared
with synchronous results. Reproduce with `bun scripts/bench-polling-reads.ts
/tmp/private-copy.db`; the script initializes indexes on its supplied copy.
The worker measurement includes more work than the SQL-only measurements.
These are warm-cache observations, not predictions of production swap stalls.

An isolated browser run used the copied catalog with log/project paths redirected
to private empty directories and auto-resume disabled. With polling every two
seconds and paired health/history requests every 250 ms, 20 typed terminal
round trips took 29–52 ms. The paired API requests took 2.5–26.6 ms. History
expansion and terminal input/output were checked through the real UI. A separate
throwaway SQLite exclusive-lock test verified that main-thread timers advance
while the worker waits on the database, then that reads succeed after release.

Validation includes query-plan and result parity, fresh WAL snapshots after
hibernate/reclaim, bounded import batches, association races, late responses at
shutdown, read failure/retry, and compiled worker packaging. Browser coverage
includes attachment, switching sessions, paste/Unicode input, names, settings,
and recovery notices. The first recovery-notice run needed a retry; three
subsequent isolated runs passed without retries. That intermittent test result
does not establish a production recovery defect or its cause.

This change removes the selected recurring reads from the event loop. It does
not establish that all remaining production stalls are resolved. In particular,
subagent `statSync` calls, catalog writes, and worker message serialization remain
possible costs.
