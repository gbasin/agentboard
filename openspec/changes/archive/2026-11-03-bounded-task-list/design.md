# Design

## Context

See proposal.md (Why) for the motivation and measured sizes.

- `task_list` (`src/server/team/taskTools.ts`) calls `TaskService.list`,
  which calls `TaskStore.list(teamId)`. That call loads every task of the
  team with its current revision's direction and acceptance
  (`selectTasks`), then builds a `TeamTaskSummary` for each one
  (`summary`). Each summary runs a participants `UNION` query, the outstanding
  assignment lookup, and the outstanding result's findings: N+1 queries for
  the whole team. The status filter is applied in JavaScript afterwards.
- `TaskService.list` has no production caller besides the agent tool. The
  Team page's snapshot (`messageConnections.ts`), the mailbox's open-task
  lookup (`sessionMailbox.ts`), and `TaskResultService` call
  `TaskStore.list` directly. The human's task detail uses `detail`.
- `bounded-log-reads-and-task-get` (D4–D7) set the pattern this change
  follows: an agent-only service read, windows taken in SQL inside one
  synchronous read transaction, `(created_at, rowid)` anchors, a single zod
  message per argument so both tool runtimes name the range, and
  agent-facing text updated in the same commit as the registration.

## Goals / Non-Goals

**Goals:**
- An agent `task_list` whose size scales with the window, not the team's
  history: at most 200 compact rows, with no free-text task fields.
- SQL does the filtering and limiting. Per-row work (assignee, result) runs
  only for returned rows.
- One derivation of assignment state and result verdict, shared with the
  human's `TeamTaskSummary`.

**Non-Goals:**
- Search, or filters beyond status (parent, plan, assignee, "mine"). These can
  come later as additive arguments.
- Any change to the Team page, `task_get`, or `TeamTaskSummary`.
- Bounding `plan_list`, which has the same shape problem but is a separate
  change.
- A whole-response byte bound. Titles are unbounded text, but each row's
  other fields are bounded.

## Decisions

### D1 — An agent-only compact row

`src/shared/teamTasks.ts` adds:

```ts
interface AgentTaskRow {
  id: string; title: string; status: TaskStatus; creator: TaskCreator
  parentId: string | null; worktree: string | null; openspecChange: string | null
  planId: string | null; planChange: string | null
  revision: number; createdAt: string; updatedAt: string
  assignee: { targetKind: 'group' | 'session'; targetId: string; role: string | null
              claimedBy: string | null; state: TeamTaskAssignment['state'] } | null
  result: { id: string; reviewVerdict: 'pass' | 'fail' | null; accepted: boolean
            needsReevaluation: boolean } | null
}
interface AgentTaskList {
  tasks: AgentTaskRow[]
  statuses: TaskStatus[]          // the filter applied
  bounds: { total: number; returned: number; truncated: boolean; nextBefore: string | null }
}
```

Dropped fields and why:
- `direction`, `acceptance`, and the assignment `instruction` are the bulk of
  the size, and `task_get` returns them.
- `participants` grows with every journal author and mail sender, and is the
  costliest query.
- `requestKey`, `messageId`, the dead-letter `reason`, `handoffKind`,
  `expectedResponse`, `workerChoice`, and `planTitle` are dispatch internals
  or repeated text. `task_get` carries all of them.

`assignee` and `result` are projections of the same values that
`TaskStore.summary` derives: `outstandingOf(listByTask)` for the assignment,
and `results.outstanding` plus its newest findings for the result. The
derivation is extracted into one private helper used by both `summary` and the
compact projection, so the two readers cannot drift apart (oracle hazard
"Several readers disagreeing on derived state").

*Alternative considered:* a `fields`/`verbose` argument that keeps the full
records available. Rejected. A verbose list of 442 tasks is exactly the
failure this change removes, and `task_get` already serves the full record
for one task.

*Alternative considered:* keeping a short direction preview, such as 200
bytes. Rejected for now: titles are written to be descriptive. A preview can
be added later as an additive field if agents prove to need it.

### D2 — Status filter with an open default

The schema's `status` becomes `z.enum([...TASK_STATUSES, 'all'])`, optional.
It has one explicit error message naming the five statuses and `all`, so
both runtimes' refusals name the accepted values. The applied set is:
- omitted: `['open', 'active', 'blocked']`;
- `all`: all five statuses;
- a status: that status alone.

The set is returned as `statuses`. That way an agent reading the result
cannot mistake "no done tasks shown" for "no done tasks exist".

*Alternative considered:* `include_closed: boolean`. Rejected: it adds a
second argument that interacts with `status`. `all` folds both into the
existing argument.

### D3 — Bounded window in SQL

`TaskService.agentList(caller, { status?, limit?, before? })` replaces `list`
on the agent path. After the awaited caller and team checks, one synchronous
read transaction (no `await` inside) runs:
1. **Anchor check:** `SELECT created_at, rowid FROM team_tasks WHERE id = ? AND team_id = ?`.
   When no row matches, the call is refused with `Unknown task for this team: <id>`.
2. **Window:** `SELECT t.id, t.title, t.status, … FROM team_tasks t WHERE t.team_id = ? AND t.status IN (…)
   [AND (t.created_at < a OR (t.created_at = a AND t.rowid < r))]
   ORDER BY t.created_at DESC, t.rowid DESC LIMIT n + 1`.
   It does not join `team_task_revisions`, and no direction or acceptance is
   read.
