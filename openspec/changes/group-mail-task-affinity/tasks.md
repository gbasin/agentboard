# Tasks

## 1. Group settings and the recorded task owner

- [ ] 1.1 In `src/server/team/groupFile.ts`, parse `affinity` (`task-owner` only) and `affinityWait` (whole minutes ≥ 0, default 30), each with a group warning on an invalid value, per D2. Add rows to the group file tests: a valid pair, `affinity: newest`, `affinityWait: -1`, `affinityWait: 2.5`, and an absent key. Verify: `bun run test src/server/__tests__/teamGroupFile.test.ts` passes, and the invalid rows assert both the warning and that no affinity applies. Mutants to kill: any non-empty `affinity` value accepted (the `newest` row); a default wait of 0 (the absent-key row).
- [ ] 1.2 Add the nullable `task_owner` column in `messageSchema.ts`, `EnqueueInput.taskOwner`, `TeamMessage.taskOwner`, and the store read and write. A limit forward keeps the value, per D1. Verify: the mailbox store tests pass, with a row that opens a database created before the column exists and reads null; a forward test asserts the value is kept. Mutant to kill: a forward that drops `task_owner` (the forward row).
- [ ] 1.3 In `TeamMailbox.send`, resolve the task (explicit `task_id`, else the sender's `chat_sessions.task_id`) and record its creator as the owner under D1's conditions, leaving `task_id` and the envelope untouched. Commit rows R1–R6 verbatim as table-driven tests that run through the production `TeamMailbox` composition. Verify: `bun run test src/server/__tests__/teamMailboxStore.test.ts src/server/__tests__/teamMailboxTools.test.ts` passes, and each row asserts the stored `task_owner`, the unchanged `task_id`, and the envelope's task section. Mutants to kill: the owner written into `task_id` (the R2 envelope check); the sender's task preferred over an explicit one (R6); the creator's group check skipped (R5, creator in another group).
- [ ] 1.4 Update the mailbox bullet in `docs/architecture/mailbox.md` with `task_owner`: what it is, when it is set, and that it never sets the task. Verify: the `@reads` and doc guards pass, and `grep -n task_owner docs/architecture/mailbox.md` finds the bullet.

## 2. Owner affinity in eligibility and routing

- [ ] 2.1 Add the pure `ownerAffinity` (D3) beside `evaluateEligibility` in `src/server/team/routing/`. Give `evaluateEligibility` a `taskOwner` input that ranks an eligible owner first, and give `builtinPick` a preferred session. Commit table A as pure rows over `ownerAffinity` and `evaluateEligibility`, covering A1–A9 and A12. Verify: `bun run test src/server/__tests__/ownerAffinity.test.ts` passes. Mutants to kill: `hold` returned for a cooling owner (A7); `hold` for a parked or context-exhausted owner (A6); `<=` instead of `<` at the wait boundary (A3 and A4 at exactly created+wait); the owner ranked first only under `first-available` (A12).
- [ ] 2.2 Wire `ownerAffinity` into `ProfileRouter.route` in D3's order (rule first, then the owner hold, then `builtinPick` with the owner preferred), returning `hold` with `retryAt` and an `owner-busy` diagnosis. Add `taskOwner` to `RouteMessage` in `src/shared/routing.ts`. Commit rows A1–A11 through the production `MailDispatcher` and `ProfileRouter` composition (hazard M1), and add property P3 (seed 1717, 500 cases). Verify: `bun run test src/server/__tests__/routingAffinity.test.ts` passes, and A10 and A11 run with a real rule through the rule host. Mutants to kill: the owner hold evaluated before the rule (A10 and A11); `taskOwner` missing from the rule context (the "Rule reads the owner" scenario); the router computing its own hold without `ownerAffinity` (P3 disagreement).
- [ ] 2.3 Route the dispatch preview and `team_capacity` through the same owner-aware eligibility, so an owner's message previews the owner first. Verify: `src/server/__tests__/taskDispatchPreview.test.ts` gains a row where owner `A` is idle and `B` has been idle longer, and the preview names `A`. Mutant to kill: the preview building its state without `taskOwner` (that row).
- [ ] 2.4 Update the routing bullets in `docs/architecture/routing.md` with the affinity frontmatter, the owner preference, the bounded hold, and the rule precedence. Verify: the `@reads` and doc guards pass.

## 3. Waiting reason `owner-busy`

- [ ] 3.1 Add the `owner-busy` constraint kind to `src/shared/team.ts`, compute it in `waitingReasons.ts` from the router diagnosis (D5), and add its label in `src/client/utils/waitingLabels.ts` (the owner's name and the retry time). Cover both team-waiting-reasons scenarios: one held for the owner, and one where the wait is over and every member is busy. Verify: `bun run test src/server/__tests__/teamWaitingReasons.integration.test.ts src/client/__tests__/waitingLabels.test.ts` passes. Mutants to kill: `owner-busy` still reported after the wait (the second scenario); the label without the retry time (the label assertion).

## 4. Group-mail aging in the dispatcher

- [ ] 4.1 Add the aged-normal-group step before `directPass('normal')` in `MailDispatcher.dispatch` (D4, `GROUP_AGING_MS` = 15 min, measured from `deliver_at ?? created_at`), and update the file's header comment. Commit rows G1–G6 verbatim as table-driven dispatcher tests. Verify: `bun run test src/server/__tests__/teamDispatcher.test.ts` passes, including the existing "direct before group" tests narrowed to fresh group mail. Mutants to kill: age measured from `created_at` even when `deliver_at` is set (a scheduled-message row in G1); the aged step placed after `directPass` (G2); an aged message routed past an active owner hold (G5).
- [ ] 4.2 Add properties P1 (seed 4242, 300 cases) and P2 over the production dispatcher and router composition. P1 is the incident's ping-pong: two members with direct mail always waiting and one group message. P2 adds replays and a restart between passes. Verify: `bun run test src/server/__tests__/dispatcherAgingProperty.test.ts` passes. Mutants to kill: removing the aged step (P1 fails as the incident did); a claim made without `claimWhen` (P2).
- [ ] 4.3 Update the dispatch-order sentence in `docs/architecture/routing.md`, the bullet that names "urgent direct, urgent group, normal direct, normal group", to include the aged group step. Verify: `grep -n "aged" docs/architecture/routing.md` finds it, and the doc guards pass.

## 5. Lead group opt-in

- [ ] 5.1 Add `affinity: task-owner` to `.kawai/groups/lead.md`, and a short guidance paragraph per D6: do not relay another lead's task mail, record coordination in the task journal, and send direct mail only when the other lead must act. Ask the human to review the guidance text before the result. Verify: a group file test that declares `// @reads: .kawai/groups/lead.md` parses the file with affinity enabled and no warnings, and `bun run test src/server/__tests__/teamGroupFile.test.ts` passes.

## 6. Integration check

- [ ] 6.1 On the clean committed tree, run `bun run check`. Then replay the incident on a copy of the live database with the built server: two lead sessions with direct mail queued for each other, plus the 13 queued dev and reviewer messages with their senders' tasks. Confirm that each message routes to its task creator, or to the other lead after `affinityWait`, and that none waits past the aging bound while a lead goes idle. Verify: `bun run check` passes, and the result records, per message, the recorded owner, the claimant, and the time it waited.

## Workflow follow-up

- Map every oracle id (A1–A12, G1–G6, R1–R6, P1–P3) to its test title and killed mutant in the result.
- Archive the change after review, adding `@covers` annotations for every ADDED and MODIFIED scenario.
