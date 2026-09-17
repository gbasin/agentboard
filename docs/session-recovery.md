# Session history and recovery

Agentboard saves a local managed session before starting its terminal. Its stable ID, chosen name, project, command, and lifecycle remain available even if no provider log exists. Renames and stop requests commit immediately. Reopening uses the saved conversation where one is available; shell process state cannot be recreated after reboot.

## Use History & recovery

Open **History** in the desktop header or **History & recovery** on mobile.

- **All time** searches the full catalog. Search matches names, earlier names, projects, and saved message previews; it does not search complete transcripts. Filter by provider, lifecycle, pin, and activity period.
- **Previously open** includes sessions created or observed in Agentboard and imported conversations that have subsequently been launched. An entry labeled **Recovered from conversation logs** is not proof it was previously open.
- **Interrupted** means the saved process disappeared from a successfully queried tmux server. Failed queries preserve the last confirmed state and appear in storage health.
- Select sessions, then **Reopen selected**, or save them as a named **Workspace**. Running sessions are reused. Batch failures are reported individually.
- **Archive** stops a running session and removes it from the working list while keeping its metadata and timeline. Pinning in this screen is independent of lifecycle.
- Open a session's name to see its rename/run timeline, linked conversations, and saved content. A verified archive can supply previews if the original log has disappeared. **Restore log and reopen** explicitly copies a complete log back before attempting provider resume.

The legacy sidebar keeps at most 100 recent History entries. Its lookback no longer has the seven-day ceiling. The paginated library has no age ceiling and does not put the full archive into WebSocket updates.

## Defaults and storage

Data lives beside the database. With the default database path:

```text
~/.agentboard/agentboard.db
~/.agentboard/agentboard.db.recovery/
  backups/                 verified SQLite snapshots
  conversations/           checksummed JSONL versions
  ownership.db             OS-released SQLite process lock
  restore-request.json     only when a restore is scheduled
```

| Data or behavior | Default |
| --- | --- |
| Session metadata and lifecycle | Retained indefinitely; Archive keeps it |
| Automatic reopening | Off; enable explicitly in Storage & backups |
| Automatic database backups | Hourly for 24 hours, daily for 30 days, monthly for 12 months |
| Manual, export, pre-migration, pre-restore backups | Retained until manually removed |
| Conversation copies | Enabled, 512 MB retained storage budget |
| Conversation copy retention | Keep current versions and versions referenced by retained backups; pause new copies when full |
| Terminal previews | Off; optional last 80 lines, capped at 32 KB, timestamped |

Change these policies in **Storage & backups**. Metadata retention does not depend on the conversation budget. Archive publication can temporarily require space for both the old and new copy. Unreferenced files left by an interrupted publication have a one-hour grace period before cleanup.

Discovery reconciles all log directories every minute and processes a durable queue in batches of 25. Subagent and Codex exec logs do not become foreground history entries. An older root conversation eventually gets processed even when newer logs keep arriving. Metadata ingestion works without ripgrep; terminal matching exposes its own failure state. The matcher retains partial discovery results when matching fails and queues watcher changes received during an existing poll.

## Back up, export, and restore

**Back up now** creates a consistent SQLite snapshot and verifies it before making it downloadable. **Restore…** schedules restoration for the next backend restart; it does not restart the running app. Startup first saves the current database, verifies the selected snapshot again, and replaces the database before opening the serving connection. Another serving process blocks restoration. A scheduled recovery point is exempt from automatic rotation. If SQLite reports that the current database is corrupt or unreadable, its raw database and sidecar files are preserved under `unreadable-before-restore-<id>/` before replacement. Other backup failures, such as insufficient disk space, still stop restoration.

From a source checkout:

```sh
bun run history backups
bun run history backup
bun run history restore BACKUP_NAME.db
# With Agentboard stopped, apply the scheduled restore without launching agents:
bun run history apply-restore

# Save the catalog and its referenced conversation copies to a new directory:
bun run history export /path/to/new-backup-directory
# Verify a portable export and schedule its import on the next restart:
bun run history import /path/to/new-backup-directory
```

