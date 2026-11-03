# team-tasks Specification

## Purpose

Gives a team one durable record per feature or request — direction, acceptance criteria, status, and a journal — that every participating agent follows, with direction controlled by the task's creator.

## Requirements

### Requirement: Tasks can be created by the human and by permitted groups
The human SHALL be able to create a task for a team from the UI. A chat agent SHALL be able to create a task with a tool only when its group's frontmatter sets `canCreateTasks: true`; otherwise the tool SHALL return an error. A task SHALL record title, direction, optional acceptance criteria, creator, creation time, and status `open`.

#### Scenario: Team lead creates a task
- **WHEN** a member of a group with `canCreateTasks: true` creates a task
- **THEN** the task exists with that agent as creator and status `open`

#### Scenario: Dev cannot create a task
- **WHEN** a member of a group without `canCreateTasks` calls the create tool
- **THEN** the tool returns an error and no task is created

#### Scenario: Human creates a task
- **WHEN** the user creates a task from the team's task list
- **THEN** the task exists with the human as creator

### Requirement: Tasks may have a parent, a worktree, and a linked change
A task SHALL optionally reference a parent task of the same team, a target worktree, and an OpenSpec change. A target worktree SHALL be the repository's main working tree or one of its linked worktrees; any other path SHALL be refused. A linked change SHALL exist in the repository's OpenSpec changes.

#### Scenario: Subtask
- **WHEN** a team lead creates a task with a parent task
- **THEN** the task detail of the parent lists the new task as a subtask

#### Scenario: Invalid worktree refused
- **WHEN** a task is created with a target path that is not a worktree of the team's repository
- **THEN** creation is refused with an error naming the path

### Requirement: Only the creator or the human amends direction
The task's direction and acceptance criteria SHALL be changeable only by the task's creator or the human. A change SHALL become a new numbered revision only when published; the human's saved drafts are not revisions. Earlier revisions SHALL remain viewable. Other agents' attempts SHALL be refused with an error suggesting a journal note or a message to the creator.

#### Scenario: Creator amends
- **WHEN** the creating team lead amends the direction
- **THEN** the task shows the new direction as revision 2 and revision 1 remains viewable

#### Scenario: Contributor cannot amend
- **WHEN** a dev agent tries to amend a task it did not create
- **THEN** the tool returns an error and the direction is unchanged

#### Scenario: Human draft is not a revision
- **WHEN** the human saves a draft of a new direction without publishing it
- **THEN** the task still shows revision 1 as its direction

### Requirement: Tasks have an append-only journal
Any team member and the human SHALL be able to append journal entries to a task. The system itself SHALL also append entries for actions it takes on a task's behalf, authored as kawai. Entries SHALL record author, time, and text and SHALL NOT be editable or deletable.

#### Scenario: Agent notes a decision
- **WHEN** a dev appends a note explaining a design choice
- **THEN** the note appears in the task's journal with the dev as author

#### Scenario: System entry
- **WHEN** kawai releases a task's spawned member
- **THEN** the task's journal shows the entry with kawai as author, and it cannot be edited or deleted

### Requirement: Task status and closing
Any team member SHALL be able to set a task to `active` or `blocked`. Only the creator SHALL be able to set it to `done` or `cancelled`. The human SHALL be able to set any status, including reopening a closed task.

#### Scenario: Contributor reports blocked
- **WHEN** a dev sets a task to `blocked` with a journal note
- **THEN** the task shows `blocked`

#### Scenario: Contributor cannot close
- **WHEN** a dev tries to set a task it did not create to `done`
- **THEN** the tool returns an error and the status is unchanged

#### Scenario: Human reopens
- **WHEN** the user reopens a `done` task
- **THEN** the task becomes `open`

### Requirement: Messages may reference a task
Sending, replying, and scheduling SHALL accept an optional task id of the sender's team. A reply SHALL inherit its original message's task when none is given. A task id of another team or an unknown task SHALL be refused.

#### Scenario: Reply inherits task
- **WHEN** a dev replies without a task id to a message that referenced task T
- **THEN** the reply references task T

#### Scenario: Message without a task
- **WHEN** an agent sends a quick question without a task id
- **THEN** the message is delivered with no task header

### Requirement: Delivered task messages carry the task context
When a message referencing a task is delivered, the recipient SHALL receive with it the task's title, current direction and acceptance criteria, revision number, status, linked change, target worktree, and its most recent journal entries. If the task has a linked OpenSpec change, the context SHALL state that the change's artifacts are the authoritative direction.

#### Scenario: Task header on delivery
- **WHEN** a QA agent receives a message referencing task T
- **THEN** the delivered turn includes T's title, direction, status, and latest journal entries

