# Proposal

## Why

The team runs two leads in one `lead` group so that two sessions share the
lead mailbox. They do not share it. On 2026-11-05, 13 checkpoint and blocked
reports from developers and reviewers to `lead` stayed queued for up to three
hours with no claim. The last group delivery to `lead` was at 13:38 UTC.

Two causes combine:

1. **Direct mail always goes first.** The delivery order (`agent-mailbox`,
   "Delivery order") puts every normal direct message before every normal
   group message. The two leads sent each other 22 direct messages in the
   three hours. Each time a lead went idle, a message from the other lead was
   already waiting for it, so neither lead was ever idle with an empty direct
   queue, and group mail never reached either of them.
2. **Any lead can get any message, but handling one needs that task's
   history.** A lead handling another lead's task first rebuilds the task's
   state with repeated `task_get` reads (7 to 11 per task in three hours), or
   asks the other lead by mail. The leads already keep ownership by
   convention ("Global-owned", "primacy lead", break-glass rules) and maintain
   it through that mail.

Every stuck message came from a session with an assigned task, and each of
those tasks was created by one of the two leads: 7 by one, 6 by the other.
Kawai therefore already knows which lead owns each message, and the split is
close to even.

## What Changes

- **Task-owner affinity for group mail (opt-in per group).** A group can set
  `affinity: task-owner`. At send time, Kawai records the task owner on the
  group message. The task is the message's `task_id`, else the sender's
  current task. Its owner is the task's creator, when that creator is a member
  of the target group. Routing gives the message to the owner when the owner
  is idle and eligible.
- **Bounded wait for a busy owner.** While the owner is a live member that is
  only busy or waiting on a card, the message is held for at most
  `affinityWait` minutes (default 30) from its creation, with the waiting
  reason `owner-busy`. In every other case the group's normal strategy
  decides immediately: the owner is gone, archived, context-exhausted,
  unavailable, parked, or cooling, or the message's filters exclude it, or the
  wait has run out. This keeps load sharing as the fallback.
- **Group mail ages ahead of direct mail.** Normal group mail that has been
  due for 15 minutes or longer is routed before normal direct mail in each
  dispatch pass. Fresher group mail keeps today's order. Urgent mail is
  unchanged. **BREAKING (delivery order):** an idle agent with a normal direct
  message can now receive an older group message first.
- **Rules and observers see the owner.** The route context's message gains an
  additive `taskOwner` field. The pure eligibility check accepts the owner and
  ranks an eligible owner first, so the dispatch preview and `team_capacity`
  agree with routing.
- **The lead group opts in.** `.kawai/groups/lead.md` sets
  `affinity: task-owner`. Its guidance says to record coordination in the
  task journal instead of relaying notices to the other lead by mail.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-mailbox`: the delivery order gains group-mail aging, and group mail
  records its task owner at send.
- `team-routing-rules`: groups can route by task owner with a bounded wait;
  rules see the owner; the pure eligibility check takes the owner into
  account.
- `team-waiting-reasons`: a message held for a busy owner names that owner
  and the end of the wait.

## Impact

- `src/server/team/dispatcher.ts`: per-pass order with an aged-group step.
- `src/server/team/routing/router.ts`, `routing/builtin.ts`,
  `routing/workerEligibility.ts`: the owner pick, the owner hold, and owner
  ranking.
- `src/server/team/TeamMailbox.ts`, `enqueueInput.ts`, `mailboxStore.ts`,
  `messageSchema.ts`: an additive `task_owner` column, set at send.
- `src/server/team/groupFile.ts`: `affinity` and `affinityWait` frontmatter.
- `src/shared/routing.ts`, `src/shared/team.ts`,
  `src/server/team/waitingReasons.ts`, `src/client/utils/waitingLabels.ts`:
  the `taskOwner` route field and the `owner-busy` constraint and label.
- `.kawai/groups/lead.md`; `docs/architecture/routing.md` and `mailbox.md`
  bullets.
- No new dependency. Routing rules written for the current context keep
  working.
- Not covered: the tool-output size problems from the same analysis. The
  in-flight `bounded-metrics-and-task-get` change handles those.
