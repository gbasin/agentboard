# Design

## Context

See proposal.md for the motivation and specs/profile-limit-handling for the
requirements.

At present, the limit outcome is decided in
`LimitOutcomes.turnEnded(sessionId, success)`
(`src/server/team/routing/limitOutcomes.ts`). `ChatSessionManager` calls it on
every `turn_completed` event that was not exhausted, for every chat session.
`turnStarted(sessionId, agentStarted)` comes before it, where `agentStarted` is
true when the turn has a `trigger`. `delivered(sessionId, message)` records the
mail that the turn handles. A final limit event reaches `pending` through
`LimitEventStore.subscribe`. When the turn ends:

```
event && workId          -> resolve(work)         (park/release/forward by policy)
event && agentTurn       -> parkCurrent()         (parks heldBy work; nothing if none)
success && !event && ... -> unpark parked work    (human turn or the work's own resume)
otherwise                -> nothing               <-- human sessions without mail
```

Facts this design relies on, all observed on master `2aa7566f`:

- Every session resolves a team. A plain directory becomes its own team, with
  `teamId = directory` (`resolveTeam`). Direct mail to any session therefore
  works once `SessionTeams.teamOf` has resolved.
- `ChatSessionRecord.spawned` marks staffing-created sessions. Team Lead
  sessions are human-created (`spawned = 0`), so they are in scope.
- `heldBy` returns every `delivered` or `parked` message a session holds, and a
  delivered message stays `delivered`. `currentWork` already skips
  `resume`-tagged deliveries for this reason.
- Agent workers are reported through `onWorkers(sessionId, ChatWorker[])` and
  `getWorkers(sessionId)`. A failed worker has `status: 'failed'`, and its
  `summary` carries the CLI's error text. In the incident that text was
  `… (error type rate_limit, HTTP 429, …)`.
- `turnStarted` never clears `pending`. An interrupted turn never reaches
  `turnEnded`, so its final limit event carries over into the next turn.
- `SessionMailbox` has a hook that runs when a session is archived, killed, or
  restored (`sessionMailbox.ts`, "its pending release is moot").
- `parkedState(sessionId)` in `ChatSessionManager` projects the paused header
  from `parkedBy` alone.

## Goals / Non-Goals

**Goals:**

- One decision function, so the scheduler and the paused display never
  disagree about whether a limit-resume is pending.
- The resume survives a server restart without a schema migration.

**Non-Goals:**

- Limits that only a worker hits while the parent session's own calls still
  succeed. Today these record no event (`ChatSessionDriver` skips subagent
  frames), and recording them is a separate change.
- Automatically re-dispatching lost workers. The resume names them, and the
  agent decides.
- Changing parked, released, or forwarded team work, or recovery for spawned
  sessions.
- Codex-specific handling. The rule is runtime-agnostic: it reads final limit
  events, which Codex records too. Its tests use the Claude driver fixture.

## Decisions

### D1: The resume is a scheduled direct team message

The resume is enqueued with `MailboxStore.enqueue` as `toKind: 'session'`,
`toId` and `fromSession` both the session, and
`tags: ['limit-resume', 'limit-resume-attempt:<n>']`, with `deliverAt` set to
the reset time (`resetTime(event)`, which falls back to `at` + 1 h). Mail is
durable, is delivered by the dispatcher at its time, appears under
**Scheduled** in the Mailbox tab, and can be cancelled. This is the same route
the parked `resume` already takes. The attempt number in a tag keeps the
consecutive-resume count durable without a column.

*Alternatives:* An in-process timer would be lost on restart and invisible. A
new `chat_sessions` column would need a migration, and it duplicates
scheduling that the mailbox already does.

### D2: Eligibility is one pure function

`limitResumeDecision(input) -> { kind: 'none' } | { kind: 'schedule', attempt, at } | { kind: 'supersede', at } | { kind: 'cancel' }`
lives in `src/server/team/routing/limitResume.ts`. Its inputs are the turn's
facts: `spawned`, `teamResolved`, `heldWork` (the `heldBy` result without
`limit-resume` messages), `event` (none, credit, or final with reset), `now`,
`turnKind` (human, agent-started, limit-resume with attempt n, or other mail),
`success`, `pending` (the pending limit-resume: its id, time, and attempt), and
`capped`. `LimitOutcomes.turnEnded` calls it only on the branch where no work
was resolved or parked: human and limit-resume turns whatever they hold, and
agent-started turns that hold nothing (an agent-started turn with held work keeps
`parkCurrent`). The decision table below is committed verbatim as its
test table.

### D3: A delivered limit-resume is never resolved as work

`delivered()` still records the message as the turn's `active` work, which
keeps the progress digest. However, `turnEnded` checks the `limit-resume` tag
before `resolve()`: such a message goes to D2 with
`turnKind: limit-resume(n)` instead of to the group policy. `currentWork` and
the `heldWork` input both skip `limit-resume` tags, matching the existing
`resume` exclusion. Without this check, a resumed turn that hits the limit
again would release a limit-resume to the session's group, or park it on the
session.

