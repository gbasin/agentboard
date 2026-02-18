# Edge-Case Enumerator: Session Lifecycle/Status Pipeline

## Scope and Assumptions

- Scope: server-side session lifecycle/status pipeline only.
- In-scope components:
  - `src/server/SessionManager.ts`
  - `src/server/statusInference.ts`
  - `src/server/sessionRefreshWorker.ts` and `src/server/sessionRefreshWorkerClient.ts`
  - `src/server/logPoller.ts`
  - `src/server/logMatchWorker.ts`
  - `src/server/logMatchGate.ts`
  - `src/server/logMatcher.ts`
- Out of scope: frontend rendering, terminal attach UX, remote control policy, non-session features.

## Evidence Base

Implementation and tests reviewed:

- Status/session discovery: `src/server/SessionManager.ts`, `src/server/statusInference.ts`, `src/server/sessionRefreshWorker.ts`
- Log matching/rematch: `src/server/logPoller.ts`, `src/server/logMatchWorker.ts`, `src/server/logMatchGate.ts`, `src/server/logMatcher.ts`
- Coverage references:
  - `src/server/__tests__/sessionManager.test.ts`
  - `src/server/__tests__/sessionRefreshWorker.test.ts`
  - `src/server/__tests__/permissionPrompt.test.ts`
  - `src/server/__tests__/logPoller.test.ts`
  - `src/server/__tests__/logMatchWorker.test.ts`
  - `src/server/__tests__/logMatchGate.test.ts`
  - `src/server/__tests__/logMatcher.test.ts`
  - `src/server/__tests__/sessionRefreshWorkerClient.test.ts`
  - `src/server/__tests__/logMatchWorkerClient.test.ts`

## Edge-Case Matrix

### Input/Content Anomalies

| ID | Trigger | Affected component | Expected behavior | Current observed behavior | Impact | Detection/log signals | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I1 | Permission prompt is older than the most recent 10 non-empty lines | `statusInference.detectsPermissionPrompt` | Permission should be detected when still relevant on screen | Detector scans only `slice(-10)` lines (`src/server/statusInference.ts:46`), so older prompt text is ignored | Medium | No explicit signal; status falls back to `waiting`/`working` path | Covered (`src/server/__tests__/permissionPrompt.test.ts:15`) |
| I2 | First pane snapshot already contains a permission prompt | `inferSessionStatus` | Prompt should not be misclassified as initial idle | First-snapshot `waiting` shortcut only applies when no prompt (`src/server/statusInference.ts:190`), so first state can be `permission` | Low | Status directly becomes `permission` | Covered (`src/server/__tests__/sessionManager.test.ts:408`) |
| I3 | Permission prompt appears while content changed in same refresh | `inferSessionStatus` | Permission should remain visible to user | `working` takes precedence when content changed (`src/server/statusInference.ts:195`), so one-cycle `permission` suppression is possible | Medium | Status transition `working -> permission` on next unchanged refresh | Covered (`src/server/__tests__/sessionRefreshWorker.test.ts:256`) |
| I4 | Resize with small content (<8 tokens) | `isMeaningfulResizeChange` | Resize-only reflow should remain `waiting` | For `maxSize < 8`, resize is always treated as changed (`src/server/statusInference.ts:118`) | Medium | None beyond status flicker to `working` | Gap |
| I5 | Relevant prompt/output moves above last 30 captured lines | Session capture in manager/worker | Status inference should reflect active pane state | Capture truncates to last 30 lines (`src/server/SessionManager.ts:572`, `src/server/sessionRefreshWorker.ts:192`) | Medium | None | Gap |
| I6 | Real output text matches metadata/timer filters | `normalizeContent` | Real content should not be discarded as noise | Normalizer strips metadata/timer/glyph patterns (`src/server/statusInference.ts:51-66`) | Medium | None | Partial (resize metadata noise covered in `src/server/__tests__/sessionManager.test.ts:336`) |
| I7 | User prompt remains in current input field (not submitted) | `extractRecentUserMessagesFromTmux` | Matching should avoid unsent input but still recover when needed | Prompt extraction intentionally skips current input (`↵`, context markers) (`src/server/logMatcher.ts:1063-1096`) | Medium | Match may rely on trace fallback | Partial (`src/server/__tests__/logMatcher.test.ts:603`, `src/server/__tests__/logMatcher.test.ts:645`) |
| I8 | Last message contains tool-notification markers in real user text | `isToolNotificationText` | Only synthetic notifications should be filtered | Marker-based filter can drop tagged content (`src/server/logMatcher.ts:347-363`) | Medium | None | Partial (`src/server/__tests__/logMatcher.test.ts:954`) |

### Timing/Race Conditions