Every command accepts `--db /absolute/path/agentboard.db`. Export writes a manifest last; a missing manifest means the export did not finish. Import verifies checksums, relocates archive references, and disables automatic reopening so projects and provider setup can be checked on the destination machine. Export/import does not relocate projects, install provider tools, or restore auxiliary provider files.

A downloaded database contains metadata and archive references. Use the export command to include archived conversation files for storage on another device. Local snapshots alone do not cover loss of the computer. Exports contain private conversation data and should go to a backup destination you control.

## Durability and implementation

- `board_sessions` owns the name and lifecycle. `session_runs` records each launch with an idempotency key; `session_conversations` keeps earlier provider associations; `session_events` retains the timeline.
- Creation commits its intent before spawn. A temporary tmux window name contains board/run IDs from the creation command itself; user options and the intended name follow in the same tmux command sequence. Startup can adopt a pane even if tagging or acknowledgment was interrupted.
- A tmux server has a random lifetime ID. Reused window numbers after reboot cannot claim an earlier run. Reconciliation does not kill an unexpected pane. Explicit hibernate/archive requests identify and terminate only their tagged run.
- SQLite uses WAL, FULL synchronization, a five-second busy timeout, and macOS fullfsync. File publication syncs completed files before rename. Backups precede additive schema migration, and newer unsupported catalog versions are rejected.
- Archive copies contain complete JSONL records. An append reuses a verified prefix; rotation triggers a new copy, and source truncation preserves the earlier, larger archive. Versioned files protect snapshots from partially published replacements.
- The serving process owns its database before restore or migration through an exclusive SQLite transaction in a separate lock database. The OS releases this lock after a crash; canonical paths and reference counting handle multiple connections in one process. Test instances use separate databases, provider roots, and private tmux sockets.

## Validation and limits

Automated coverage includes backend SIGKILL/restart, private tmux server replacement, A/B/C naming before logs exist, reused window IDs, a crash between pane creation and tagging, repeated reopen requests, workspace recovery, backup restoration, discovery beyond 25 files, malformed-log retry, pagination, SQLite write failures/lock contention, archive truncation/checksum failure, and migration idempotence. Browser coverage exercises year-old history, pagination, rename, workspace creation, backup download, and desktop/mobile layout. The browser suite additionally checks stale bulk selections and per-conversation archive controls, and also passes terminal attachment, paste, and accessibility repaint checks. Automatic reopening and timestamped terminal previews are covered by the isolated server tests. Additional regressions cover competing process ownership, directory symlinks, restoring unreadable databases, pending-backup retention, older conversation previews, and opening a running terminal whose provider log is missing.

File databases explicitly enable WAL, `synchronous=FULL`, and a 5000 ms busy timeout. macOS also enables `fullfsync`.

SIGKILL tests do not simulate loss of the operating system's disk cache. A controlled VM power-loss test has not been performed; storage hardware and filesystem guarantees still matter.

Conversation archives contain JSONL logs. Attachments, compaction artifacts, credentials, and other provider files are not bundled. A complete log copy is not a promise that every provider/version can resume it independently. Provider binaries, original project paths, and any required auxiliary files must still be available. Interrupted processes and interactive shell state cannot survive reboot.

The durable catalog covers this server's managed sessions. External or remote terminals continue to use their existing discovery behavior; each upgraded remote Agentboard owns its own local catalog.

## Upgrade

Build the frontend and restart Agentboard using your normal installation method. Initial startup snapshots the existing database, imports provider metadata, and adopts running managed windows. Run one backend per database.

## Audit follow-ups

See [the implementation audit](persistence-audit.md) for findings, fixes, and remaining performance limits. Frequent health reads reuse directory inventories; external edits to immutable files can take up to a minute to appear. Conversation checksumming and synchronous SQLite snapshots still need measurements with large histories before claiming predictable latency at that scale.