### D4: One pending limit-resume, replaced in one transaction

`MailboxStore.pendingLimitResume(sessionId)` returns the scheduled or queued
message to the session that carries the `limit-resume` tag. To supersede it,
Kawai cancels the old message (system actor, reason
`superseded by <new id>`) and enqueues the replacement inside one
`db.transaction`. The replacement keeps the old body's worker lines and attempt
number and takes the later reset. If the cancel fails because the dispatcher
already claimed the message, nothing is enqueued and the claimed resume goes
ahead (row O15b).

### D5: Failed workers are read from the roster when scheduling and appended later

`isLimitFailure(summary)` matches `error type (rate_limit|billing_error|overloaded)`,
or `HTTP 429`, in a worker's summary. It reuses `LIMIT_ERROR_CLASSES` from
`limitSignals.ts`. When Kawai schedules a resume, the body lists each failed
worker from `getWorkers(sessionId)` that passes `isLimitFailure` and that no
earlier delivered limit-resume of the current run has named. On each
`onWorkers` push while a resume is pending, a newly limit-failed worker whose
task id does not already appear in the body is appended through D4's
supersede path, with the same time and attempt. Deduplicating by task id in
the body keeps this idempotent across restarts and repeated roster pushes.

Body, with one line per lost worker:

> Your provider limit (`<profile>`) has reset. Your last turn stopped on the
> limit; continue where you left off, checking `git status` first. These
> background agents failed on the limit and their work was lost; re-dispatch
> what is still needed:
> - "Budget metrics and report tools" (task ae109e7e514ff68c5)

### D6: The human's activity cancels; archive cancels without restoring

A successful human turn cancels the pending limit-resume and clears `capped`.
A "human turn" is a turn with `agentStarted = false` that handled no delivered
mail. The `SessionMailbox` archive, kill, or restore hook cancels the pending
limit-resume on archive and kill, so the dispatcher never delivers it, and
direct mail would otherwise restore an archived session.

### D7: The cap is in memory, seeded from the tag

`capped` is a per-session set in `LimitOutcomes`. A session joins it when a
limit-resume turn with attempt 3 ends after a final limit. It leaves on a
successful human or limit-resume turn. Agent-started limited turns of a capped
session schedule nothing. After a restart the set is empty. The cap is still
enforced for chained resumes, because the attempt number travels in the tag.
Only a fresh agent-started limit after a restart can begin a new run. See
Risks.

### D8: `turnStarted` drops a stale pending event

`turnStarted` also clears `pending` for the session. Without this, a final
limit from an interrupted turn would carry into the human's next turn. That
turn would then schedule a resume after succeeding, and would also fail to
unpark parked work. This fixes an existing leak that parking shares.

### D9: The paused display reads the same pending query

`parkedState` falls back to `pendingLimitResume(sessionId)` when no message is
parked. It returns `{ messageId, until: deliverAt, profileId, reason }`, so the
existing header and navigator badge show "paused … resumes at". `refreshParked`
already runs on mailbox changes, so schedule, cancel, and delivery all update
it.

## Acceptance oracles

### Turn-end decision table (D2)

Inputs:

- `spawned`: S or H (human-created)
- `held`: held work that is not a limit-resume
- `event`: none, credit, `ahead` (a final event whose reset is after now), or
  `passed` (a final event whose reset is not after now)
- `kind`: human, agent, `lr(n)` (a delivered limit-resume with attempt n), or
  mail (other delivered mail)
- `pending`: the pending limit-resume, with its time `P`
- `capped`

Observable outputs: the limit-resume rows of the session (pending count, time,
attempt, body) and the states of held messages.

| id | spawned | held | event | kind | pending | capped | success | team | result |
|---|---|---|---|---|---|---|---|---|---|
| O1 | S | * | * | * | * | * | * | * | no limit-resume change; existing path unchanged |
| O2 | H | yes | ahead | agent | * | * | * | yes | held work parked as today (`parkCurrent`); no new limit-resume; any pending one unchanged |
| O2a | H | yes | ahead | human | none | * | * | yes | one pending limit-resume, attempt 1, at reset; capped cleared; held messages unchanged (no human-turn parking, as today) |
| O3 | H | no | ahead | human | none | * | * | yes | one pending limit-resume, attempt 1, at reset; capped cleared |
| O4 | H | no | ahead | agent | none | no | * | yes | one pending, attempt 1, at reset |
| O5 | H | no | ahead | agent | none | yes | * | yes | none scheduled |
| O6 | H | no, or yes with kind human | ahead | human/agent | P < reset | * | * | yes | one pending at reset; attempt and worker lines kept; the old one is cancelled and never delivered |
| O7 | H | no, or yes with kind human | ahead | human/agent | P >= reset | * | * | yes | the pending one is unchanged |
| O8 | H | * | ahead | lr(n), n<3 | none | * | * | yes | one pending, attempt n+1, at reset; the delivered lr is not parked, released, or forwarded; held messages unchanged |
| O9 | H | * | ahead | lr(3) | none | * | * | yes | none scheduled; capped set; the delivered lr is not parked, released, or forwarded |
| O10 | H | * | credit | * | * | * | * | * | nothing scheduled or cancelled |
| O11 | H | * | passed | * | * | * | * | * | nothing scheduled |
| O12 | H | * | none | human | * | * | yes | * | a pending one is cancelled, never delivered; capped cleared; paused display cleared |
| O13 | H | * | none | lr(n) | none | * | yes | * | capped cleared; nothing scheduled |
| O14 | H | * | none | agent | * | * | yes | * | nothing changes; a pending one is delivered at P |
| O15 | H | * | none | * | * | * | no | * | nothing changes |
| O17 | H | * | ahead | * | * | * | * | no | nothing scheduled; warning `limit_resume_team_unresolved` logged |