3. **Count:** `COUNT(*)` with the same team and status predicate, without the
   anchor.
4. **Assignee and result** for each returned row, through the shared helper
   from D1. That is at most 200 rows.

`truncated` is true when row `n + 1` exists, and `nextBefore` is then the
id of the oldest returned row. The rows are returned **newest first**. This
differs from `task_get`'s oldest-first windows on purpose: a task index is
read for current work, and a truncated window should hold the newest tasks.

`limit` is an integer from 1 to 200 (default 50), with one message naming
the range 1–200. `before` is a non-empty string. The anchor may be a task
whose status is outside the filter. It only marks a position.

Paging from the first window until `truncated` is false returns every
matching task of an unchanged team exactly once. A task created between calls
sorts after every returned task and shows up in a fresh first window. A
task's status change between calls can move it into or out of the filter. No
snapshot across calls is promised (the same contract as D5 of the
`task_get` change).

Ordering by `created_at` rather than `updated_at` keeps anchors stable:
`updated_at` changes on every note and status change, so an anchor ordered by
it would skip or repeat rows.

### D4 — Agent-facing text

These are updated in the same commit as the new schema and handler:
- The `task_list` description: *"List this team's tasks as compact rows
  (no direction or acceptance — use task_get), newest first. Without status,
  only open, active, and blocked tasks; status takes one status or "all".
  At most limit rows (1–200, default 50); page older with before set to
  bounds.nextBefore. bounds.total counts every match."*
- The team prompt's `task_list` line (`teamPrompt.ts`).
- The `task_list` part of the task tools bullet in `docs/architecture/tasks.md`.

### Acceptance oracles

Decision table for the status filter (observable: `statuses` and the set of
statuses among the rows):

| id | `status` arg | applied `statuses`             | outcome |
|----|--------------|--------------------------------|---------|
| S1 | omitted      | open, active, blocked          | rows of those statuses only |
| S2 | `all`        | open, active, blocked, done, cancelled | every task |
| S3 | `open`…`cancelled` (5 rows) | that one status | rows of that status only |
| S4 | `closed`, `""`, `ALL` | —                     | refused naming the five statuses and `all` |

Decision table for the window (team with M matching tasks, limit n):

| id | `before`                        | M vs n      | rows                    | truncated | nextBefore |
|----|---------------------------------|-------------|-------------------------|-----------|------------|
| W1 | omitted                         | M ≤ n       | all M, newest first     | false     | null |
| W2 | omitted                         | M > n       | newest n                | true      | oldest returned id |
| W3 | task of team, any status        | *           | matches strictly older  | per count | per count |
| W4 | the oldest matching task        | *           | none                    | false     | null |
| W5 | task of another team / unknown  | *           | —                       | refused naming the id | — |
| W6 | — (`limit` 0, 201, 1.5)         | *           | —                       | refused naming 1–200 | — |

`total` is M in every non-refused row, whatever `before` is.

Row projection:
- **R1:** every key of `AgentTaskRow` is present. No row contains its task's
  direction, acceptance, or assignment instruction text. This is checked with
  unique marker strings of 4,000+ characters seeded into all three and
  searched for in the serialized result.
- **R2:** for each seeded task, `assignee` and `result` equal the
  corresponding fields of that task's `TeamTaskSummary` (`assignment`
  projected, `outstandingResult`). The fixtures cover queued, claimed,
  failed, superseded-then-replaced, and unassigned assignments, and results
  with pass, fail, and no findings, plus accepted ones.

Invariant properties (bun:test, no new dependency; seeded PRNG, seed `0x7a5c`,
200 cases):
- **P1 (paging completeness):** generator: 0–120 tasks over the five statuses,
  with creation times drawn from 5 distinct values, so ties are common;
  a random filter; a random limit from 1 to 30. Paging from the first window
  to the end yields exactly the filtered set, each task once, in
  `(created_at DESC, rowid DESC)` order, and every page's `total` equals the
  filtered count.
- **P2 (bound):** for every generated call, `returned ≤ limit`, and
  `returned = min(limit, matches older than the anchor)`.

Seams: the oracles run through `taskHandlers(...).task_list`, the production
handler composition, and not through `TaskStore` directly (oracle hazard M1).
S4, W5, and W6 also run through the Codex runtime path covered by
`codexTeamPath.integration.test.ts`. Each refusal row asserts the same error
envelope that the existing `task_get` refusals assert (oracle hazard
"Refusals missing the success envelope").

## Risks / Trade-offs

- [Agents parse the old bare array (`.[]`, `.map(row => row.id)`)] → The
  envelope change is deliberate and named in the description. Tool output is
  read by models, not by stored scripts. Kawai's own callers of the old shape
  are tests, which are updated.
- [An agent concludes a done task does not exist] → `statuses` is in every
  result, and the description and prompt name `status: "all"`.
- [Long-lived Codex threads keep the old description and parameter schema] →
  Their calls without arguments still get the bounded default and the
  compact rows. Only `limit`, `before`, and `all` need a fresh thread. This
  is the same caveat D7 of the `task_get` change accepted.
- [Titles are unbounded] → Accepted. Titles are short by convention, and at
  most 200 of them are returned. A later change can cap them if that
  convention breaks.

## Migration Plan

No data migration: the change is read-only. It lands as one commit that
changes the schema, the handler, the texts, and the tests together.
Rollback is a revert.