#### Scenario: Linked change is authoritative
- **WHEN** a message references a task linked to OpenSpec change `add-x`
- **THEN** the delivered context names `add-x` and says its proposal, design, and tasks are the authoritative direction

### Requirement: Tasks are inspectable in the UI
The UI SHALL list a team's tasks with title, status, creator, and participants, and SHALL show a task's direction with revision history and rationale, journal, subtasks, and messages. The human SHALL be able to change status, and to change direction from the task detail through **Save draft**, **Publish revision**, and **Publish and notify**. A chat session working on a task SHALL show the task in its header.

#### Scenario: Task detail
- **WHEN** the user opens a task
- **THEN** its direction, revisions, journal, subtasks, and messages are shown

#### Scenario: Three direction actions
- **WHEN** the user edits a task's direction in the detail
- **THEN** **Save draft**, **Publish revision**, and **Publish and notify** are offered as separate actions

### Requirement: Tasks persist
Tasks, revisions, and journal entries SHALL persist across server restart and SHALL remain after their participating sessions are archived or killed.

#### Scenario: Creator killed
- **WHEN** a task's creating session is killed
- **THEN** the task remains, and the human can still amend and close it

### Requirement: Tasks may link to a plan change
A task SHALL optionally name, at creation, a plan of its team and one change of that plan's current approved revision; both or neither SHALL be given. The plan SHALL be open and have an approved revision, and any other reference SHALL be refused naming it. The link SHALL be immutable after creation and SHALL survive later plan revisions.

#### Scenario: Linked at creation
- **WHEN** the lead creates a task naming plan P and its change `api`
- **THEN** the task records the link, and P's detail lists the task under `api`

#### Scenario: Plan without an approved revision refused
- **WHEN** a task names a plan that has only revisions in review
- **THEN** creation is refused naming the plan, and no task is created

#### Scenario: Unknown change refused
- **WHEN** a task names change `cli` of a plan whose approved revision has no change `cli`
- **THEN** creation is refused naming `cli`

#### Scenario: Another team's plan refused
- **WHEN** a task names a plan of another team
- **THEN** creation is refused as if the plan did not exist

### Requirement: Delivered mail for a linked task names its plan change
When a message referencing a task linked to a plan change is delivered, the task context SHALL name the plan's title and id, its current approved revision at delivery, and the change. Tasks without a link SHALL keep the existing context shape.

#### Scenario: Plan line on delivery
- **WHEN** an agent receives a message referencing a task linked to change `api` of plan P at approved revision 2
- **THEN** the delivered context names P, revision 2, and `api`

#### Scenario: Unlinked task unchanged
- **WHEN** an agent receives a message referencing a task without a plan link
- **THEN** the delivered context has no plan fields

### Requirement: Task status transitions are recorded
Every change of a task's status SHALL append one durable row naming the task, the previous and new status, the actor (the human, an agent session, or Kawai), and the time, in the same transaction as the change. Rows SHALL never be edited or deleted and SHALL survive restart and the actor's archive or kill. A request that leaves the status unchanged SHALL append nothing.

#### Scenario: Reopen is recorded
- **WHEN** the human reopens a `done` task
- **THEN** a transition from `done` to `open` by the human is recorded

#### Scenario: Acceptance closes the task
- **WHEN** accepting a result sets the task to `done`
- **THEN** a transition to `done` is recorded with the accepting actor

#### Scenario: Refused change
- **WHEN** a contributor's attempt to set `done` is refused
- **THEN** no transition is recorded

### Requirement: Kawai creates the tasks of a plan execution
A plan execution SHALL create its tasks with Kawai as the creator, shown as "Kawai", never as the human or an agent session. Kawai SHALL be a creator only through a plan execution, an owner's decision override, or a failed promotion, and SHALL close its tasks under the existing closing rights. An execution's task SHALL link to the plan change of the execution's revision, even when a later approved revision no longer names that change. A fix or correction task SHALL link to no plan change.

#### Scenario: Kawai's task in the task list
- **WHEN** an execution provisions change `api`
- **THEN** the team's task list shows a task for `api` created by Kawai, linked to the plan change and targeting `.worktrees/api`

#### Scenario: The link follows the execution's revision
- **WHEN** revision 4, approved during an execution of revision 3, drops change `cli`, and the execution then schedules `cli`
- **THEN** Kawai's task for `cli` links to `cli` of revision 3, and its creation is not refused

#### Scenario: An agent cannot close Kawai's task
- **WHEN** a dev sets the task Kawai created for its change to `done`
- **THEN** the tool returns an error, as for any task it did not create, and the status is unchanged

#### Scenario: Kawai's fix task for an override
- **WHEN** the owner overrides a Lead decision on a plan whose Lead role is `lead`
- **THEN** the task list shows a fix task created by Kawai, linked to no plan change, with its instruction dispatched to `lead`