Events outside turn ends:

| id | event | state | result |
|---|---|---|---|
| O15a | worker settles failed, `isLimitFailure` | pending P, task id not in body | the replacement at P names the worker; exactly one pending |
| O15b | the same | pending already claimed by the dispatcher | nothing enqueued; the claimed resume is delivered unchanged |
| O15c | the same, repeated push or after a restart | task id already in body | no change |
| O15d | worker settles failed, not a limit failure | pending P | no change |
| O18 | session archived or killed | pending P | cancelled; the session stays archived at P |
| O19 | turn interrupted after a final event, then a human turn succeeds | none | nothing scheduled; parked work unparked as for any successful human turn |
| O20 | dispatcher delivers the pending resume at P | pending P | the session starts a turn without human input; paused display cleared |
| O16 | a limit-resume turn of a session holding delivered mail ends after a final limit | none | the held mail stays delivered (never parked by that turn); the next limit-resume is scheduled per O8/O9 |

Unreachable combinations:

- `kind = mail` together with `held = no`: delivered mail is held until
  settled, so it is part of `held`.
- `kind = lr(n)` together with `pending` present: the delivered message was
  the pending one, and D4 allows only one.
- `spawned = S` with `kind = lr(n)`: no limit-resume is ever scheduled for a
  spawned session (O1).

**Completeness claim.** Every combination of the axes (spawned × held ×
event × kind × pending × capped × success × team, with `kind` over human,
agent, and lr(1..3)) matches exactly one row of O1–O17, or one of the
unreachable claims above. The table test enumerates the product, skips the
unreachable combinations, and asserts exactly one matching row for each
remaining one.

### Properties

- **P1 (one pending).** For any seeded sequence of turn ends, worker pushes,
  dispatcher deliveries, archives, and restarts (generator `seq(seed)` over
  the table's input alphabet, seed `0x11a7`, 500 cases, using the existing
  `MailboxStore` over an in-memory database), each session has at most one
  pending `limit-resume` message.
- **P2 (never re-routed).** In the same runs, no `limit-resume` message ever
  enters `parked` or `forwarded`, and none is released to a group.
- **P3 (bounded).** In the same runs without restarts, a session never
  receives more than 3 limit-resumes between two successful human or
  limit-resume turns.
- **P4 (replay).** If a restart is injected after each transaction boundary
  of D4 (between cancel and enqueue, which are inside one transaction, so
  there is either both or neither), P1 still holds and no worker line is lost.

### Seams (oracle-hazards M1, "several readers")

- O3, O12, O18, O20, and O15a each have at least one test that goes through
  `ChatSessionManager` with the driver fixture emitting the incident's frames:
  a 429 worker `task_notification`, then a synthetic `rate_limit` assistant
  error, then a `result` with `is_error`. Testing `LimitOutcomes` alone is
  not enough.
- The scheduler and `parkedState` both read `pendingLimitResume`, and a test
  asserts that the header's `until` equals the message's `deliver_at`.

## Risks / Trade-offs

- [The agent continues unattended under `auto` approval] → This is the
  human's explicit choice. The resume is visible and cancellable under
  Scheduled, the session is shown as paused, and any successful human turn
  cancels it.
- [A restart clears `capped`] → Chained resumes stay capped through the tag.
  Only a new agent-started limit after a restart can begin a new run, and each
  run waits for a reset, so the cost is at most 3 extra resumes.
- [`isLimitFailure` depends on the CLI's error text] → The pattern is pinned
  to the captured incident summary in a test. If the text drifts, a lost
  worker goes unnamed, but the resume still happens.
- [Clearing `pending` at `turnStarted` (D8) changes parking too] → This is
  intended, and O19 covers it. It requires every limit event to arrive after
  its turn's `turn_started`, which holds for both the delivery and the
  agent-started path (`system/init` opens the turn).
- [A worker limit without a parent event schedules nothing] → Out of scope
  (Non-Goals).

## Migration Plan

There is no migration. The change ships with the server. A rollback leaves any
pending `limit-resume` rows as ordinary scheduled direct mail, and these would
still be delivered once.

## Open Questions

None.
