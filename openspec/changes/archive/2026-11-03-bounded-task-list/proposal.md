# Proposal

## Why

The agent `task_list` tool returns every task of the team with its full
direction, acceptance criteria, the outstanding assignment's verbatim
instruction, and its participant list, with no bound. On the live team (442
tasks, 405 of them done) an unfiltered call is about 2.2 MB, roughly 550k
tokens. That is larger than any agent's context window. The titles, ids, and
statuses an agent actually wants come to about 29 KB of it. Even a filtered
call costs a lot: `status: "blocked"` returns about 85 KB to show 11 tasks.
Agents work around it by parsing the dump with jq, or they burn their cache.
Every unfiltered call gets worse as finished tasks accumulate. The earlier
`bounded-log-reads-and-task-get` change bounded `task_get`. `task_list` is the
remaining unbounded agent read on tasks.

## What Changes

- **BREAKING (agent tool output):** `task_list` returns compact task rows instead of
  full `TeamTaskSummary` records. Each row carries id, title, status, creator,
  parent, worktree, linked change, plan id and plan change, revision,
  timestamps, a compact assignee (target, role, claimant, state), and the
  outstanding result's id, verdict, and acceptance. It drops direction,
  acceptance, the assignment instruction, participants, and the other
  dispatch internals. `task_get` remains the way to read a task's direction.
- **BREAKING (default filter):** with no `status`, `task_list` returns only open
  tasks (`open`, `active`, `blocked`). Done and cancelled tasks need an
  explicit `status: "done"`, `status: "cancelled"`, or `status: "all"`.
- **BREAKING (envelope):** the result becomes an object: the rows plus bounds
  (total matching, returned, truncated, next anchor) and the status filter
  applied. It is no longer a bare array.
- `task_list` is bounded and paged. It returns the newest 50 matching tasks
  (`limit` 1–200), newest first by creation. `before` takes the previous
  result's next anchor and pages to older tasks. The filter and the limit
  are applied in SQL before rows reach JavaScript.
- The `task_list` description and the team prompt's task note say that rows
  are summaries, that closed tasks are excluded by default, and that the list
  is paged with `limit` and `before`.
- The human's Team page is unchanged: it does not use this tool.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-tasks`: adds requirements that the agent `task_list` returns compact,
  bounded, paged rows, excludes closed tasks by default, and is described to
  agents as such.

## Impact

- `src/server/team/taskTools.ts`: the `task_list` schema, description, and handler.
- `src/server/team/TaskService.ts`: `list` becomes a bounded, compact agent read.
  It has no other production caller.
- `src/server/team/taskStore.ts`: a filtered, limited, anchored SQL query and a
  compact row projection. `list`/`summary` stay for the UI's other callers.
- `src/shared/teamTasks.ts`: new compact row and bounds types.
- `src/server/team/teamPrompt.ts`: the task note's `task_list` line.
- `docs/architecture/tasks.md`: the task tools bullet.
- Tests: `teamTaskService.test.ts` (existing `task_list` assertions),
  `teamPrompt.test.ts`, and a new `task_list` test file.
- Codex threads keep the tool catalogue they registered at thread start. The
  new output reaches them at once, but the new `limit`/`before` parameters and
  the new description reach only fresh threads. Old threads still get the
  bounded default.
