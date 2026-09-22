# Session Persistence — Split Plan

> Working plan for landing PR #229 (sterling-crispin-at-eichler) as a series of
> smaller PRs. We are taking the branch over; original author keeps credit.
> Status: decided 2026-09-22 after a full review pass.

## Why the split

The original PR is +5,595 LOC: a durable session catalog plus history search,
workspaces, backups, archives, and an import/export CLI. The core mechanism is
well-built but it is 3–4 features in one diff, and the branch predates ~15
master commits (Grok/Devin providers, yolo mode, PR tracking).

## PR 0 — rename `is_pinned` → `is_hibernating` (this branch)

`agent_sessions.is_pinned` is a hibernation marker (superseded star/snooze
model — see `star-snooze-refactor.md`), not a user-facing pin. The new catalog
has a real `pinned` field and the collision already produced bugs. Pure rename
through DB column, `AgentSessionRecord`, wire protocol, and client. No behavior
change.

## PR A — durable session catalog (~2,000 LOC)

Scope: schema (`board_sessions`, `session_runs`, `session_events`,
`session_conversations`), tmux identity tags + `__ab_launch__` provisional
naming + server epoch, launch-intent-before-spawn, `operationId` idempotency,
reconcile (`beforeSnapshot`/`observe`), crash-safe `requested_state` stops,
resume, DB hardening (WAL/FULL/fullfsync/busy_timeout/chmod 0600), exclusive DB
ownership lock. UI: `RecoveryNotice` + minimal interrupted-sessions list.

Decisions:
- Identity tags ride the existing per-refresh `list-windows` call — no extra
  `spawnSync`s on the event loop; epoch is cached.
- Reconcile stays per-refresh (freshness) since the reads are now free.

Fixes folded in (from review):
- Per-session try/catch inside `observe()` + `PersistentSessions.renameWindow`
  calls tmux before catalog — kills the rename-collision boot crash-loop.
- `stop()` reverts `requested_state` on failure (failed hibernate must not
  silently kill later).
- `launch()` adoption binds the fresh identity's epoch, not the stale read.
- `bind` receives `finalName`, not `live.name` (tmux auto-rename must not
  clobber catalog names).
- A corrupt `restore-request.json` is quarantined, not a boot failure.
- Double-wake returns the live session instead of erroring.
- Wake-cleanup kills route through `persistence.stop`, not raw `killWindow`.
- Grok/Devin: verify `agent_type` CHECK constraint and discovery paths cover
  all providers post-rebase.

## PR B — history UI (~1,500 LOC)

Scope: `SessionHistory` dialog (search/filters/pagination/detail),
`historyQuery` + `/api/library` read routes, workspaces (save/resume groups),
`catalog.associate` merge logic.

Decisions:
- NO `ConversationIndexer` module. Unseen-file backfill merges into
  `logPoller.runComprehensiveReconciliation`: `scanAllLogDirs()` result minus
  known `log_file_path`s (both already in memory per poll) → rate-limited
  metadata-only inserts. The top-25 batch stays for matching; the sweep only
  ensures rows exist for files beyond the horizon. No queue table, no
  re-indexing of known files (that duplicated the poller's job).

Frontend fixes folded in:
- Gate `Mod+N`/`Mod+X` on `isHistoryOpen` (currently kills sessions behind the
  dialog).
- `Escape` in rename input needs `preventDefault` (currently closes dialog).
- `RecoveryNotice` must be visible on mobile (currently inside `hidden md:flex`
  sidebar).
- Mutations/broadcasts must not collapse pagination+scroll; don't blank the
  list per keystroke; `HistoryDetails` falls back to `conversations[0]`.
- `useHistoryAction`/`operationId`: mint IDs per user intent so retries dedupe.

## PR C — storage (~1,000 LOC)

Scope: verified backups + rotation + scheduled restore + ownership lock,
conversation archives **opt-in** (`archiveEnabled: false`), terminal previews
(opt-in, unchanged), import/export CLI, `StoragePanel`, settings.

Decisions:
- `archiveEnabled` and automatic backups both default OFF — no new background
  disk writes without opt-in.
- Import must validate `session_archives.source_path` / `log_file_path` is
  under known provider log dirs — a crafted export can otherwise create files
  at arbitrary paths via `restoreSource` (exclusive link; can't overwrite, but
  can create).

## Open items

- **Catalog-as-projection refactor**: whether `board_sessions` becomes the
  single writer projecting `is_hibernating`/`current_window`/`display_name`
  into `agent_sessions` for linked sessions, or we ship the author's
  paired-writes. DECIDE AFTER REBASE. Constraints discovered: the poller is a
  second lifecycle authority (writes `current_window` claims for rows with no
  catalog counterpart — codex-exec, external windows, pre-import gap); strict
  single-writer is impossible without eager catalog rows for everything.
  Feasible version is narrow: catalog owns lifecycle for linked sessions,
  poller keeps writing for unlinked rows.
- `docs/persistence-audit.md` — do not ship as a doc; its content belongs in
  PR descriptions.
- `AGENTBOARD_SESSION_ID`/`AGENTBOARD_RUN_ID` pane env vars — dead code
  (nothing consumes them); drop unless a use appears.

## Source

Branch under rework: `pr-229` (worktree `agentboard-pr-229`), originally
`feat/persistent-session-history-upstream` by sterling-crispin-at-eichler.
