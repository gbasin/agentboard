# Display-name lookup stalls

## Evidence (2026-10-19)

Production 0.36.0 logged `displayNameExists` taking 4183.49 ms at
13:59:03.055 UTC, followed by 4232 ms of event-loop lag at 13:59:03.163.
The recorded SQL was `SELECT 1 FROM agent_sessions WHERE display_name = ? LIMIT 1`.
A second invocation took 1014.43 ms at 14:01:53.165.
The existing native sample mostly captured the event loop after the lookup;
it does not establish whether the long wall time was disk latency, scheduling,
or SQLite work. Do not attribute every observed stall to this query.

A read-only connection to production showed no display-name index and
`SCAN agent_sessions` for the lookup. An SQLite backup into a private temporary
directory contained 9,639 records. No production schema or rows were changed.

On that copy, 30 warm Python SQLite executions per query gave:

| Query | Before median | After median | Before maximum | After maximum |
| --- | ---: | ---: | ---: | ---: |
| Missing name | 4.136 ms | 0.002 ms | 8.353 ms | 0.044 ms |
| Missing name, excluding self | 4.134 ms | 0.002 ms | 9.522 ms | 0.024 ms |

The change is a non-unique `(display_name, session_id)` index. Both plans become
`SEARCH agent_sessions USING COVERING INDEX idx_display_name_session_id (display_name=?)`.
Including session_id covers the self-exclusion predicate without fetching the
transcript-bearing table rows. This follows SQLite's
[covering-index documentation](https://www.sqlite.org/queryplanner.html#covidx).
These timings demonstrate the unnecessary scan, not a reproduction of the
four-second production outlier or a guarantee against future I/O stalls.

## State trace and correctness

Current creation path:

- `db = {a: {name: reserved, window: null}}`, `tmux = {names: []}`.
- `create = {requested: reserved}`; the tmux-only check is false.
- `displayNameExists(reserved) = true`; the current plan scans table rows.
  `eventLoop = blocked` until this synchronous lookup returns.
- `displayNameExists(reserved-2) = false`; creation uses `reserved-2`.

Rename path:

- `db = {a: {name: reserved}, b: {name: other}}`.
- `rename = {id: a, name: reserved}`; excluding a returns false: self-rename allowed.
- `rename = {id: b, name: reserved}`; excluding b returns true: collision rejected.
- `db` remains unchanged after rejection.

With the index, all Boolean results and mutation ordering above remain the same;
only the lookup access path changes. There is no async gap or stale name cache.
The index is deliberately not UNIQUE: inherited names and legacy duplicate
records retain their existing semantics. Case, whitespace, Unicode, SQL NULL
behavior, and the existing startup deduplication policy are unchanged.

The index is created by the existing idempotent startup index installation,
after schema migrations that can rebuild the table. First upgrade pays a
one-time index build; subsequent inserts and name changes maintain it normally.

## Regression coverage

- Both query forms must use a covering search; this test fails without the index.
- Existing databases gain the index on reopen, preserve their records, and reopen
  again successfully; the upgrade assertion fails without the fix.
- Exact matching, self-exclusion, duplicate names, updates, and deletes retain
  their results through the actual database wrapper.
- E2E creates real transcript fixtures, discovers archived sessions, renames over
  WebSocket, rejects a collision, and creates a real tmux window through the UI
  using a suffix because the requested name exists only in history.
- Existing session-name E2E covers punctuation and rename round-trips.

All fixtures and tmux activity use the isolated development/test setup.
