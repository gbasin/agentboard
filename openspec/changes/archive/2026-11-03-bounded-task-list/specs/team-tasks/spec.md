# Spec Delta

## ADDED Requirements

### Requirement: task_list returns compact rows
Each row of the agent `task_list` tool SHALL carry the task's id, title, status, creator, parent, worktree, linked change, plan id and plan change, revision, creation and update times, a compact assignee (target kind and id, role, claimant, derived state) or null, and the outstanding result's id, verdict, and acceptance or null. Rows SHALL NOT carry direction, acceptance, the assignment instruction, or participants.

#### Scenario: Row omits the task's text
- **WHEN** an agent lists a task whose direction is 10,000 characters and whose assignment instruction is 4,000 characters
- **THEN** its row carries the title, status, and identifiers, and neither text appears in the result

#### Scenario: Assignee and result are compact
- **WHEN** a task is claimed by a member of `middle-devs` and holds an outstanding result with a passing review
- **THEN** its row names the group, the claimant, and the state, and carries the result's id with verdict pass

#### Scenario: Unassigned task without a result
- **WHEN** a task has no outstanding assignment and no result
- **THEN** its row has a null assignee and a null result

#### Scenario: Human views stay whole
- **WHEN** the human opens the Tasks tab
- **THEN** the tasks there carry their direction, acceptance, assignment, and participants as before

### Requirement: task_list excludes closed tasks by default
`task_list` SHALL accept an optional `status`, which is one task status or `all`. Without it, the tool SHALL return only `open`, `active`, and `blocked` tasks. A status returns only tasks with that status, and `all` returns every status. The result SHALL name the statuses it applied. An unknown status SHALL be refused, naming the accepted values.

#### Scenario: Default omits finished work
- **WHEN** a team holds 10 open, 4 active, 11 blocked, 405 done, and 12 cancelled tasks and an agent calls `task_list` with no status
- **THEN** the result's total is 25, every row is open, active, or blocked, and the applied statuses are those three

#### Scenario: Asking for done tasks
- **WHEN** the agent calls `task_list` with status `done`
- **THEN** only done tasks are listed, with total 405

#### Scenario: Asking for everything
- **WHEN** the agent calls `task_list` with status `all`
- **THEN** tasks of every status are listed, with total 442

#### Scenario: Unknown status
- **WHEN** the agent calls `task_list` with status `closed`
- **THEN** the call is refused naming the five statuses and `all`, through either tool runtime

### Requirement: task_list is bounded and paged
`task_list` SHALL return at most `limit` matching tasks (an integer from 1 to 200, default 50), newest first by `(created_at, rowid)`. It SHALL report the matching total, the returned count, whether it was truncated, and a next anchor, applying filter and limit in SQL. `before`, a task id of the team, SHALL return the matching tasks older than it. An id outside the team SHALL be refused naming it, as SHALL a limit out of range.

#### Scenario: Large backlog
- **WHEN** an agent calls `task_list` with status `done` on a team with 405 done tasks
- **THEN** it receives the 50 newest done tasks, newest first, with total 405, truncated, and a next anchor

#### Scenario: Paging to the end
- **WHEN** the agent pages with each result's next anchor until it is not truncated
- **THEN** every matching task of the unchanged team is returned exactly once, including tasks sharing a creation time, and the last page has no next anchor

#### Scenario: Anchor that does not match the filter
- **WHEN** `before` names a done task of the team and the status is the default
- **THEN** the open, active, and blocked tasks created before it are returned

#### Scenario: Small team is whole
- **WHEN** a team holds 3 open tasks and an agent calls `task_list`
- **THEN** all 3 are returned, not truncated, with no next anchor

#### Scenario: Unknown or foreign anchor
- **WHEN** `before` names a task of another team or no task
- **THEN** the call is refused naming the id, through either tool runtime

#### Scenario: Limit out of range
- **WHEN** `limit` is 0, 201, or 1.5
- **THEN** the call is refused naming the range 1–200, through either tool runtime

### Requirement: Agents are told task_list is compact and paged
The `task_list` description and the team prompt's task note SHALL state that `task_list` returns summaries without direction, excludes done and cancelled tasks unless `status` asks for them, and is paged with `limit` and `before`. They SHALL point to `task_get` for a task's direction.

#### Scenario: Prompt names the default and the paging
- **WHEN** an agent starts with the team prompt
- **THEN** its task note says `task_list` lists open, active, and blocked tasks by default, names `status: "all"`, `limit`, and `before`, and points to `task_get` for direction
