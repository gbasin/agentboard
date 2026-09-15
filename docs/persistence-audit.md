# Persistent session history: implementation audit

Reviewed the feature at `299ef00` on `feat/persistent-session-history`, including lifecycle reconciliation, persistence, archives, import/export, API routes, and History UI. Changes and tests stayed in the separate worktree; the running checkout was not switched or restarted.

## Findings fixed

| Priority | Finding and consequence | Correction |
| --- | --- | --- |
| High | PID-file reclamation could let competing processes remove each other's ownership marker. PID reuse could also block recovery. | Hold an exclusive SQLite transaction in a separate lock database. The OS releases it on process death. Share ownership across same-process connections with reference counting, resolve directory symlinks consistently, and release ownership after initialization failures. |
| High | Rotation could remove the exact automatic backup scheduled for the next restart. | Exempt the pending restore target from rotation. A regression advances retention by 400 days and restores the selected snapshot. |
| High | Restoring a valid backup could fail because the prerequisite snapshot of the damaged current database failed. | Preserve raw database/sidecar files when SQLite reports corruption or an unreadable database, then restore the verified snapshot. Other failures still stop replacement. |
| Medium | Import/export verified source files before copying. A source changed during copying could publish bytes different from those verified. Copy/checksum/publication logic was duplicated. | One shared helper verifies the copied temporary file, syncs it, and publishes it without overwriting an existing destination. Imports, exports, and provider-log restoration use it. |
| Medium | Switching to an earlier conversation left download and restoration controls attached to the current conversation. | Put archive metadata on each conversation in a shared detail contract. Downloads include the selected provider ID. Reopen controls apply to the current resumable conversation. Remove the duplicated preview branch that constructed a synthetic provider record. |
| Medium | Opening an already-running terminal could fail because its original provider log was missing. | Resolve the live terminal by both board ID and run ID before requiring source-log recovery. Reuse the same lookup in launch/reopen paths. |
| Medium | “Select all matching” could finish after a filter change and select stale results. Opening details or making a selection also refreshed the whole list and discarded loaded pages. | Invalidate in-flight results when filters change or the dialog closes. Refresh after mutations; preserve pages for reads and selection. Browser tests hold a response until after a filter change. |
| Medium | Reindexing a formerly linked conversation could overwrite the current session's message preview. | Update the board preview only from its current provider association. Historical logs remain independently indexed. |
| Medium | A combined PATCH could rename a session before rejecting an invalid pin/state field. | Validate field types and lifecycle choices before applying mutations. |

## Simplifications and bounded work

- Share file publication, checksumming, and verified copying in `persistence/files.ts`; share UI busy/error handling in `history/useHistoryAction.ts`.
- Replace repeated scans of all windows during reconciliation with one run-to-window map. Verify both board and run identities before reuse or termination.
- Replace repeated linear searches while merging history pages with a map keyed by session ID.
- Resolve a backup directly instead of listing and sorting all backups for each reference. Cache immutable directory inventories between changes, with a one-minute refresh for external edits. Rate-limit archive pruning to once a minute.
- Read the two terminal-preview fields in one query and use the library's single error handler instead of redundant nested catches.
- Skip schema setup/backfill when the catalog version already matches. Remove ad hoc column additions for intermediate, unreleased variants of schema version 1.

These changes intentionally keep the existing catalog/provider separation. A session can exist before a provider writes its first log and can have several conversations over its lifetime; combining those records would lose that distinction. The audit adds failure handling and regression coverage, so total line count is not the measure of success.

## Verification

- `bun run lint`, `bun run typecheck`, and `bun run test`: 1,032 passing tests, including real competing processes, SIGKILL, private tmux replacement, and corrupt-database restoration.
- `bun run build`: passed.
- `CI=1 bun run test:e2e`: six passing browser tests. Existing scenarios use an isolated server/database/provider directories and private tmux socket. Two additional UI regressions control API responses to exercise timing and conversation selection deterministically; separate API tests use real storage.
- Inspected desktop/mobile screenshots and the selected older-conversation view. The unavailable `dev-browser` skill was replaced with the repository's headless Playwright setup.

## Remaining limits and follow-up work

1. **Large-history latency needs profiling.** SQLite snapshots use synchronous `VACUUM INTO`; JSONL snapshots re-read substantial prefixes for verification even when append copying can reuse prior content. Leading-wildcard search also scans matching metadata. Benchmark a representative large catalog and large growing logs before choosing worker-based snapshots, hashing checkpoints, or full-text search. The current tests establish behavior, not a latency bound at that scale.
2. **Power-loss guarantees remain untested.** SIGKILL exercises process failure, not loss of the OS disk cache. A VM power-cut test and filesystem-specific validation would provide stronger evidence. The ownership tests ran locally on macOS; other supported platforms still need CI verification.
3. **Retention can fill the configured budget.** Manually retained database backups can keep old log versions alive indefinitely. Copying pauses rather than deleting referenced data. A backup deletion/storage breakdown UI would make this policy easier to manage.
4. **Recovery scope remains provider-dependent.** Archived JSONL does not include attachments, credentials, or every provider's auxiliary files. A complete log copy does not establish that every provider/version can resume from it alone.

These are explicit limits; this audit does not claim a complete power-loss simulation, universal provider restoration, or performance validation at arbitrary history size.
