# Tasks

## 1. Resolution and parsing

- [ ] 1.1 Add `resolveSpawnApproval(groupApproval, teamDefault)` to `src/shared/` (D2). In a table-driven test, commit the design's resolution table O1–O9 verbatim. Verify O1–O9 pass and kill these mutants: the default wins over the group key (fails O6 and O8), and an unset default resolves as auto (fails O1).
- [ ] 1.2 Make `GroupDefinition.approval` optional and stop seeding `'manual'` in `parseGroupFile` (D1). Add the parser table P1–P4 to `teamGroupFile.test.ts`. Verify P1–P4 pass and kill the mutant that re-seeds `'manual'` (fails P1). `bun run typecheck` must name every reader that assumed a defined value, and each one is moved to the resolver.

## 2. Server storage and write action

- [ ] 2.1 Add the `team_approval_defaults` table and the `TeamApprovalDefaults` store with `get` and `set` (D3), created idempotently beside the team tables. Verify with a store test of round-trip, upsert, and no-row-is-null, and kill the mutant that caches `get` (fails the read after a second `set`).
- [ ] 2.2 Add the `team-approval-default-set` and `team-approval-default-result` messages to `src/shared/types.ts` and `CHAT_CONNECTION_TYPES`, with a handler that resolves `teamPath`, validates, upserts, and publishes the team's workspace (D4). Commit the write table W1–W5 as a table-driven connection test, asserting the result envelope with `teamPath` on every row. Kill these mutants: a refusal without `teamPath` (fails W3 and W4), and keying by the raw path instead of the team id (fails W5).
- [ ] 2.3 Verify A1. A test enumerates the `kawai-team` tool names and handlers and asserts that none writes `team_approval_defaults`. It kills the mutant that adds a tool which calls `TeamApprovalDefaults.set`.

## 3. Spawn, preview, and Members readers

- [ ] 3.1 Have `StaffingCoordinator.spawnFor` pass `resolveSpawnApproval(group.approval, teamApprovalDefault(message.teamId)).policy` (D5), wired in `bootstrap.ts`. Verify in `teamStaffing.test.ts` with O3, O6, O8, and O1 through the fake `spawn` option, and with L2 (two teams). Kill the mutant that passes `group.approval ?? 'manual'` (fails O3).
- [ ] 3.2 Add the L3 test: with no WebSocket connection registered, a dispatch spawns a member of a group with no key under an `auto` team default, and the spawned chat's first tool approval is granted without a pending card. It kills the mutant that reads the default from a connection-held cache (fails with zero connections).
- [ ] 3.3 Add the L1 test: setting the team default leaves every existing session's stored policy unchanged. It kills the mutant that rewrites live members' policies on set.
- [ ] 3.4 Have `previewGroupDispatch` take `teamDefault` and return the resolved `approval` and `approvalSource` (D5, D6), and have `WorkspaceRead` emit the resolved `approval`, `approvalSource`, and the snapshot's `approvalDefault`. Verify in `taskDispatchPreview.test.ts` and `teamWorkspaceRead.test.ts` with O3 and O6, and kill the mutant where the preview keeps `group.approval` (fails O3).
- [ ] 3.5 Add the agreement property G1 (seed `0x7a11`, 200 cases) across `spawnFor`, `previewGroupDispatch`, and `WorkspaceRead`. It kills the mutant where only one reader skips the resolver.

## 4. Client

- [ ] 4.1 Add the "Default approval for spawned members" control and its hint to the head of `TeamMembersPanel.tsx`. It sends the action, shows a refusal inline, is disabled while disconnected, and follows the snapshot (D7). Add source labels to the group rows and to `taskAssignFields.tsx`. Verify with component tests for these scenarios: setting the default updates the group rows, the control is disabled while disconnected, and the approval source is shown. Kill the mutant that renders the stored default instead of the row's resolved policy.
- [ ] 4.2 Reword the Approval Policy hint in `ChatSettings.tsx`. Verify with a component test of the scenario "Settings names where spawned members get their policy", and confirm that `NewSessionModal` still seeds from the browser setting (the existing tests pass).
- [ ] 4.3 After `bun run build`, add a Playwright spec that sets the default on one tab's Members tab and sees the change on a second tab. Verify with `bun run test:e2e` on that spec (scenario: another open view follows the change).

## 5. Docs and coverage

- [ ] 5.1 Update the staffing and Team page Members bullets in `docs/architecture/` (find them with `grep -rn '^- ' docs/architecture/ | grep -i -E 'staffing|Members tab'`) with the resolution order, the table, and the human-only write. Verify by reading the result back, and confirm that `bun run lint` is clean.
- [ ] 5.2 Put a `// @covers:` annotation above each test from groups 1–4 for every ADDED or MODIFIED scenario in this change's delta specs. Verify that `scripts/__tests__/specCoverageGuard.test.ts` passes.
- [ ] 5.3 Run `bun run check` on the clean committed tree. Verify it records a pass, and map each oracle id (O1–O9, P1–P4, W1–W5, L1–L3, A1, G1) to its test title and the mutant it killed in the result.

## Workflow follow-up

- Archive the change after acceptance, and add any covering annotations the archive requires (see `openspec/coverage.json`).
