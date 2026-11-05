# Tasks

Each phase ships on its own: the build, `bun run check`, and the e2e suite
pass at the end of every phase. Oracle rows from `design.md` are committed
verbatim as table-driven tests next to the code they cover, with
`// @covers:` annotations for the spec scenarios they prove. Historical scenario titles retained in the deltas
(e.g. "First open lands on Tasks") keep existing coverage references valid;
the scenario body defines the new Today behavior.

## 1. Shell and location (D1, D2, D8)

- [ ] 1.1 Replace `WorkspaceTab` with `TeamArea` in `src/client/utils/teamLocation.ts`: the area list, `today` as default, `conversations` sub-views (`threads`, `delivery`), `insights` window, and the legacy mapping. `parseTeamHash` returns the canonical location plus a `legacy: true` flag when it mapped a legacy segment.
  - Verify: table L rows L1–L14 as one table-driven test; property P1 (seed `0x7ea3`, 500 cases). L4 kills "legacy messages keeps its tab"; L11 kills "unknown area is an error"; L12 kills "malformed key throws".
- [ ] 1.2 `useTeamPageRoute` replaces the hash (no history entry) when the parsed location is legacy, at most once per navigation.
  - Verify: a hook test navigates to each legacy hash and asserts one `replaceState` and no `pushState`; a canonical hash triggers neither.
