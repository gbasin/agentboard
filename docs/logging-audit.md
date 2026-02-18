# Logging Quality Audit

## Scope (Frozen)

- Runtime server observability only: `src/server/**`
- Excluded: client/UI logs and all test files
- Priority remediation targets for this pass:
  - API error paths in `src/server/index.ts`
  - DB migration error paths in `src/server/db.ts`
  - Intentional silent catches in `src/server/SessionManager.ts`

## Quality Criteria

- Event names are `snake_case`
- Catch blocks are either logged or explicitly marked intentional (`logging-audit:intentional`)
- `logger.warn` / `logger.error` in catch paths include error context (`error_message`, `error_name`, `error_stack`, `code`, etc.)

## Auditor

- Command: `bun run audit:logging`
- Implementation:
  - `scripts/logging-audit.ts`
  - `src/server/loggingAudit.ts`

## Baseline Findings (Before Remediation)

`bun run audit:logging` reported:

- `high=10`
- `medium=97`
- `low=0`

High-severity findings (all fixed in this task):

1. `src/server/db.ts:414` `catch_without_logging`
2. `src/server/db.ts:581` `catch_without_logging`
3. `src/server/index.ts:830` `catch_without_logging`
4. `src/server/index.ts:882` `catch_without_logging`
5. `src/server/index.ts:916` `catch_without_logging`
6. `src/server/index.ts:978` `catch_without_logging`
7. `src/server/index.ts:1051` `catch_without_logging`
8. `src/server/index.ts:1073` `catch_without_logging`
9. `src/server/index.ts:1097` `catch_without_logging`
10. `src/server/index.ts:1130` `catch_without_logging`

## Remediation Completed

- `src/server/index.ts`
  - Added structured warning logs for client-log ingestion failures.
  - Added structured warning logs for session-preview read failures with session/log path context.
  - Added structured warning logs for directory stat/read failures.
  - Added structured warning logs for settings parsing failures and upload/clipboard failures.
  - Added structured warning logs for websocket payload parse failures and session create/kill/rename/resume error paths.
  - Replaced non-snake event `ssh_proxy_onExit` with `ssh_proxy_on_exit`.
- `src/server/db.ts`
  - Added migration rollback/failure logging with migration IDs and error details before rethrow.
  - Added debug logs for non-fatal data directory permission setup failures.
- `src/server/SessionManager.ts`
  - Added debug logs for non-fatal tmux fallback/error paths.
  - Marked high-frequency pane-capture silent catch as intentional with `logging-audit:intentional`.
- Supporting runtime modules
  - Marked deliberate best-effort catch paths with `logging-audit:intentional` (log discovery/matcher, worker plumbing, and terminal proxies) so silent behavior is explicitly documented.

## Current Status (After Remediation)

`bun run audit:logging` now reports:

- `high=0`
- `medium=0`
- `low=0`

No outstanding findings in scope.
