# Design

## Context

The Team page today (`src/client/components/team/TeamWorkspaceView.tsx`) is
mounted by `App.tsx` in place of the chat pane whenever the URL hash is a
team location (`#/team/<key>/<tab>[/<sub>][/<id>]`, parsed by
`src/client/utils/teamLocation.ts`). The left column (`Header` +
`SessionList`) stays mounted. The page renders a header with a one-line
strategy status, `TeamWorkspaceBands` (attention queue + morning summary,
fed by the `team-workspace-snapshot` read model from
`src/server/team/workspaceRead.ts`), an eight-tab strip, and the active
tab's view. Each tab view owns its own wire subscription; view state lives
per team in `teamWorkspaceStore`.

The read model is deliberately read-only (architecture: "the workspace has
no write path, every action navigates to the control that already owns
it"). Attention items carry `cause`, `owner`, `impact`, `nextAction`, and a
`link`, but not the data an inline control needs (an approval's request id
and command, a question's text).

Task rows (`TeamTaskRow`) carry `stage` but not when the task entered it,
and nothing counts how often review sent a task back. Process metrics count
fix iterations per done task, over a window, not per open task.

The design canvas (Team View Redesign) is the visual reference: Today,
Tasks, Plan, Conversations, Strategy, Agents, Insights, Outbound audit, and
four phone screens. This document fixes the decisions needed to build it.

## Goals / Non-Goals

**Goals**

- Team is a mode with its own shell; the session navigator and session
  header are not mounted in Team mode.
- The owner can finish every human-required attention item from Today
  without leaving it.
- Where work piles up, and which task is stuck in a review loop, is visible
  at a glance.
- Every existing deep link keeps working.
- The Team shell works one-handed on a phone.

**Non-Goals**

- No new write path for agents, no change to chat, mail delivery, plan
  execution, or outbound observation semantics.
- No per-model metrics or task kinds (follow-up `team-metrics-by-model`).
- No push notifications (follow-up `team-push-notifications`).
- No change to the Sessions shell beyond the mode switch, the attention dot,
  and the **Back to Team** pill.
- No light theme for Team mode in this change.

## Decisions

### D1 — The mode is the route

Team mode is exactly "the hash is a team location". There is no separate
mode setting to fall out of sync with the URL.

- `App.tsx` splits into `SessionsShell` (today's left column + chat pane)
  and `TeamShell` (new). It renders `TeamShell` full width when
  `useTeamPageRoute()` yields a location, else `SessionsShell`. Only the
  rendered shell is mounted; `SessionList` and `Header` are not mounted in
  Team mode.
- Both shells share one `TopBar` with the **Sessions | Team** switch. Team
  opens the last team location (kept per browser tab in
  `teamWorkspaceStore.lastLocation`; first visit: Today of the selected
  chat's team, else of the first discovered repository). Sessions clears the
  team route and restores `selectedSessionId`, which Team mode never
  changes (team-workspace D10 stays true).
- ⌘. toggles the mode; it is ignored while focus is in a text field.
- The mode switch carries the markers: Team shows the count of
  human-required attention items for the last team (from the workspace
  snapshot, kept subscribed while in Sessions mode for that one team);
  Sessions shows a dot when any chat that is not a member of that team has a
  pending approval or question (from the session list's existing pending
  flags). The counts do not overlap: a team member's approval counts only on
  Team.
- Opening a chat from Team (agent row, approval "Open chat", any
  `openParticipantChat` call) pushes the chat location and sets
  `returnTo = <team location>`; the Sessions header shows **Back to Team**
  while `returnTo` is set, and activating it navigates to it. Selecting a
  chat any other way clears `returnTo`.

### D2 — Areas replace tabs; the location grammar keeps old links

`WorkspaceTab` becomes `TeamArea`:
`today | plans | tasks | conversations | strategy | agents | insights | audit`.
The hash keeps its shape: `#/team/<key>/<area>[/<sub>][/<id>]`.

- `sub` exists on `strategy` (unchanged sub-views), `conversations`
  (`threads` default, `delivery`), and `insights` (the window, as Metrics
  today).
- Legacy tab segments map to areas when parsed, and the router replaces the
  hash (no extra history entry):

  | legacy | becomes |
  |---|---|
  | `messages[/<thread>]` | `conversations/threads[/<thread>]` |
  | `mailbox` | `conversations/delivery` |
  | `members` | `agents` |
  | `metrics/<window>[/<report>]` | `insights/<window>[/<report>]` |

- The default area becomes `today` (was `tasks`). The header Team button and
  the navigator Team entry open the team's last area, else Today.
- `parseTeamHash` and `teamHashOf` stay pure and round-trip every canonical
  location (property P1).

### D3 — Today embeds the owning control; the read model carries what it needs

Today lists the snapshot's human-required items (Needs you) and the agent
waits (Waiting on agents, folded). Expanding an item mounts the control
that already owns its action, never a new one:

| attention kind | inline control | command sent | data source |
|---|---|---|---|
| `approval` | command + Approve once / Deny | `chat-approval` | new `item.detail.approval` |
| `question` | question form | `chat-answer` | new `item.detail.question` |
| `decision-question` | answer + options | `team-plan-decide` | plan detail (open on expand) |
| `pending-acceptance` | result summary + Accept / Request fixes | `team-task-accept-result`; Request fixes = `team-task-handoff` back to the builder, as the task view does | task detail (`team-task-open` on expand) |
| `uncertain-delivery` | Retry / Discard / Hand off | the Mailbox's existing commands (`team-mailbox-hand-off`, `team-mailbox-dead-letter`, …) | mailbox row (open on expand) |
| `plan-stop`, `plan-promotion` | Retry / Stop / Promote again | `team-plan-execution-retry`, `team-plan-execution-stop`, `team-plan-promote` | plan detail (open on expand) |
| `plan-condition`, `plan-fix`, `plan-stall` | summary + **Open plan** | none (navigates) | snapshot |
| `rework-stuck` (D5) | decision note + Send / Take over in chat / Let it continue | `team-message-send` to the task's thread; `rework-ack` (D5) | snapshot |
| `outbound-violation` | **Open audit** | none (navigates) | snapshot |
| unknown kind | raw kind + **Open** | none (navigates) | snapshot |

- `AttentionItem` gains an optional `detail` union filled by the sources
  that raise `approval` and `question` items (session id, request id, tool
  name, redacted command or question text). Nothing else in the item
  changes; a client that ignores `detail` still works.
- The detail subscriptions opened on expand are the same ones the area
  views use, through the same stores, so a reply from either place updates
  both.
- When an item resolves, focus moves to the next item (the existing queue
  rule), and the expanded slot moves with it.
- Today also shows the Task flow strip (D4), plans in flight (from the plan
  list store), agents now (snapshot members), and the last 24 hours (the
  morning summary's buckets, as counts linking to their items).

### D4 — Task flow strip is a pure projection of task rows

`flowStrip(rows, now, settings)` in `src/shared/flowStrip.ts` maps open rows
to five stages:

| row stage | strip stage |
|---|---|
| `unstarted` | Planning |
| `implementing`, `fixes-requested` | Writing |
| `in-review` | Review |
| `ready-for-qa` | QA |
| `awaiting-acceptance` | Accept |
| `null` (closed) | not counted |

Each stage reports `count`, `oldestSince` (min `stageSince`), and for Accept
`waitingOnYou` (rows with `requiresHuman`). The **bottleneck** is one of
Planning…QA (Accept is never a bottleneck; it is flagged as "You" instead):
the stage with the highest count among those with `count ≥ 2`; ties go to
the older `oldestSince`, then the earlier stage. No stage qualifies → no
bottleneck. The strip also reports `rework`: open rows with
`0 < reworkRounds < threshold` (shown neutrally) and `stuck`: rows with
`reworkRounds ≥ threshold` (shown red, linking to the task).

- `TeamTaskRow` gains `stageSince: string` (ISO time the row entered its
  current projected stage, from the status/handoff event that produced it)
  and `reworkRounds: number` (D5). Both are projected in `workspaceRead.ts`;
  nothing new is stored.
- On Tasks, each stage is a filter (`aria-pressed`); on Today, a link to
  Tasks with that filter. A plan picker narrows rows to one plan's tasks.

### D5 — Stuck in rework

- `reworkRounds(task)` = the number of the task's results whose newest
  findings include a failing verdict. Projected at read time from the
  result and finding stores.
- Team setting `reworkAlertRounds`: integer 2–10, default 3, stored per team
  beside the approval default (schema migration: `team_settings` table
  keyed by team id, holding `rework_alert_rounds`; the approval default may
  move into it in a later change). Set only by the human, through
  `team-workspace-rework-threshold-set` (shaped like
  `team-workspace-approval-default-set`), from Agents or from the strip's **Flag at N+ rounds**
  control; refusals render inline; disabled while disconnected.
- Attention kind `rework-stuck`, source id = task id, raised when the task is
  open, its stage is `implementing`, `fixes-requested`, or `in-review`,
  `reworkRounds ≥ reworkAlertRounds`, and no acknowledgement covers its
  current round count. Owner: the human; `requiresHuman: true`; next action
  **Make the call**; link: the task.
- **Let it continue** records `rework_acks(task_id, rounds)` through
  `team-workspace-rework-ack` (human-only, command id, replay returns the
  prior ack, a different payload under the same id is refused naming the
  field). An ack covers the item while the
  task's `reworkRounds` equals the acked rounds; the next send-back raises
  it again.

### D6 — Conversations composes Messages and Mailbox

`ConversationsView` hosts two sub-views: **Threads** (`TeamMessagesView`'s
list, search, composer, and thread view) and **Delivery** (the Mailbox's
sections, routing state, and Reload routing rules). In Threads, each message
shows its delivery state as text (Delivered, Pending, Uncertain, Dead
letter); an unsettled message shows the mailbox actions that apply to it
(Retry, Discard, Hand off, Cancel), sent through the existing mailbox
commands. A **Delivery issues** filter keeps threads with an unsettled
held, dead-lettered, or uncertain message. Both stores stay as they are;
the view only composes them.

### D7 — Area layouts

- **Plans**: the rail lists open plans under Plans. Plan detail leads with
  open decision cards (answer inline, same command as D3), then a change
  pipeline (Plan › Build › Check › Land per change, owner, state), with
  intent, usage by provider (tokens only, providers never summed), and
  health beside it. The existing sections (Changes, Decisions, Workspace,
  Validation, Report, Revisions) become in-page section links.
- **Tasks**: Board (stage columns, from D4's mapping), List (today's
  filtered list), Tree (today's `TaskTree`); selecting a card opens the task
  in a side sheet (`TeamTaskDetail`) that can expand to the full page.
- **Strategy**: the pending revision is a banner (Review changes / Approve);
  the approved strategy reads as a document with an outline; changed lines
  of the pending revision are highlighted; impact on plans and revision
  history sit beside it. Sub-views and their actions are unchanged.
- **Agents**: group cards; the selected group's live members (Open chat),
  workers by provider, warnings, settings with sources, and the file that
  defines it (read-only, as Members today); the team approval default and
  the rework threshold in the header.
- **Insights** and **Outbound audit**: today's data and controls in the
  shared layout (headline tiles, grouped tables, side column).

### D8 — Visual system and tokens

Team mode uses its own CSS custom properties (`--team-bg`, `--team-panel`,
`--team-border`, `--team-text`, `--team-text-2`, `--team-attention`,
`--team-agent`, `--team-done`, `--team-stopped`), declared on the
`TeamShell` root and exposed as Tailwind theme colors under `team-*`. The
four state colors are never the only signal: every state has a text label.
Text meets 4.5:1 on its surface (3:1 at 24 px and above); focus rings are
visible on every control.

### D9 — Narrow viewports

Below 768 px `TeamShell` replaces the rail with a bottom bar (Needs you,
Plans, Task flow, Messages; the rest under the team switcher's menu) and the
top bar with a compact header. Today renders as the phone inbox: a banner
naming the plans paused on the human, then **Unblocks a plan** (decisions,
stuck rework, stopped changes), then **Quick yes or no** (approvals,
acceptances, deliveries). Decisions open as a full-screen answer view with
**Send** pinned at the bottom and a 10-second **Undo** after sending (the
send is delayed client-side for those 10 seconds; leaving the view sends at
once). Every action target is at least 44 px.

## Acceptance oracles

### L — location grammar (`parseTeamHash`, legacy redirect)

| id | hash | parsed location | redirect |
|---|---|---|---|
| L1 | `#/team/k` | area `today` | none |
| L2 | `#/team/k/today` | area `today` | none |
| L3 | `#/team/k/tasks/t_1` | area `tasks`, id `t_1` | none |
| L4 | `#/team/k/messages/th_1` | `conversations`, sub `threads`, id `th_1` | replace |
| L5 | `#/team/k/messages` | `conversations`, sub `threads` | replace |
| L6 | `#/team/k/mailbox` | `conversations`, sub `delivery` | replace |
| L7 | `#/team/k/members` | `agents` | replace |
| L8 | `#/team/k/metrics/7d/r_2` | `insights`, window `7d`, id `r_2` | replace |
| L9 | `#/team/k/conversations/delivery` | `conversations`, sub `delivery` | none |
| L10 | `#/team/k/conversations/th_1` | `conversations`, sub `threads`, id `th_1` | none |
| L11 | `#/team/k/nonsense/x` | `today`, no id | none |
| L12 | `#/team/%E0%A4/tasks` | no route | none |
| L13 | `#/team/k/strategy/review/3` | `strategy`, sub `review`, id `3` | none |
| L14 | `#/team/k/plans/p_9` | `plans`, id `p_9` | none |

Unreachable: a legacy tab with a Strategy sub-view (Strategy is not a
legacy-only tab).

### F — flow strip (`flowStrip`)

Rows are written `stage×count (oldest age)`; threshold 3 unless stated.

| id | rows | bottleneck | Accept "You" | rework / stuck |
|---|---|---|---|---|
| F1 | none | none | 0 | 0 / 0 |
| F2 | implementing×1 | none (count < 2) | 0 | 0 / 0 |
| F3 | implementing×3 (6h), in-review×1 | Writing | 0 | 0 / 0 |
| F4 | unstarted×2 (1d), implementing×2 (6h) | Planning (tie on count, older) | 0 | 0 / 0 |
| F5 | in-review×2 (3h), ready-for-qa×2 (3h) | Review (full tie, earlier stage) | 0 | 0 / 0 |
| F6 | awaiting-acceptance×4, 2 requiresHuman | none (Accept excluded) | 2 | 0 / 0 |
| F7 | fixes-requested×2 | Writing (fixes count as Writing) | 0 | rows' rounds |
| F8 | in-review×1, reworkRounds 2 | none | 0 | 1 / 0 |
| F9 | in-review×1, reworkRounds 3 | none | 0 | 0 / 1 |
| F10 | in-review×1, reworkRounds 3, threshold 4 | none | 0 | 1 / 0 |
| F11 | a closed row (stage null) | not counted anywhere | 0 | 0 / 0 |

### S — stuck rework (`reworkStuckItems`)

| id | open | stage | rounds | threshold | ack rounds | item |
|---|---|---|---|---|---|---|
| S1 | yes | `in-review` | 3 | 3 | — | raised |
| S2 | yes | `in-review` | 2 | 3 | — | none |
| S3 | yes | `fixes-requested` | 4 | 3 | — | raised |
| S4 | yes | `awaiting-acceptance` | 5 | 3 | — | none (converged) |
| S5 | no | `*` | 5 | 3 | — | none (closed) |
| S6 | yes | `implementing` | 3 | 3 | 3 | none (acked) |
| S7 | yes | `implementing` | 4 | 3 | 3 | raised (new round) |
| S8 | yes | `unstarted` | 3 | 3 | — | none |
| S9 | yes | `ready-for-qa` | 3 | 3 | — | none |

`reworkRounds` counting:

| id | results (newest findings) | rounds |
|---|---|---|
| R1 | none | 0 |
| R2 | r1 fail | 1 |
| R3 | r1 fail, r2 fail, r3 pass | 2 |
| R4 | r1 fail then pass (re-review of r1) | 0 (newest findings pass) |
| R5 | r1 no findings, r2 fail | 1 |

### M — mode switch (`TeamShell` / `SessionsShell`)

| id | start | action | result |
|---|---|---|---|
| M1 | Sessions, chat c1, last team location T | Team | T shown; `selectedSessionId` still c1 |
| M2 | Sessions, no last location, c1 in team A | Team | A / Today |
| M3 | Team at T | Sessions | chat c1 shown; no team route; one history entry |
| M4 | Team at T | Open chat c2 from an agent row | c2 shown; **Back to Team** visible |
| M5 | M4 state | **Back to Team** | T shown with its selection |
| M6 | M4 state | select c3 in the navigator | c3 shown; no **Back to Team** |
| M7 | Team, focus in a textarea | ⌘. | stays in Team; the key goes to the text |
| M8 | Team | browser Back after M3 | T shown |

### Properties

- **P1 (location round-trip)**: for every canonical location `l`,
  `parseTeamHash(teamHashOf(l)) = l`. Generator: seeded LCG (seed `0x7ea3`,
  500 cases) over areas, sub-views valid for the area, windows, and ids drawn
  from a pool including `/`, `%`, spaces, and non-ASCII. Seam: the two pure
  functions.
- **P2 (strip conservation)**: for any rows, the sum of stage counts equals
  the number of rows with a non-null stage, and `rework + stuck` equals the
  number of open rows with `reworkRounds > 0`. Generator: seeded LCG (seed
  `0xf10e`, 400 cases) over stages, ages, rounds 0–6, `requiresHuman`, and
  thresholds 2–10. Seam: `flowStrip`.

## Risks / Trade-offs

- **Inline actions duplicate surfaces.** The same approval can be answered on
  Today, in the chat, or on the phone. Mitigation: all three send the same
  command with the same request id; the server already refuses a second
  answer, and the item disappears from every view on the next push.
- **Snapshot subscription in Sessions mode** for the Team badge adds one
  standing subscription. It is one team's snapshot, already coalesced; no
  per-chat cost.
- **Legacy hash redirects** could loop if a mapping produced a legacy
  segment. The mapping only produces canonical areas (L4–L8), and the router
  redirects at most once per navigation.
- **Big-bang UI change.** Phased tasks (see `tasks.md`) keep the old tab
  views mounted inside the new shell first, so each phase ships alone.

## Migration Plan

1. Ship the shell and the location grammar with the existing tab views
   mounted as areas (Phase 1). Old links redirect.
2. Ship Today and remove the bands (Phase 2).
3. Ship the stuck-rework server parts and the flow strip (Phase 3).
4. Recompose Conversations and restyle the remaining areas (Phase 4).
5. Ship the narrow-viewport layout (Phase 5).

No data migration beyond the new `team_settings` and `rework_acks` tables
(created empty; absent rows mean defaults).

Requirements that name the Members or Metrics tab (Members inspection,
the approval default control, the Metrics tab) apply to Agents and Insights
unchanged; their wording is updated when this change archives.

## Open Questions

- Should the approval default move into `team_settings` now, or stay in
  `team_approval_defaults` until another setting needs it? (Plan: stay.)
- Should **Stuck in rework** also notify the agents' Lead, or stay
  human-only? (Plan: human-only; the Lead can read it through the existing
  attention tool if one is added later.)
