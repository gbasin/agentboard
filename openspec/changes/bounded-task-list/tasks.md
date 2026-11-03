# Tasks

## 1. Shared derivation and compact row

- [x] 1.1 Add `AgentTaskRow` and `AgentTaskList` to `src/shared/teamTasks.ts`
  (design D1); verify `bun run typecheck` passes.
- [x] 1.2 Extract the outstanding-assignment and outstanding-result derivation from
  `TaskStore.summary` into one private helper used by `summary` and by a new
  compact projection (D1). Verify that the existing `teamTaskStore.test.ts` and
  `teamTaskParticipants.test.ts` pass unchanged, and add the R2 table test
  (queued, claimed, failed, superseded-then-replaced, and unassigned assignments;
  pass, fail, and no-findings results; accepted results). Verify: R2 kills the
  mutant where the compact projection derives `state` from the newest
  assignment row instead of `outstandingOf`.

## 2. Bounded store and service read

- [x] 2.1 Add the store's agent list read (D3): an anchor check, a window
  `ORDER BY created_at DESC, rowid DESC LIMIT n + 1` with the status `IN`
  predicate and no revision join, and a `COUNT(*)`, all in one synchronous
  read transaction. Verify with the W1–W4 table test. W2 kills the mutant
  `LIMIT n` (truncation never reported). W3 kills the mutant that drops the
  `rowid` tie-break (`created_at < a` only).
- [x] 2.2 Add `TaskService.agentList(caller, { status?, limit?, before? })` with the
  D2 status mapping (omitted → open/active/blocked, `all` → all five) and the
  `Unknown task for this team: <id>` refusal. Remove `TaskService.list` once
  `grep -rn "\.list(caller" src` shows no remaining caller. Verify with
  the S1–S3 and W5 rows. S1 kills the mutant whose default applies no
  filter. W5 kills the mutant whose anchor check drops `team_id`.
- [x] 2.3 Add the P1 and P2 property tests (seed `0x7a5c`, 200 cases, 5 distinct
  creation times) through the production handler; verify both pass and P1
  kills the 2.1 tie-break mutant.

## 3. Tool registration and agent-facing text

- [x] 3.1 In `taskTools.ts`, change the `task_list` schema to `status`
  (five statuses or `all`, with one message naming them), `limit` (1–200, with
  one message naming the range), and `before`. Point the handler at
  `agentList` and replace the description with the D4 text. Verify with the S4
  and W6 rows through the handler and through the Codex runtime path
  (`codexTeamPath.integration.test.ts`), each asserting the same refusal
  envelope as the existing `task_get` refusals. S4 kills the mutant that
  accepts any string; W6 kills the mutant `max(1000)`.
- [x] 3.2 Add the R1 test: seed unique 4,000+-character markers into the
  direction, acceptance, and assignment instruction, call
  `task_list({ status: 'all' })`, and assert no marker appears in the
  serialized result and that every `AgentTaskRow` key is present. Verify:
  R1 kills the mutant that spreads the full `TeamTask` into the row.
- [x] 3.3 Update the `task_list` line in the team prompt's task note
  (`teamPrompt.ts`) per D4. Extend `teamPrompt.test.ts` with the "Prompt names
  the default and the paging" scenario. Verify: the test kills the mutant that
  restores the old line.
- [x] 3.4 Update the existing `task_list` assertions in `teamTaskService.test.ts`
  to the `AgentTaskList` envelope. Verify the file passes.
- [x] 3.5 Update the `task_list` part of the task tools bullet in
  `docs/architecture/tasks.md`: compact rows, the open default and `all`,
  `limit`/`before`, newest first, and the Codex catalogue caveat. Verify that
  it names the same arguments as the schema.
- [x] 3.6 Annotate each scenario test with
  `// @covers: team-tasks › <requirement> › <scenario>`, covering all four
  ADDED requirements' scenarios. Verify `scripts/__tests__/specCoverageGuard.test.ts`
  passes.

## 4. Integration check

- [x] 4.1 Run `bun run check` on the clean committed tree. Then, on a copy of
  a database with real data (copied to `/tmp`, never the live file), call the
  handler with no arguments and with `status: 'all'`, and record each
  serialized size in the result. Verify the default call is under 30 KB.
  Then write the oracle map: each oracle id (S1–S4, W1–W6, R1, R2, P1, P2) to
  its test title and its killed mutant.

## Workflow follow-up

- Archive the change after review; the archive's ADDED scenarios need their
  `@covers` annotations (done in 3.6).
