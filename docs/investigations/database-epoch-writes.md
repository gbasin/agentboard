# Repeated epoch writes and the remaining database stall

## Evidence boundary

Inspected source: f528165 (v0.34.2 plus post-release dependency synchronization). The existing production log records
`setAppSetting`'s `INSERT OR REPLACE` taking 2096.899916 ms at
2026-10-15T19:20:50.664Z. This is one operation, unlike entries marked
`accumulated: true`, which sum many calls. The event-loop monitor reports 4474 ms
lag at 19:20:52.422Z. The watchdog sample named
`stall-2026-10-15T19-20-49-703Z.txt` starts at 19:20:52.543Z, after the write.
It cannot identify the syscall responsible for the write's delay. Neither the
setting key nor the caller above `setAppSetting` was recorded.

The source does establish that every successful `beforeSnapshot` rewrites
`persistence_tmux_epoch`, even when its immediately preceding read returned the
same value. Other setting writes respond to startup or user requests. This
recurring path is therefore a plausible source of the logged write, but the
original event cannot be assigned to it conclusively.

SQLite's [WAL documentation](https://www.sqlite.org/wal.html#performance_considerations)
explains that automatic checkpoints run on the committing thread and still
perform synchronization in NORMAL mode. Checkpoint I/O, page faults, and process
scheduling are possible explanations for a long write; the production evidence
does not distinguish them. The 250 ms busy timeout does not bound total wall time.

## Current flow, computed before the fix

Assume an empty catalog so there are no unrelated lifecycle writes.

```
t0 main={running: beforeSnapshot, snapshot: null}
   database={epoch: E1, journal: WAL, writer: none}
   tmux={observedPid: 1, derivedEpoch: E1}
t1 main={snapshot: E1, previousEpoch: E1, orphanRequired: false}
   database={epoch: E1, writer: none}
t2 main={blocked: synchronous INSERT OR REPLACE}
   database={epoch: E1, writer: main, dirtyPages: settings+index}
   websocket={callbacks: unable to run}
t3 main={snapshot: E1, error: null}
   database={epoch: E1, writer: none, appendedFrames: 2}
```

The persisted state has not changed, but every refresh takes the writer lock and
adds frames. A private second connection holding BEGIN IMMEDIATE makes t2 fail
with `database is locked`, setting the reconciliation snapshot to null even
though no epoch change was needed. A read-only worker does not prevent this
main-thread write path.

## Proposed and fixed flow

Keep the existing authoritative database read, lifecycle reconciliation, and
epoch-change orphaning. Write only when previousEpoch differs from snapshot.epoch.
Do not introduce an in-memory epoch cache or alter SQLite durability settings.

```
t0 main={running: beforeSnapshot}; database={epoch: E1}
t1 main={snapshot: E1, previousEpoch: E1, orphanRequired: false}
t2 main={snapshot: E1, error: null}; database={epoch: E1, writes: 0}

restart: new manager reads E1 from the database and follows the same steps.
unknown PID: snapshot=null; database epoch remains E1.
new PID: snapshot=E2, previousEpoch=E1; orphan old associations, write E2.
failed E2 write: snapshot=null, error set; database still E1.
retry: re-read E1, repeat reconciliation, commit E2, clear error.
```

This removes a proven unnecessary write and its contention exposure. It does not
move necessary writes off the event loop or establish that all database stalls
are fixed.

## Isolated regression evidence

Before the fix, 50 unchanged snapshots on a fresh private WAL database generate
412,032 WAL bytes (32-byte header plus 100 frames of 4,120 bytes). Automatic
checkpointing is disabled only in this test so frame growth is directly visible.
The same-epoch snapshot fails with `database is locked` when another private
connection holds the write lock. Both are deterministic failures against the
unchanged application. The changed-epoch failure/retry case already passes.

After the guard, the same 50 snapshots generate zero WAL bytes. The existing
write-lock holder no longer makes an unchanged epoch snapshot fail. This removes
100 checkpointable frames per 50 stable snapshots; it does not measure actual
checkpoint count or disk synchronization latency in production. Automatic
checkpointing stays enabled with its existing production configuration.

Validation on Bun 1.3.14:

- Corrected before/after fixture: 2 regression failures before, 3/3 passing after.
  The unchanged-epoch test opens a new database connection and manager; its
  connection-local autocheckpoint setting is applied to that writing connection.
- Targeted epoch and catalog tests: 33 passed, including association preservation,
  replacement epochs, hibernation intent recovery, and failed-write retry.
- `bun run lint`, `bun run typecheck`, and `bun run test` passed (1,874 Bun tests,
  plus the Node release-script suite).
- Private `polling-lifecycle.spec.ts` browser suite: 3 passed, no retries. It
  exercises message updates, matching/reassignment, archived snippets, and
  hibernation and explicit reactivation against real isolated server/tmux/provider fixtures.
- Independent review found no blocker; connection-scoped pragma setup and the
  scope of the source comment were corrected before final validation.

No production database was opened, changed, or copied. Only existing log text and
previously collected evidence were used. Production processes, tmux, and other
workloads were untouched by this investigation. Remaining necessary synchronous
writes can still stall. A future captured stack during such a write, correlated
with operation/key and scheduling or I/O traces, is needed before attributing the
original 2.1-second delay to checkpointing or proposing a writer-worker refactor.
