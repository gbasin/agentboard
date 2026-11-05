# Design

## Context

See proposal.md, Why, for the incident. These code facts constrain the design:

- **Pass order.** `MailDispatcher.dispatch()` (`src/server/team/dispatcher.ts`)
  runs urgent direct interrupts, then for each priority a `directPass` and then
  a `groupPass`. `directPass` gives every idle recipient its next direct
  message, and the recipient's idle slot is consumed before any group message
  is routed. A lead with direct mail queued therefore never reaches the group
  pass.
- **What group routing sees.** `GroupRouter.route` (`routing/router.ts`) sees
  only members the dispatcher found eligible. It also reads the group's
  members (`options.members`), so it can tell a busy member from an absent
  one.
- **The pure eligibility check.** `evaluateEligibility`
  (`routing/workerEligibility.ts`) orders members as the dispatcher gives them
  (longest idle first). `builtinPick` (`routing/builtin.ts`) re-sorts members
  by strategy and idle time.
- **Message fields and the sender's task.** `team_messages.task_id` drives the
  envelope's task section and `associateTask`, which re-points the
  recipient's `chat_sessions.task_id`. A dev's current task is in
  `chat_sessions.task_id`, set when task mail is pushed to it.
- **Group frontmatter.** It is parsed in `src/server/team/groupFile.ts`, with
  strict per-key validation and warnings for bad values.
- **Waiting-reason kinds.** They are listed in `src/shared/team.ts`
  (`WaitingConstraint`), rendered by `src/client/utils/waitingLabels.ts`, and
  computed in `waitingReasons.ts` and from router diagnoses.

## Goals / Non-Goals

**Goals:**

- A lead receives group mail about the tasks it created, and the other lead
  takes it only when the owner is unavailable or has been busy past a bounded
  wait.
- No group's mail can be starved indefinitely by a stream of direct mail.
- The router, the dispatch preview, `team_capacity`, and waiting reasons give
  one answer.

**Non-Goals:**

- **No ownership transfer tool.** The owner is the task's creator. An archived
  or exhausted creator simply falls back. Rebalancing is a follow-up if
  needed.
- **No affinity for direct mail, replies, or mail without a resolvable task**
  (human requests, Kawai plan mail).
- **No change to urgent ordering**, to interrupts, or to the worktree
  targeting of task mail.
- **Not the `uncertain` receipts** seen on one Codex lead. That is a separate
  issue.
- **Not task_get or tool output size.** `bounded-metrics-and-task-get` covers
  that.

## Decisions

### D1: The owner is recorded at send time, in its own column

At send time, `TeamMailbox.send` resolves the task: `input.task_id`, else the
sender session's `chat_sessions.task_id`. When the target group sets
`affinity: task-owner`, the task's `creator_session` is a session whose group
is the target group, and the creator kind is `agent`, it stores that session
in a new nullable column, `team_messages.task_owner`. That covers
`messageSchema.ts`, `EnqueueInput.taskOwner`, and the `TeamMessage.taskOwner`
field.

- **Why a new column, not `task_id`.** Setting `task_id` would add a task
  section to the lead's envelope and run `associateTask`, re-pointing the
  lead's own current task to the dev's task. That is wrong for a lead.
- **Why at send time, not at route time.** The sender's current task can
  change after the message is sent, and the recorded value makes the decision
  auditable in the Mailbox. Whether the owner is still a live member is
  judged at route time (D3).
- **Rejected:** inferring the task from the message body. It is unreliable,
  and rules never see bodies.
- **Replies.** A reply already goes to its original sender, so replies need
  no owner. A limit forward keeps `task_owner`, since it is the same message
  and the same task.

### D2: Opt-in per group: `affinity` and `affinityWait`

`groupFile.ts` accepts `affinity: task-owner`; any other value raises a group
warning and no affinity applies. It also accepts `affinityWait: <whole
minutes ≥ 0>`, default 30; an invalid value raises a warning and the default
applies. `affinityWait: 0` means prefer the owner when it is idle, never wait.

- **Rejected: always on.** Developer groups already narrow by worktree, and
  holding their mail for a busy creator would only slow them.
- **Why 30 minutes.** Lead turns in the incident ran 1 to 94 minutes, with a
  median near 5. 30 minutes covers most turns without losing a whole long one
  to idling.

### D3: One pure derivation decides prefer, hold, or fall back