| ID | Trigger | Affected component | Expected behavior | Current observed behavior | Impact | Detection/log signals | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | `pollOnce()` or `pollChanged()` called while poll already in flight | `LogPoller` | Changes should be queued or coalesced explicitly | Guard returns early when `pollInFlight` is true (`src/server/logPoller.ts:450`, `src/server/logPoller.ts:780`) | Medium | None | Gap |
| T2 | Startup orphan rematch fails once (worker error/timeout) | `runOrphanRematchInBackground` | Retry strategy should exist for startup recovery | `orphanRematchPending` is set false before run (`src/server/logPoller.ts:250`) and not reset on error (`src/server/logPoller.ts:424`) | High | `orphan_rematch_error` | Gap |
| T3 | Orphan session needs repeated rematch attempts inside cooldown window | `processMatchResponse` rematch path | Fast rematch after new evidence | Cooldown blocks rematch for 60s (`src/server/logPoller.ts:29`, `src/server/logPoller.ts:583-585`, `src/server/logPoller.ts:659-661`) | Medium | `session_rematched` delayed | Gap |
| T4 | Window gets claimed by another session during orphan rematch | Startup orphan rematch | Avoid window stealing | Claimed-window guard skips reassignment (`src/server/logPoller.ts:332`, `src/server/logPoller.ts:348-360`) | Medium | `orphan_rematch_skipped_window_claimed` | Partial (window stealing covered for normal flow in `src/server/__tests__/logPoller.test.ts:295`) |
| T5 | Heavy orphan rematch exceeds dedicated timeout | Startup orphan rematch worker call | Fallback should preserve eventual consistency | Orphan rematch uses 120s timeout and logs error on failure (`src/server/logPoller.ts:324`, `src/server/logPoller.ts:424`) | Medium | `orphan_rematch_error` | Gap |

### Environment/Process Failures

| ID | Trigger | Affected component | Expected behavior | Current observed behavior | Impact | Detection/log signals | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | tmux format keys unavailable on host version | Session listing and refresh worker | Continue with fallback format | Fallback format path exists in manager and worker (`src/server/SessionManager.ts:358-363`, `src/server/sessionRefreshWorker.ts:153-156`) | Low | None | Covered (`src/server/__tests__/sessionManager.test.ts:618`, `src/server/__tests__/sessionRefreshWorker.test.ts:137`) |
| E2 | `capture-pane` / pane-dimension calls fail | Status inference callers | Fail soft without crashing refresh | Capture returns `null`; status becomes `unknown` (`src/server/SessionManager.ts:515`, `src/server/sessionRefreshWorker.ts:269`) | Medium | No dedicated event | Covered (`src/server/__tests__/sessionManager.test.ts:943`, `src/server/__tests__/sessionManager.test.ts:987`) |
| E3 | `list-sessions` fails | External-session discovery | Degrade with explicit visibility | Errors are swallowed and return empty list (`src/server/SessionManager.ts:301-310`) | Medium | None | Gap |
| E4 | Match worker unavailable/disabled | Log polling pipeline | Alert and recovery path should be clear | Poll cycle warns once and skips matching (`src/server/logPoller.ts:855`) | High | `log_match_worker_disabled` | Gap |
| E5 | Watcher sends non-JSONL or out-of-root prefiltered paths | Match worker path filtering | Invalid paths should be observable | Paths are silently discarded after validation (`src/server/logMatchWorker.ts:55-67`) | Low | None | Partial (`src/server/__tests__/logMatchWorker.test.ts:321`, `src/server/__tests__/logMatchWorker.test.ts:361`) |

### Cross-Session Collisions

| ID | Trigger | Affected component | Expected behavior | Current observed behavior | Impact | Detection/log signals | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | New window name collides with tmux or DB display names | `SessionManager.createWindow` | Deterministic unique naming | Uses `findAvailableName` + `displayNameExists` checks (`src/server/SessionManager.ts:155`, `src/server/SessionManager.ts:366`) | Medium | Error on path issues; no collision log | Covered (`src/server/__tests__/sessionManager.test.ts:678`) |
| C2 | Rename target collides with existing window name | `SessionManager.renameWindow` | Reject duplicate rename | Duplicate names rejected before tmux rename (`src/server/SessionManager.ts:275`) | Low | Throws validation error | Covered (`src/server/__tests__/sessionManager.test.ts:745`) |
| C3 | New log matches already-claimed window | `LogPoller.processMatchResponse` | Do not steal active association | Claimed window check clears `currentWindow` for new session (`src/server/logPoller.ts:714`) | High | `log_match_skipped_window_claimed` | Covered (`src/server/__tests__/logPoller.test.ts:295`) |
| C4 | Name-based orphan fallback collides with external or ambiguous names | Startup orphan rematch fallback | Only safe deterministic fallback matches | Fallback uses managed windows only and drops ambiguous names (`src/server/logPoller.ts:384-399`) | Medium | `orphan_rematch_name_fallback` | Partial (`src/server/__tests__/logPoller.test.ts:466`) |
| C5 | Two windows produce tie for same log | `matchWindowsToLogsByExactRg` | Avoid unstable assignment | Tied scores block mapping (`blocked` set) (`src/server/logMatcher.ts:1859-1907`) | Medium | Inconclusive match (no assignment) | Gap |

### Stale Cache / State Drift