### Requirement: Only Kawai links tasks to a running execution's changes
While a running execution owns a change, creating another task linked to that change SHALL be refused for the human and for agents, naming the execution. Links to other changes SHALL follow the plan-change link rules unchanged.

#### Scenario: A parallel task for a running change
- **WHEN** the Lead creates a task linked to change `api` while a running execution owns `api`
- **THEN** creation is refused naming the execution, and no task is created

#### Scenario: Linking after the execution
- **WHEN** the execution that owned `api` has finished
- **THEN** a task linked to `api` can be created under the plan-change link rules

### Requirement: Delivered mail for an execution task names its execution
When a message referencing a task that Kawai created for an execution is delivered, the task context SHALL also name the execution and the plan revision it runs, beside the plan's current approved revision. Other tasks SHALL keep their context shape.

#### Scenario: Execution line on delivery
- **WHEN** a dev receives a fix instruction for change `api` of an execution running revision 3 while revision 4 is approved
- **THEN** the context names the execution, revision 3 as the revision it runs, and revision 4 as the current approved revision

#### Scenario: Other tasks unchanged
- **WHEN** an agent receives mail for a task that no execution created
- **THEN** the delivered context has no execution fields

### Requirement: task_get bounds its growing lists
The agent `task_get` tool SHALL return the newest 50 journal entries (or `journal_limit`), the newest 100 subtasks, and the newest 50 messages, oldest first, each list with its total and truncation, applying those limits in SQL before rows reach JavaScript. Other sections, message bodies, and subtask summaries stay whole; no whole-response bound is claimed. The human's task detail SHALL NOT be bounded.

#### Scenario: Long-running task read by an agent
- **WHEN** an agent calls `task_get` on a task with 1,198 journal entries, 149 subtasks, and 60 messages
- **THEN** the result holds the newest 50 entries, 100 subtasks, and 50 messages, each oldest first
- **AND** it reports totals 1,198, 149, and 60, all three truncated

#### Scenario: Small task is whole
- **WHEN** an agent calls `task_get` on a task with 3 journal entries of at most 2,000 bytes that are valid UTF-8, no subtasks, and 1 message
- **THEN** everything is returned whole and readable, and nothing is marked truncated or cut

#### Scenario: Results and revisions stay whole
- **WHEN** a task has more than 50 results or revisions, and a review handoff is outstanding
- **THEN** `task_get` returns every result and revision, with the blind-first seal applied as before

#### Scenario: Human detail stays complete
- **WHEN** the human opens the same long-running task in the Tasks tab
- **THEN** its detail carries the whole journal, every subtask, and every message

### Requirement: task_get journal previews are byte-bounded
Each journal entry in `task_get` SHALL carry a preview of at most its first 2,000 stored UTF-8 bytes, projected by the query and trimmed to a whole character, with its total byte length, whether it was cut, and the byte offset to resume reading from. The marker SHALL be metadata, never appended to the text. A preview that is not valid UTF-8, at any length, SHALL carry null text and resume offset 0; stored bytes are never rewritten.

#### Scenario: Oversized entry
- **WHEN** an entry holds 5,000 ASCII bytes
- **THEN** its preview is the first 2,000 bytes, marked cut, with total 5,000 and resume offset 2,000

#### Scenario: Character straddling the limit
- **WHEN** a four-byte character spans byte 2,000
- **THEN** the preview ends before it and the resume offset equals the preview length

#### Scenario: Invalid bytes in the preview
- **WHEN** the first 2,000 bytes are not valid UTF-8
- **THEN** the preview text is null and the resume offset is 0

#### Scenario: Short invalid historical entry
- **WHEN** a task holds a one-byte entry `FF` beside a valid small entry
- **THEN** the `FF` preview has null text, resume offset 0, and total 1, and is not cut
- **AND** `task_journal_read` returns that byte exactly, and the valid sibling is returned whole

### Requirement: task_get pages the journal
`task_get` SHALL accept an optional `journal_before`, an entry id of the task, and an optional integer `journal_limit` from 1 to 200 (default 50), returning the entries older than that entry by `(created_at, rowid)`, oldest first, with whether older entries remain and the next anchor. An id that is not an entry of the task SHALL be refused naming it; a limit out of range SHALL be refused.

#### Scenario: Reading older entries
- **WHEN** an agent pages from the newest window with each result's next anchor until no older entries remain
- **THEN** every entry of the unchanged journal is returned exactly once, including entries sharing a timestamp

#### Scenario: Last page
- **WHEN** `journal_before` names the 31st-oldest entry with limit 100
- **THEN** the 30 oldest entries are returned and no older entries remain

#### Scenario: Unknown or foreign entry id
- **WHEN** `journal_before` names an entry of another task or no entry
- **THEN** the call is refused naming the id, through either tool runtime

