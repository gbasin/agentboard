# Tasks

## 1. Decision function and limit classification

- [x] 1.1 Add `src/server/team/routing/limitResume.ts` with the pure `limitResumeDecision` (design D2) and `isLimitFailure(summary)` (D5, reusing `LIMIT_ERROR_CLASSES`). Commit the turn-end decision table O1–O17 (with O2a) verbatim as a table-driven test in `src/server/__tests__/limitResume.test.ts`, plus the completeness test, which enumerates the axes and asserts that exactly one row or unreachable claim matches each combination. Verify: the test passes. The table kills the mutant "drop the `spawned` check" (O1), "attempt n instead of n+1" (O8), "cap at 4" (O9), "schedule on credit" (O10), and "use `>=` for reset ahead" (O11).
- [x] 1.2 Pin `isLimitFailure` against the captured incident summary (`Agent terminated early due to an API error: … (error type rate_limit, HTTP 429, …)`), a billing error, an overloaded error, and a non-limit failure. Verify: O15a and O15d rows. Kills "match any `error type`" and "match `HTTP 4\d\d`".

## 2. Mailbox and limit-outcome wiring

- [x] 2.1 Add `MailboxStore.pendingLimitResume(sessionId)`. Add the D4 supersede (in `src/server/team/routing/limitResumeMail.ts`, which keeps `limitOutcomes.ts` under 500 lines) (cancel and enqueue in one `db.transaction`, keeping worker lines and attempt, taking the later reset, skipping when the cancel fails on a claimed message). Verify: tests for O6, O7, and O15b (including a claim injected between the read and the cancel) in `src/server/__tests__/limitOutcomes.limitResume.test.ts`. Kills "enqueue before cancel outside the transaction" and "take the earlier reset".
- [x] 2.2 In `LimitOutcomes`: on a `limit-resume` delivery, divert from `resolve()` to the decision (D3). Exclude `limit-resume` tags from `currentWork` and `heldWork`. Call the decision on the no-resolution branch for human, limit-resume, and nothing-held agent-started turns. Keep the in-memory `capped` set (D7). Clear `pending` in `turnStarted` (D8). Verify: tests for O2, O2a, O3, O4, O5, O8, O9, O12–O14, O16, and O19, each annotated with `// @covers: profile-limit-handling › <requirement> › <scenario>` where a scenario applies. Kills "resolve a delivered limit-resume through the group policy" (O8/P2), "keep `pending` across `turnStarted`" (O19), and "cancel on an agent-started success" (O14).
- [x] 2.3 Read `spawned` from the session record and team resolution from the existing `teamOf` option. The worker roster arrives by push (2.4), not by a `getWorkers` option. Log `limit_resume_team_unresolved` when the team is unresolved. Verify: O1 and O17 tests. Kills "treat an unresolved team as resolved".
- [x] 2.4 On every roster push (`ChatSessionManager.handleDriverWorkers` → `SessionMailbox.workersChanged`) while a resume is pending, append newly limit-failed workers through the D4 path, deduplicating by task id in the body (D5). Verify: O15a and O15c (a repeated push and a replay after rebuilding the store) and O15d. Kills "no task-id dedupe" (O15c).
- [x] 2.5 Cancel the pending limit-resume when `ChatSessionManager.archive` runs (D6). Kill already dead-letters queued direct mail (`deadLetterDirectTo`). Verify: O18. Archiving with a pending resume, then advancing to P, delivers nothing and leaves the session archived. Kills "cancel only on kill".

## 3. Paused display

- [x] 3.1 Extend `ChatSessionManager.parkedState` to fall back to `pendingLimitResume` (D9). Verify: the header's `parked.until` equals the message's `deliver_at`. Schedule, cancel (O12), and delivery (O20) each push the updated state. Also add the resume's recipient to the mailbox subscription's holders. Kills "read `parkedBy` only" and "no recipient holder".

## 4. Composition, properties, and docs

- [x] 4.1 Add a manager-level test (`src/server/__tests__/limitResume.integration.test.ts`) through `ChatSessionManager` with the driver fixture replaying the incident's frames: a worker 429 `task_notification`, a synthetic `rate_limit` assistant error, a `result` with `is_error`, a second worker failure, then the reset. Verify: O3, O15a, O20 (one delivered limit-resume naming both workers, starting a turn), and O12 and O18 in sibling tests (oracle-hazards M1).
- [x] 4.2 Add the seeded model test for P1–P4 (`src/server/__tests__/limitResume.model.test.ts`: seed `0x11a7`, 500 cases of 30 commands, a crash injected at the cancel or the enqueue of the D4 replacement, then a restart). Verify: it passes, and fails under the 2.1 and 2.2 mutants. It found that a restart dropped the delivered resume's worker lines from the next attempt; D5 now carries them from the delivered body (O8 test).
- [x] 4.3 Add the recovery-matrix row in `docs/recovery-matrix.md`: fault "human-created session limited, never resumed", mechanism "scheduled direct limit-resume at the reset", owning change `limit-resume-unheld-sessions`, and the 4.1 and 4.2 test citations. Update the Limits bullet in `docs/architecture/routing.md`. Verify: `src/server/__tests__/recoveryMatrix.test.ts` passes.
- [ ] 4.4 Run `bun run check` on the clean committed tree. Map each oracle id (O1–O20, P1–P4) to its test title and killed mutant in the result. Verify: the check records a pass, and the map has no unmapped id.

## Workflow follow-up

- On archive, every ADDED scenario of `profile-limit-handling` needs a `@covers` annotation (AGENTS.md spec coverage).