- [ ] 1.3 Split `App.tsx` into `SessionsShell` (today's left column, resize handle, and chat pane) and `TeamShell`, rendered by route (D1). `TeamShell` does not mount `Header` or `SessionList`. Keep `App.tsx` under 500 lines by moving the shells to `src/client/components/shell/`.
  - Verify: a component test renders App with a team hash and asserts no `SessionList` in the tree; with a chat selected and no team hash, no `TeamShell`.
- [ ] 1.4 Add `TopBar` with the **Sessions | Team** switch, team switcher (discovered repositories; switching keeps the area), ⌘K button, and connection state. ⌘. toggles the mode outside text fields. `teamWorkspaceStore` keeps `lastLocation`.
  - Verify: table M rows M1–M3, M7, M8 as component tests over the router seam. M1 kills "switching to Team changes the selected chat"; M7 kills "shortcut fires inside a textarea".
- [ ] 1.5 Add `TeamRail` (areas grouped Work / Direction / Team, per-area counts from existing stores, the strategy revision-in-review badge, the unacknowledged-violation badge) and route areas to today's views (`TeamWorkspaceView` becomes the area router; Today temporarily renders the existing bands).
  - Verify: each rail link sets `aria-current` on its area; Playwright: from a chat, Team opens Today; every rail area renders its view; `#/team/<key>/mailbox` lands on Conversations › Delivery with the Mailbox sections.
- [ ] 1.6 Team-mode tokens (`--team-*`) on the `TeamShell` root and Tailwind `team-*` colors; contrast check of every text/surface pair in a unit test over the token table.
  - Verify: the contrast test fails when `--team-text-2` is lowered below 4.5:1 on `--team-panel`.
- [ ] 1.7 Mode switch markers: Team count from the last team's snapshot (kept subscribed in Sessions mode); Sessions dot from non-team chats with a pending approval or question. Both have text for screen readers.
  - Verify: a store test with one team-member approval and one non-member question yields Team count 1 and the Sessions dot; the member approval alone yields no dot.
- [ ] 1.8 **Back to Team**: `openParticipantChat` from Team sets `returnTo`; the Sessions header shows the pill; selecting a chat any other way clears it.
  - Verify: table M rows M4–M6.
- [ ] 1.9 Command palette (⌘K): areas, tasks, plans, agents, threads by title, plus commands New task and Message team. Results come from stores already loaded; no new server query.
  - Verify: typing a task id selects it on Tasks; Esc returns focus to the trigger; the list is a labelled listbox navigable with arrows.
- [ ] 1.10 Update `workspace-navigation` and `chat-header` behaviour: the navigator Team entry and the header Team button open the team's last area, else Today.
  - Verify: the scenarios of the MODIFIED requirements in `specs/workspace-navigation` and `specs/chat-header`.

## 2. Today (D3)

- [ ] 2.1 Add `detail` to `AttentionItem` (`approval`: session id, request id, tool name, redacted command; `question`: session id, request id, questions) and fill it in the sources that raise those kinds.
  - Verify: `workspaceRead` tests assert the detail for one approval and one question; an item without detail still renders on an old client fixture.
- [ ] 2.2 `TodayView`: headline, Needs you (filters by kind), Waiting on agents (folded), Plans in flight, Agents now, Last 24 hours (the morning summary's buckets as counts with links). Remove `TeamWorkspaceBands` from the shell; keep `TeamAttentionQueue`'s identity, toast, and focus rules by moving them into Today.
  - Verify: the existing attention and summary tests pass against Today; the focus-moves-to-next rule still holds.
- [ ] 2.3 Inline controls per the D3 table, each sending the existing command through the existing store: approval, question, decision card, pending acceptance, uncertain delivery, plan stop and promotion. Items without an inline control show their link.
  - Verify: one component test per row of the D3 table asserts the exact message sent; a refusal renders inline; every control is disabled while disconnected.
- [ ] 2.4 Answering from Today and from the chat converge: the second answer is refused by the server and the item leaves both views on the next push.
  - Verify: an integration test answers an approval through Today, then sends the same `chat-approval` again and asserts the refusal and a single resolution.

## 3. Flow strip and stuck rework (D4, D5)

- [ ] 3.1 Project `stageSince`, `reworkRounds`, `planId`, and `reworkStuck` on `TeamTaskRow` in `workspaceRead.ts`.
  - Verify: table R rows R1–R7; `stageSince` equals the time of the event that produced the current stage in three fixtures (unstarted, handoff to review, failing findings); events that leave the stage unchanged preserve its clock; plan filtering uses the existing plan id.
- [ ] 3.2 Pure `flowStrip` in `src/shared/flowStrip.ts`.
  - Verify: table F rows F1–F14; property P2 (seed `0xf10e`, 400 cases). F4 kills "tie broken by stage order before age"; F6 kills "Accept can be the bottleneck"; F7 kills "fixes-requested counted apart from Writing".
- [ ] 3.3 Schema migration: `team_settings` (`team_id`, `rework_alert_rounds`, `updated_at`) and `rework_acks` (append-only, primary key `team_id` + `command_id`, retaining `task_id`, `rounds`, `note`, `created_at`, original response). Add the recovery-matrix row if the migration introduces a startup reconciliation (it should not; absent rows are defaults).
  - Verify: the migration test creates both tables from the previous schema; `database.md` lists the migration.
- [ ] 3.4 `team-workspace-rework-threshold-set` (human-only, 2–10, refusal inline, every open view follows) and `team-workspace-rework-ack` (command id, replay returns the prior ack, a different payload is refused naming the field).
  - Verify: set 1 and 11 are refused; set 4 updates a second subscribed client; ack replay after a later ack returns the original response; conflicting payload, cross-team task, and stale round count are refused.
- [ ] 3.5 Attention kind `rework-stuck` raised by `reworkStuckItems` in `src/server/team/`, wired into the attention sources.
  - Verify: table S rows S1–S10. S4 kills "converged task stays stuck"; S6/S7 kill "ack hides forever".
- [ ] 3.6 `FlowStrip` component on Today (links) and Tasks (filters, plan picker, **Flag at N+ rounds** control); the stuck row and the Today inline control for `rework-stuck` (D3).
  - Verify: Playwright: a stuck task shows on the strip and in Needs you; **Let it continue** removes it until the next failing findings.

## 4. Area screens (D6, D7)

- [ ] 4.1 `ConversationsView` with Threads and Delivery; delivery state as text on each message; inline mailbox actions on unsettled messages; **Delivery issues** filter.
  - Verify: the existing Messages and Mailbox tests pass through the new host; a held message in a thread shows Retry and Discard and sends the Mailbox's command.
- [ ] 4.2 Tasks: Board (stage columns), List, Tree; side sheet with expand-to-page; the strip above.
  - Verify: the Tasks tests pass; selecting a card sets the URL id; Back closes the sheet.
- [ ] 4.3 Plans: rail plan list; detail led by open decisions, then the change pipeline; usage by provider (never summed); section links.
  - Verify: the Plans view tests pass; a plan with two providers' turns shows two usage rows and no total.
- [ ] 4.4 Strategy: banner, document view with outline, highlighted pending changes, impact and history beside.
  - Verify: the Strategy tests pass; the banner's Approve sends the existing approval message.
- [ ] 4.5 Agents: group cards, selected group detail, workers by provider, approval default, rework threshold.
  - Verify: the Members and approval-default tests pass through Agents.
- [ ] 4.6 Insights and Outbound audit in the shared layout; no data change.
  - Verify: the Metrics and Audit tests pass through the new hosts.
- [ ] 4.7 Update `docs/architecture/team-page.md` (shell, areas, Today, Conversations, flow strip, stuck rework) and the `AGENTS.md` structure list.
  - Verify: `grep -rn '^- Team page' docs/architecture/` names the new shell; no doc mentions the bands as current.

## 5. Narrow viewports (D9)

- [ ] 5.1 Below 768 px: bottom bar, compact header, phone Today (banner, Unblocks a plan, Quick yes or no), full-screen decision view with pinned Send and 10-second Undo.
  - Verify: Playwright at 390×844: every action target is at least 44×44 px; a decision answered on the phone sends `team-plan-decide` once after 10 s, and not at all when Undo is pressed; navigating away keeps Undo visible and does not shorten the deadline; disconnect or another client resolving the card cancels the pending send; closing/reloading the tab cancels unsent answers as disclosed.
- [ ] 5.2 Keyboard and screen-reader pass over every new control (visible focus, names, state text).
  - Verify: Playwright, keyboard only, completes the M flows and one D3 inline action per kind, asserting visible focus on each step; every interactive element on Today, Tasks, and the phone views has an accessible name (`getByRole` with a name finds each). No new dependency.

## 6. Close-out

- [ ] 6.1 Run `bun run build`, `bun run test:e2e`, and `bun run check` on the clean committed tree.
- [ ] 6.2 Archive the change; add `@covers` annotations for every ADDED or MODIFIED scenario left in the main specs.