#### Scenario: Limit out of range
- **WHEN** `journal_limit` is 0, 201, or 1.5
- **THEN** the call is refused naming the range 1–200, through either tool runtime

### Requirement: task_journal_read returns any entry losslessly
A read-only `task_journal_read` tool SHALL take a task id, an entry id, and a byte offset (default 0), and return at most 8,192 stored bytes from that offset as base64, with the exact text when they are valid UTF-8 (else null), the total, and the next offset. Concatenating chunks from 0 SHALL reproduce the stored bytes, NUL and byte-order marks included. Entries SHALL never be rewritten.

#### Scenario: Reading a long entry
- **WHEN** an agent reads a 20,000-byte ASCII entry from offset 0 and follows each next offset
- **THEN** it receives chunks of at most 8,192 bytes whose concatenation equals the entry

#### Scenario: Entry with an embedded NUL
- **WHEN** an entry holds text, a NUL character, and a suffix
- **THEN** the total counts every byte and the reconstructed chunks include the suffix

#### Scenario: Chunk end inside a character
- **WHEN** a chunk would end inside a multi-byte character before the end of the entry
- **THEN** the chunk ends before that character, and the next offset starts at it

#### Scenario: Offset inside a character or invalid bytes
- **WHEN** the offset falls inside a character, or the bytes are not valid UTF-8
- **THEN** the text is null and the base64 carries at least one raw byte

#### Scenario: Offset at or past the end
- **WHEN** the offset equals the entry's byte length
- **THEN** an empty chunk is returned with no next offset
- **AND** an offset beyond it is refused naming the offset and the total

#### Scenario: Entry of another task or team
- **WHEN** the entry belongs to another task, or the task to another team
- **THEN** the call is refused as `task_get` would refuse it

### Requirement: Agents are told task_get is bounded
The `task_get` and `task_journal_read` descriptions, the system prompt's task note, and the delivered task-mail header SHALL state that `task_get` returns bounded windows with totals and byte-bounded previews, and name `journal_before`, `journal_limit`, and `task_journal_read`; none SHALL promise the full journal.

#### Scenario: Prompt names the paging
- **WHEN** an agent starts with the team prompt
- **THEN** its task note describes `task_get` as bounded and names `journal_before`, `journal_limit`, and `task_journal_read`

#### Scenario: Header stops promising the full journal
- **WHEN** task mail is delivered
- **THEN** its header names the bounded `task_get` and `task_journal_read` rather than a full journal

### Requirement: Agents without the journal reader are told to stop
The team prompt's task note SHALL tell every agent, whatever its group, that `task_get` is bounded on every call whatever a tool description says, to check the journal bounds and preview cuts, and, if `task_journal_read` is not among its tools, to stop before conclusions needing omitted entries or bytes and ask for a fresh Codex chat, never reading the journal another way. Codex SHALL get it on thread start and resume. This is guidance, not enforcement.

#### Scenario: Prompt tells every agent how to read without the reader
- **WHEN** an agent with any group, or none, starts with the team prompt
- **THEN** its task note says `task_get` is bounded on every call and names the bounds to check
- **AND** it says that without `task_journal_read` the agent stops before conclusions needing omitted entries or bytes and asks for a fresh Codex chat, and never reads the journal through the database, logs, the shell, or files

#### Scenario: A Codex thread keeps its start tools and gets the current guidance
- **WHEN** a Codex chat starts a thread and is later resumed by a restarted server
- **THEN** the start registers the current task tools, including the paged `task_get` and `task_journal_read`
- **AND** the resume registers no tools, and both pass the current team prompt with that guidance as developer instructions

### Requirement: Delivered task context stays compatible across header generations
A delivered task envelope SHALL record its task-header generation: an absent `taskHeaderVersion` is the legacy generation 1, and new task envelopes carry generation 2. Parsing SHALL rebuild the header only with the recorded generation's renderer, so task mail recorded before the bounded header still parses and its receipt stays found. An unknown or non-integer version, a version without a task, or a header not matching its version SHALL NOT parse.

#### Scenario: Task mail recorded before the bounded header
- **WHEN** a task envelope with journal entries and no version, recorded before the change, is read after it
- **THEN** it parses to its message id and peer body, and its receipt is found
- **AND** if it was pushed and not yet settled, reconciliation completes it as delivered rather than returning it to the queue

#### Scenario: Current task mail carries its generation
- **WHEN** task mail is delivered after the change
- **THEN** its metadata carries generation 2 and its header is the bounded one, and it parses back to the same message

#### Scenario: Mismatched or unknown generation
- **WHEN** an envelope's version is unknown or not an integer, is set without a task, or does not match the header it carries
- **THEN** it does not parse as delivered mail

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