| ID | Trigger | Affected component | Expected behavior | Current observed behavior | Impact | Detection/log signals | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Window disappears between refreshes | Pane content caches in manager/worker | Cache should be pruned to avoid stale status carryover | Both paths remove cache entries for non-current windows (`src/server/SessionManager.ts:115-117`, `src/server/sessionRefreshWorker.ts:107-109`) | Low | None | Gap |
| S2 | Empty/low-token log is cached, then log rotates/truncates to smaller file | `emptyLogCache` in poller | New valid content should be re-evaluated promptly | `cachedSize >= entry.size` causes skip (`src/server/logPoller.ts:611-612`), so truncated files can be ignored until size exceeds old watermark | High | None | Gap |
| S3 | Long-running server with many rematch attempts | `rematchAttemptCache` | Bounded cache with eviction | Cache only grows via set; no cleanup path (`src/server/logPoller.ts:145`, `src/server/logPoller.ts:585`, `src/server/logPoller.ts:661`) | Medium | None | Gap |
| S4 | tmux window ID reused quickly after close/recreate | Pane cache keyed by `tmuxWindow` | New window should not inherit previous status context | Cache key is only `tmuxWindow` (`src/server/SessionManager.ts:36`, `src/server/sessionRefreshWorker.ts:42`); reuse risk depends on timing of cleanup and ID reuse | Medium | None | Gap |

### Recovery / Restart Scenarios

| ID | Trigger | Affected component | Expected behavior | Current observed behavior | Impact | Detection/log signals | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Refresh worker crashes or emits malformed message | `SessionRefreshWorkerClient` | Pending requests should fail fast and worker should recover | Client fails pending requests and respawns worker (`src/server/sessionRefreshWorkerClient.ts:128-145`) | Medium | Error propagation to callers | Covered (`src/server/__tests__/sessionRefreshWorkerClient.test.ts:122`, `src/server/__tests__/sessionRefreshWorkerClient.test.ts:138`) |
| R2 | Log match worker crashes/message error | `LogMatchWorkerClient` | Same recovery semantics as refresh worker | Client rejects pending and restarts worker | Medium | Error propagation to poller | Covered (`src/server/__tests__/logMatchWorkerClient.test.ts:155`, `src/server/__tests__/logMatchWorkerClient.test.ts:178`) |
| R3 | Poller is stopped then reused | `LogPoller.stop` lifecycle | Restart behavior should be explicit | `stop()` disposes worker and nulls state; class is documented as single-use (`src/server/logPoller.ts:430-439`) | Low | None | Gap |
| R4 | Startup orphan rematch skipped when worker disabled | Startup reconciliation | System should make reconciliation strategy explicit | When worker missing, rematch is skipped once (`src/server/logPoller.ts:247`) and no startup retry in same instance | High | `orphan_rematch_skip` reason `match_worker_disabled` | Gap |

## Prioritized Follow-up Backlog

### P0

1. Fix empty-log cache starvation on truncate/rotation.
   - Why: can hide real sessions indefinitely after log shrink (`S2`).
   - Action: replace `cachedSize >= entry.size` with stronger invalidation rule (mtime/birthtime inode-aware or explicit truncate detection).
   - Tests: add `logPoller` test for truncate then regrow below old size.

2. Add retry policy for failed startup orphan rematch.
   - Why: one transient failure leaves startup orphans unmatched (`T2`, `R4`).
   - Action: keep `orphanRematchPending` true on error, or schedule bounded retries with backoff.
   - Tests: add rematch-failure then recovery test in `src/server/__tests__/logPoller.test.ts`.

3. Add observability for match-worker disabled state and invalid prefiltered paths.
   - Why: current failure modes are mostly silent for operators (`E4`, `E5`).
   - Action: emit structured counters/logs for skipped prefiltered paths and skipped polling cycles.
   - Tests: assert warning/log payload paths.

### P1

1. Add coverage for short-token resize false positives (`I4`).
   - Action: unit-test `statusInference.isMeaningfulResizeChange` and `inferSessionStatus` directly.

2. Add coverage for 30-line capture truncation behavior (`I5`).
   - Action: test permission prompt beyond line 30 in both manager and refresh worker paths.

3. Bound or evict rematch attempt cache (`S3`).
   - Action: clear entries on successful rematch/session removal and prune stale timestamps.

4. Add explicit test for ambiguous-name fallback suppression (`C4`).
   - Action: startup orphan rematch with two unclaimed managed windows sharing same name.

### P2

1. Evaluate configurable permission scan depth (`I1`) and capture depth (`I5`) by environment variable.
2. Add targeted telemetry around `list-sessions` failure and external-discovery suppression (`E3`).
3. Document single-use `LogPoller` lifecycle near constructor call sites (`R3`).

## Scope Boundaries and Deferred Areas

- Remote-host polling (`remoteSessions.ts`) was not enumerated here.
- Frontend session rendering/controls were not enumerated here.
- This document is intentionally documentation-first; no runtime behavior changes are included in this task.