A new pure function, `ownerAffinity(state)`, sits beside
`evaluateEligibility`. Its inputs are the recorded owner, the owner member's
causes (from `memberStateCauses`, or absent when the owner is not a live
group member), the filter reasons for the owner's profile, the message's
creation time, `affinityWait`, and `now`. It returns one of:

- `prefer`: the owner is an eligible candidate;
- `hold(until)`: the owner's only causes are `busy` and/or `pending-card`, no
  filter reason applies, and `now < created + wait`;
- `none`: every other case, which falls through to the strategy.

These consumers all call it:

- `evaluateEligibility` takes the owner in its state and moves an eligible
  owner's candidate first;
- `builtinPick` takes a `preferSessionId` and returns that candidate first
  when it is present and not cooling;
- the router turns `hold` into a `{ kind: 'hold', retryAt: until }` with an
  `owner-busy` diagnosis;
- the dispatch preview and waiting reasons read the same result.

One function means the readers cannot drift apart (oracle hazard "Several
readers disagreeing on derived state").

**Cooling.** A cooling owner gives `none`, not `hold`. A provider limit is
exactly the case where the other lead should take over, and the lead group's
`onLimit: release` already expresses that intent.

**Order.** The order inside `route()` is:

1. the eligibility check;
2. if there are no candidates, the existing `none`;
3. the rule, which sees `message.taskOwner` and whose pick or hold wins;
4. the owner hold;
5. `builtinPick` with the owner preferred.

The hold is evaluated after the rule, so a rule can override it. It is
evaluated before `builtinPick`, so the default path waits for the owner.

**Re-routing.** The router's existing hold map keys holds by candidate
signature. The owner going idle changes the candidates, which ends the hold
on the next pass. The `retryAt` re-arms the dispatcher timer at the end of
the wait.

### D4: Aged group mail gets its own step in each pass

The per-pass order becomes:

```
urgent direct (interrupts) -> urgent direct -> urgent group
  -> aged normal group -> normal direct -> normal group
```

Aged means `now - (deliver_at ?? created_at) >= 15 min` (`GROUP_AGING_MS`).
The aged step routes those group messages before `directPass('normal')`, so
an idle recipient chosen for one is claimed before its direct mail is
offered. Messages that are not aged keep today's position.

- **Rejected: lower priority for direct mail between members of one group.**
  It needs a sender-group rule and still starves group mail under other
  direct-mail patterns. Aging fixes the class.
- **Rejected: strict oldest-first across direct and group mail.** That
  reorders every conversation and every thread reply for little gain.
- **Why a constant.** The 15-minute threshold is a constant, not a knob. No
  group has a need to tune it yet, and a constant keeps the order easy to
  state in the spec.

### D5: Waiting reason `owner-busy`

A new `WaitingConstraint` kind `owner-busy` carries `sessionIds: [owner]` and
`retryAt`. It is the immediate blocker while the hold applies. The members'
own causes still follow as other constraints. The label goes in
`waitingLabels.ts`. After the wait ends, `ownerAffinity` returns `none` and
the constraint disappears.

### D6: The lead group opts in, and its guidance changes

`.kawai/groups/lead.md` gains `affinity: task-owner`, with the default wait.
A short paragraph tells leads three things:

- group mail about another lead's task reaches that lead, so do not relay it;
- record coordination in the task journal;
- send direct mail to the other lead only when it must act.

The human owns this file's guidance text, so the task that edits it asks for
review.

## Acceptance oracles

### Owner affinity (`ownerAffinity`, then routing)

Axes:

- the recorded owner;
- the owner's live state: eligible, only busy or awaiting a card, other cause
  (parked, context-exhausted, unavailable, startup-failed, other worktree),
  cooling, filtered (outside the role, worker choice, excluded profile), or
  not a live member;
- the wait: `now < created + wait` or not;
- other candidates: whether any other candidate is eligible;
- the rule's decision.

| Id | Owner recorded | Owner state | Within wait | Other candidate | Rule | Result |
|---|---|---|---|---|---|---|
| A1 | no | * | * | yes | none/default | strategy pick (unchanged) |
| A2 | yes | eligible | * | * | none/default | owner receives it |
| A3 | yes | busy or card | yes | * | none/default | hold until created+wait, `owner-busy` |
| A4 | yes | busy or card | no | yes | none/default | strategy pick among others |
| A5 | yes | busy or card | no | no | * | existing no-candidate wait; owner later takes it |
| A6 | yes | other cause | * | yes | none/default | strategy pick among others, no wait |
| A7 | yes | cooling | * | yes | none/default | another candidate, no wait |
| A8 | yes | filtered | * | yes | none/default | strategy pick among others, no wait |
| A9 | yes | not live | * | yes | none/default | strategy pick, no wait |
| A10 | yes | eligible or busy | * | yes | pick other | the rule's pick |
| A11 | yes | * | * | * | hold | the rule's hold |
| A12 | yes | eligible | * | * | default, `profile-order` | owner first despite rank |

Unreachable or excluded combinations:

- **Owner recorded on a group without affinity:** D1 never records one.
- **Owner eligible with no candidates:** an eligible owner is a candidate.
- **`affinityWait: 0`:** within the wait is always false, so A3 cannot occur
  and A4–A5 apply.

### Group aging (dispatcher pass)

| Id | Group mail | Direct mail for the idle chosen member | Result |
|---|---|---|---|
| G1 | normal, due 5 min | normal | direct delivered first |
| G2 | normal, due ≥ 15 min | normal | group delivered first |
| G3 | normal, due ≥ 15 min | urgent | urgent direct first |
| G4 | urgent, any age | normal | group first (unchanged) |
| G5 | normal, due ≥ 15 min, owner hold active | normal | direct to the idle member; the group stays held |
| G6 | normal, due ≥ 15 min, idle owner | normal, for the owner | group to the owner first |

### Owner recording at send (D1)

| Id | `task_id` | Sender's current task | Group affinity | Creator | Recorded owner |
|---|---|---|---|---|---|
| R1 | given | * | on | lead session of the target group | that creator |
| R2 | absent | set | on | lead session of the target group | that creator |
| R3 | absent | absent | on | * | none |
| R4 | * | * | off | * | none |
| R5 | resolved | * | on | human, Kawai, or a session of another group | none |
| R6 | given | set, different | on | creators differ | the creator of `task_id` |

Every row also checks that the message's `task_id` is exactly what the
sender gave, and that the envelope carries no task section unless `task_id`
was given.

### Properties

- **P1, no starvation.** A generator produces seeded command sequences over
  two lead members, both with direct mail to each other always waiting
  (enqueued at every idle moment), one group message, and clock steps of 1–5
  minutes. Fixed seed 4242, 300 cases, through the production `MailDispatcher`
  plus `ProfileRouter` composition (hazard M1). The property: the group
  message is claimed no later than the first idle moment at or after
  `max(15 min, created + wait)` when the owner stays busy, or at the owner's
  first idle moment within the wait.
- **P2, at most one claim.** Under the same generator, with replays and a
  restart between passes, no message is ever claimed by two sessions.
- **P3, one derivation.** For random states (seed 1717, 500 cases), the
  router's hold or pick, the dispatch preview's first candidate, and the
  waiting reason's `owner-busy` presence all agree with `ownerAffinity`.

## Risks / Trade-offs

- **[Imbalance: one lead owns the busy tasks]** → `affinityWait` bounds the
  delay, so overflow goes to the other lead. Load share is visible per owner
  in the Mailbox. A transfer tool is a follow-up if this is needed.
- **[A wrong owner when a dev's current task is stale]** → the explicit
  `task_id` wins (R6). The worst case is a delay of at most `affinityWait`.
- **[Aging reorders conversations]** → it applies only to group mail that has
  already waited 15 minutes. Urgent direct mail is unaffected. The spec
  scenario "Direct before group at equal priority" is narrowed to fresh group
  mail and recorded as BREAKING in the proposal.
- **[Routing rules written for the old context]** → `taskOwner` is additive.
  A rule that ignores it keeps today's behavior, minus the hold, which only
  the built-in default path applies.
- **[Restart]** → holds are in memory and recomputed from `created_at` on the
  first pass. `task_owner` persists with the row. No new exclusive slot or
  recovery mechanism, so no recovery-matrix row.

## Migration Plan

- An additive nullable column, `task_owner`, added in `messageSchema.ts`.
  Existing rows stay null and route exactly as today.
- Deploy and restart. The lead group takes effect when `lead.md` carries
  `affinity`, which a group reload or restart picks up.
- **Rollback:** remove `affinity` from `lead.md` to disable affinity. Aging
  has no switch, so reverting it means reverting the dispatcher commit.

## Open Questions

- Should the Mailbox row show the recorded owner beside the recipient? This
  is display only and can follow without changing the specs.
