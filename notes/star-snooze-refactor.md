# Star/Snooze Refactor — Working Plan

**Status:** planning, reviewed and updated 2026-04-25.
**Branch:** `feat/session-sleep` (the snooze feature lives here, but with a tristate that we're collapsing).
**Owner:** Gary, with Claude.

## Goal

Collapse `is_sleeping` and `is_pinned` into a single bookmark concept (renaming Pin → **Star**, Sleep → **Snooze**). Snoozed/Sleeping stops being its own stored flag and becomes a derived view: `is_starred && !current_window`.

## Mental model

- **Star** = the bookmark. A tag. The user's curated shortlist of sessions they care about.
- **Snooze** (action) = close the tmux window. Auto-stars the session if not already starred.
- **Wake** (action) = spawn or attach a tmux window and `claude --resume` / `codex resume`.
- **Snoozed rail** = derived view of starred sessions whose tmux is currently down.
- Auto-resume on server startup = fire Wake for every starred-idle session.

| tmux running? | starred? | UI bucket |
|---|---|---|
| Yes | Yes | Active (with star) |
| Yes | No | Active |
| No | Yes | Snoozed |
| No | No | Inactive |

## Design choices (locked)

1. **Failed wake preserves the star on both paths** (auto-resurrect + user-clicked Wake).
   Implication: poison sessions retry every server restart. Requires a cooldown guard (see Additions §3).
2. **Crashed (orphaned) starred sessions land in the Snoozed rail**, not Inactive. No special UI distinction from intentional snooze.
3. **Drop `isSleeping` from the wire entirely.** Client uses bucket arrays.
4. **Rename the wake protocol:** `session-resume` / `session-resume-result` → `session-wake` / `session-wake-result`.
5. **Rename in UI strings:** Pin → Star, Sleep/Sleeping → Snooze/Snoozed.
6. **Include on-demand rematch in this PR.** It is small and prevents duplicate windows after external manual resumes.

## Current state of the code (as of this plan)

`is_sleeping` and `is_pinned` are fully orthogonal flags forming a tristate:

| `is_pinned` | `is_sleeping` | Meaning today |
|---|---|---|
| 1 | 0 | Auto-resumes on restart |
| 1 | 1 | Pinned, but parked — does NOT auto-resume |
| 0 | 1 | Snoozed, manual wake only |
| 0 | 0 | Inactive |

The auto-resume query (`db.ts:335`) explicitly excludes `is_sleeping=1`, so today's "snooze + stay snoozed across restarts" tristate is a real feature. We're losing it.

## Touch list

### 1. Database / schema (`src/server/db.ts`)
- Drop `is_sleeping` field from `AgentSessionRecord` (line 19, 27, 28, 198, 233, 250, 408, 499–502, 640, 659).
- `getSleepingSessions` query (line 151) → `WHERE is_pinned = 1 AND current_window IS NULL`.
- `getInactiveSessions` queries (lines 154, 157) → `WHERE is_pinned = 0 AND current_window IS NULL`.
- `getPinnedOrphaned` (line 335) → final form drops `AND is_sleeping = 0`, but only after wake mutex + cooldown are in place.
- `orphanSession` (line 303) → drop the `is_sleeping = 0` write; keep `current_window = null`.
- Add `last_resume_attempt_at TEXT` for auto-wake cooldown bookkeeping.
- One-shot data migration: `UPDATE agent_sessions SET is_pinned = 1 WHERE is_sleeping = 1` to preserve existing snoozed-unstarred rows.
- Then `ALTER TABLE agent_sessions DROP COLUMN is_sleeping` (SQLite ≥3.35 supports this; bun's bundled SQLite is fine).

### 2. Server state machine (`src/server/index.ts`)
- `handleSessionSleep` (line 2113-2119): set `is_pinned = 1` instead of `is_sleeping = 1`. Drop `currentWindow` to null. Idempotency gate (line 2068) becomes `record.isPinned && !record.currentWindow`.
- `handleSessionResume` (line 2284+) → `handleSessionWake`:
  - Rename request/result handling to `handleSessionWake`, `session-wake`, and `session-wake-result`.
  - Drop `eventKind = record.isSleeping ? 'wake' : 'resume'` distinction (line 2310). Always emit `session_wake_*` events.
  - Drop `isSleeping: false` writes on success (lines 2380, 2398, 2380).
  - On failure (line 2418): keep current "preserve star, only set lastResumeError" behavior.
- `resurrectPinnedSessions` (line 2211+):
  - Rename to `resurrectStarredSessions`.
  - Drop the unstar-on-failure logic (lines 2223, 2268). Per design choice, just record `lastResumeError`.
  - Add cooldown check (Additions §3).
  - Acquire wake mutex (Additions §1).
  - Do not expand auto-wake to all starred-idle sessions until §1 and §3 are implemented.

### 3. Log poller (`src/server/logPoller.ts`)
- Line 43: drop `isSleeping` field from internal type.
- Line 283 (orphan-candidates loop): rephrase as `if (record.isPinned && !record.currentWindow) continue` — same semantic (skip starred-idle from rematch).
- Lines 612, 691 (rematch gate): same change.

### 4. Shared types (`src/shared/types.ts`)
- Line 49: drop `isSleeping?: boolean` from `AgentSession`.
- WS messages: keep `session-sleep-result` and `sleeping[]` bucket arrays, but rename `session-resume` / `session-resume-result` to `session-wake` / `session-wake-result`.
- `AgentSession` still does not expose `currentWindow`; client tests should assert bucket placement instead of adding a client-side `currentWindow` field.

### 5. Client (`src/client/components/`, `src/client/stores/`, `src/client/App.tsx`)
- Drop `isSleeping` field references everywhere. Use bucket-array membership instead.
- Rename visible rail/card copy from Sleeping to Snoozed.
- `SleepingSessionItem.tsx`: drop pinned-badge (every entry is starred by definition).
- `SleepingSessionItem.tsx` and the wake card: show `lastResumeError` with the same warning affordance already used by `InactiveSessionItem`.
- `Terminal.tsx` wake card (line 1148+): drop the "Pinned" pill (line 1158). Add a small "Remove" link/button next to "Wake Session" that calls the unstar endpoint.
- Add context menu to `SleepingSessionItem` (currently has none): Wake · Rename · Copy Log Path · — · Remove.
- All Pin/Sleep UI strings → Star/Snooze.

### 6. Tests
- `src/server/__tests__/db.test.ts`: replace `migrateIsSleepingColumn` test with the data-migration test.
- Update sleep/wake handler tests for new flag semantics.
- `src/client/__tests__/app.test.tsx` (~12 places), `sessionListComponent.test.tsx`, `terminal.test.tsx`, `sessionState.test.ts`: replace `isSleeping: true` mocks with `isPinned: true` and place the mock in the `sleeping`/Snoozed bucket. Do not add `currentWindow` to `AgentSession`; it is not on the client wire type.
- Update server-side record tests to use `isPinned: true` + `currentWindow: null` where they construct `AgentSessionRecord`.
- Update protocol tests from `session-resume*` to `session-wake*`.

## Additions surfaced by hand-compute walk

These are NOT in the original plan summary but are required (or strongly recommended) given the design choices.

### §1. Wake mutex (HIGH priority)
**Problem:** between `resurrectStarredSessions`'s `createWindow` call and its db update, the record briefly has `cw=null` while a real tmux window exists. If user clicks Wake in this gap, `handleSessionWake` sees `cw=null` and fires `createWindow` again → two windows, same JSONL.

Race exists today for resurrect; new model exposes more sessions to it.

**Fix:** `Set<sessionId>` of in-flight wake operations, shared between `resurrectStarredSessions` and `handleSessionWake`. Caller acquires before `createWindow`, releases after db update. Second caller observes the lock and either waits, no-ops, or returns "already in flight."

~30 LOC.

### §2. On-demand rematch in handleSessionWake (MEDIUM priority, required in this PR)
**Problem:** today's logPoller rematches a freshly discovered tmux window to a `pinned-but-not-sleeping` session — the niche where a power user runs `claude --resume <id>` from a separate terminal for a crashed pinned session. New model skips rematch for all `is_pinned && !cw` (= starred-idle = Snoozed). External windows are now orphaned; clicking Wake spawns a duplicate.

**Fix:** in `handleSessionWake`, before `createWindow`, scan `sessionManager` for an existing tmux window whose log file matches the session id. If found, attach instead of spawning.

~30 LOC. Recovers safety the rematcher provides today and is worth doing in the refactor PR.

### §3. Wake cooldown (HIGH priority)
**Problem:** with "preserve star on failure" chosen, a permanently-failing session retries every server restart, wasting CPU/tmux churn proportional to N poison sessions × restart frequency.

**Fix:** add `last_resume_attempt_at TEXT` column. `resurrectStarredSessions` skips if last attempt was within ~24h. Manual Wake bypasses the cooldown (records a new attempt and may clear the timer on success). UI: error badge stays visible; if we expose cooldown timing, expose a derived `autoWakeRetryAt` rather than raw DB internals.

~20 LOC + 1 migration + tests.

## Phasing (single PR, three commits)

1. **Compatibility pass; no startup fanout expansion.** Make Snooze auto-star and start deriving the Snoozed rail from star+null-window, but keep auto-wake from expanding to old `is_sleeping=1` rows until hardening lands. Keep `is_sleeping` column populated for one cycle so old reads still work. Tests pass.
2. **Wake hardening and protocol rename.** Wake mutex (§1), wake cooldown (§3), on-demand rematch (§2), `session-wake` / `session-wake-result` protocol, and tests.
3. **Final state collapse and UI rename.** Data migration `UPDATE ... SET is_pinned=1 WHERE is_sleeping=1`. Drop column. Remove `isSleeping` from types and tests. Pin → Star, Sleep/Sleeping → Snooze/Snoozed rename pass.

## Effort estimate
- Steps 1–3 of phasing: ~2 hours focused.
- Additions §1, §3: ~30 min each.
- Addition §2: ~30 min.
- Test churn (mostly client): ~30 min.
- **Total: ~3.5 hours, single PR.**

## Open follow-ups (NOT in this PR)
- Trigger immediate auto-wake on `orphanSession` for starred records, so crashed sessions self-heal mid-server-lifetime instead of waiting for next restart. ~10 LOC, scenario 8 of hand-compute.
- Add `!session.isCodexExec` to `canSleep` check (Terminal.tsx:143). Pre-existing bug; freebie cleanup if convenient.

## Risks summary (from hand-compute)

| Severity | Risk | Mitigation |
|---|---|---|
| HIGH | Poison-session restart loop | Wake cooldown (§3) — required |
| HIGH | resurrect-vs-userWake race spawns duplicate windows | Wake mutex (§1) — required |
| MEDIUM | External tmux window for crashed starred no longer rematched | On-demand rematch (§2) — required in this PR |
| MEDIUM | Crashed sessions appear in Snoozed rail with no error badge until wake attempt | Trigger auto-wake on orphan (follow-up) |
| MEDIUM | Starring an Inactive session promotes it to Snoozed | Rail label is Snoozed; context menu includes Remove |
| LOW | Snooze→Wake leaves originally-unstarred session starred | Acceptable; defensible mental model |
| LOW | Codex-exec sessions can be snoozed | Add isCodexExec gate (follow-up) |

## What changes for users
- Snooze now auto-stars. Session will auto-resume on next server start.
- "Snooze and stay snoozed across restarts" no longer possible. Replacement for unstarred sessions: Kill (closes tmux without starring) → drops to Inactive → manual wake. Killing a starred active session lands it in Snoozed.
- Failed wake preserves the bookmark. Poison sessions need a cooldown to avoid retry storms.
- Pinning/starring an Inactive session promotes it to Snoozed (= shortlist) immediately.
- Crashed starred sessions appear in the Snoozed rail (today: Inactive with pin badge).

## Decision log
- 2026-04-25: Chose Option 1 (collapse) over Option 2 (clearer labels) over Option 3 (drop pin). Pre-merge cleanup is cheap; post-merge migrations stick around.
- 2026-04-25: Failed-wake preserves star on both paths (was bifurcated today).
- 2026-04-25: Crashed starred → Snoozed rail, no distinction.
- 2026-04-25: Drop `isSleeping` from wire entirely.
- 2026-04-25: Rename Pin → Star, Sleep → Snooze.
- 2026-04-25: Rename wake wire protocol to `session-wake` / `session-wake-result`.
- 2026-04-25: Include on-demand rematch in this PR.
- 2026-04-25: Label the derived starred-idle rail Snoozed.

## Stress-test results (2026-04-25)

All 10 critical claims verified:
- **POC-confirmed:** DROP COLUMN works on bun's bundled SQLite (tested against copy of real db); migration `UPDATE is_pinned=1 WHERE is_sleeping=1` is idempotent (tested with synthetic row injection).
- **docs-confirmed:** bun 1.3.8 ships SQLite 3.51.0, well past the 3.35 threshold.
- **code-confirmed:** all 5 bucket queries (db.ts:151,154,157,303,335) derive cleanly to `is_pinned && !cw` rules; wake mutex feasible (`resurrectedSessionGrace` Map at index.ts:284 is the precedent — Set goes next to it); `updateSession` is column-scoped so a new `last_resume_attempt_at` column won't be clobbered by other writers; no feedback loop on auto-star (broadcast is pull-only); rebuild + SW cache works (the earlier stale-UI symptom was the `AGENTBOARD_STATIC_DIR` env leak, not SW).

### One positive surprise
**`isSleeping` is never read by non-test client code.** The field is declared on `AgentSession` (shared/types.ts:49) and used in 15 client test mocks but ZERO production UI files. So "drop from wire" is purely test-update churn — no UI logic to refactor. Knocks ~30 min off the estimate.

Revised total effort: **~3 hours single PR**, including both hardening additions (§1 wake mutex, §3 wake cooldown).

### Minor gotchas to remember
- SQLite's `changes` count after the data migration reports rows-matched, not rows-modified. Worth a comment in the migration so future-readers don't think a re-run "did something."
- Bucket continuity is preserved through the migration step: an unpinned-sleeping row stays in the Snoozed rail (via different rule) without flickering through Inactive. No need for a maintenance-mode flag during migration.

## Next step
Implement Phase 1 (compatibility pass without startup fanout expansion). Verified prerequisites; ready to code.
