# Spec Delta

## ADDED Requirements

### Requirement: task_get subtasks are compact rows
Each subtask in `task_get` SHALL be the compact row `task_list` returns, without direction, acceptance, assignment instruction, or participants. `task_get` SHALL accept an optional `subtasks_before`, a subtask id of the task, returning the newest 100 subtasks older than it by `(created_at, rowid)`, with the next anchor. An id that is not a subtask of the task SHALL be refused naming it.

#### Scenario: Umbrella task subtasks
- **WHEN** an agent calls `task_get` on a task with 163 subtasks whose directions total 336 KB
- **THEN** the 100 newest subtasks are compact rows, no direction text appears among them, and the bounds give total 163, truncated, and a next anchor

#### Scenario: Paging subtasks to the end
- **WHEN** the agent pages with each result's subtasks anchor until none remains
- **THEN** every subtask of the unchanged task is returned exactly once, including subtasks sharing a creation time

#### Scenario: Foreign subtask anchor
- **WHEN** `subtasks_before` names a task that is not a subtask of this task
- **THEN** the call is refused naming the id, through either tool runtime

### Requirement: task_get message bodies are previews
Each message in `task_get` SHALL carry a body of at most its first 2,000 UTF-8 bytes, trimmed to a whole character, with the body's total byte length and whether it was cut. `task_get` SHALL accept an optional `messages_before`, a message id of the task, returning the newest 50 messages older than it by `(created_at, rowid)`, with the next anchor. An id that is not a message of the task SHALL be refused naming it.

#### Scenario: Long instruction mail
- **WHEN** a task message's body is 6,000 ASCII bytes
- **THEN** its body is the first 2,000 bytes, marked cut, with total 6,000

#### Scenario: Paging messages to the end
- **WHEN** an agent pages a task's 114 messages with each result's messages anchor until none remains
- **THEN** every message is returned exactly once

### Requirement: task_get returns full message bodies on request
`task_get` SHALL accept an optional boolean `full_messages`, false by default. When it is true, every message in the window SHALL carry its whole body, with its total byte length and not cut; the window, its order, and its paging are unchanged. A value that is not a boolean SHALL be refused.

#### Scenario: Default stays a preview
- **WHEN** an agent calls `task_get` without `full_messages` on a task whose message body is 6,000 ASCII bytes
- **THEN** the body is the first 2,000 bytes, marked cut

#### Scenario: Asking for full bodies
- **WHEN** the agent calls `task_get` with `full_messages` true on the same task
- **THEN** the body is all 6,000 bytes, not cut, with total 6,000, and the other sections are unchanged

#### Scenario: Full bodies while paging
- **WHEN** the agent pages with `messages_before` and `full_messages` true
- **THEN** each page holds the same messages as without it, each with its whole body

#### Scenario: Non-boolean value
- **WHEN** `full_messages` is `"yes"`
- **THEN** the call is refused, through either tool runtime

### Requirement: task_get revisions are rows
`task_get` SHALL return the newest 50 revisions as rows, oldest first: number, author, time, notify flag, the byte lengths of direction and acceptance without their text, and a rationale preview of at most 2,000 UTF-8 bytes with its byte length and cut flag. An optional `revisions_before`, a revision number of the task, SHALL return the 50 rows older than it. The list SHALL carry its total and next anchor.

#### Scenario: Eight revisions
- **WHEN** an agent calls `task_get` on a task with 8 revisions of up to 27 KB each
- **THEN** it receives 8 revision rows without text, and the current direction once, in `task`

#### Scenario: Long revision history
- **WHEN** a task has 70 revisions and the agent pages with each result's revisions anchor until none remains
- **THEN** the first read holds the newest 50 with total 70, and every revision row is returned exactly once

#### Scenario: Long rationale
- **WHEN** a revision's rationale is 5,000 ASCII bytes
- **THEN** its row carries the first 2,000 bytes, marked cut, with total 5,000

#### Scenario: Unknown revision anchor
- **WHEN** `revisions_before` is 0, 71 on a task with 70 revisions, or not an integer
- **THEN** the call is refused naming the value, through either tool runtime

### Requirement: task_get reads one revision whole
`task_get` SHALL accept an optional `revision`, an existing revision number of the task, and then also return that revision's full direction, acceptance, and rationale. A revision that does not exist SHALL be refused naming it.

#### Scenario: Reading an earlier revision
- **WHEN** the agent calls `task_get` with `revision` 3
- **THEN** the result also carries revision 3's direction, acceptance, and rationale whole

#### Scenario: Unknown revision
- **WHEN** `revision` is 9 on a task with 8 revisions, or 0
- **THEN** the call is refused naming the revision, through either tool runtime

### Requirement: task_get lists results as rows
`task_get` SHALL return the outstanding result whole, followed by the newest 50 other results as rows, newest first: id, commit, task revision, submitter, superseding result, acceptance, review verdict, submission time, and a summary preview of at most 2,000 UTF-8 bytes with its byte length and cut flag. An optional `results_before`, a non-outstanding result id of the task, SHALL return the 50 rows older than it. The rows SHALL carry their total and next anchor.

#### Scenario: Five results
- **WHEN** a task has one outstanding result and four superseded ones
- **THEN** the outstanding result is whole, the other four are rows, and their findings and maps are absent

#### Scenario: Long result history
- **WHEN** a task has one outstanding result and 70 superseded ones, and the agent pages with each result's results anchor until none remains
- **THEN** every superseded result row is returned exactly once, and the outstanding result is whole in every read

#### Scenario: Result anchor not of this task
- **WHEN** `results_before` names the outstanding result, a result of another task, or no result
- **THEN** the call is refused naming the id, through either tool runtime

### Requirement: task_get reads one result whole
`task_get` SHALL accept an optional `result_id`, a result of the task, and then return that result whole as well. In every whole result, the diff SHALL be a preview of at most 8,192 UTF-8 bytes, with its total byte length, whether it was cut, and the offset to resume reading from. The blind-first seal SHALL apply to every whole result returned.

#### Scenario: Reading a superseded result
- **WHEN** the agent calls `task_get` with the `result_id` of a superseded result
- **THEN** that result is returned whole beside the outstanding one

#### Scenario: Sealed reviewer asks for a result
- **WHEN** the reviewer holding the outstanding review handoff, with no map recorded, calls `task_get` with that result's `result_id`
- **THEN** the submitter's coverage map is withheld exactly as in the default read

#### Scenario: Large diff
- **WHEN** a result's diff is 300 KB
- **THEN** its diff is the first 8,192 bytes, marked cut, with total 307,200

#### Scenario: Result of another task
- **WHEN** `result_id` names a result of another task or no result
- **THEN** the call is refused naming the id, through either tool runtime

### Requirement: task_result_diff_read returns any diff losslessly
The `kawai-team` server SHALL offer a read-only `task_result_diff_read` tool, taking a task id, a result id of that task, and an optional `offset_bytes` (default 0). It SHALL return up to 8,192 stored bytes of the result's diff from that offset as authoritative base64, their text when exact UTF-8 (else null), the diff's total bytes, and the next offset, null at the end. It SHALL apply `task_get`'s caller and team rules.

#### Scenario: Reading a diff-only result whole
- **WHEN** a result has no commit and a 300 KB diff, and an agent reads from offset 0 with each next offset until it is null
- **THEN** the concatenated bytes equal the stored diff exactly

#### Scenario: Continuing a preview
- **WHEN** an agent reads from a whole result's diff resume offset
- **THEN** the first chunk starts at the byte after the preview

#### Scenario: Offset beyond the diff
- **WHEN** `offset_bytes` exceeds the diff's total bytes, or is negative or not an integer
- **THEN** the call is refused naming the offset, through either tool runtime

#### Scenario: Result without a diff
- **WHEN** the result has a commit and no diff
- **THEN** the tool returns total 0, no bytes, and a null next offset

#### Scenario: Foreign result
- **WHEN** the result belongs to another task, or the task to another team
- **THEN** the call is refused as not found, through either tool runtime

### Requirement: task_get assignment history is compact
`task_get` SHALL return the newest 50 assignments, publications, and acknowledgements, each list with its total and truncation. Assignment rows SHALL omit the verbatim instruction, which the current assignment keeps in `task`.

#### Scenario: Instruction appears once
- **WHEN** an agent calls `task_get` on a task with an outstanding assignment and three superseded ones
- **THEN** the current instruction appears in `task.assignment`, and no assignment history row carries an instruction

#### Scenario: Long publication history
- **WHEN** a task has 70 acknowledgements
- **THEN** the newest 50 are returned with total 70, truncated

## MODIFIED Requirements

### Requirement: task_get bounds its growing lists
The agent `task_get` tool SHALL return the newest 50 journal entries (or `journal_limit`), the newest 100 subtasks, and the newest 50 messages, oldest first, each list with its total and truncation, applying those limits in SQL before rows reach JavaScript. Apart from the current direction, acceptance, instruction, whole results apart from their diffs, and bodies asked for with `full_messages`, every section SHALL be bounded. The human's task detail SHALL NOT be bounded.

#### Scenario: Long-running task read by an agent
- **WHEN** an agent calls `task_get` on a task with 1,198 journal entries, 149 subtasks, and 60 messages
- **THEN** the result holds the newest 50 entries, 100 subtasks, and 50 messages, each oldest first
- **AND** it reports totals 1,198, 149, and 60, all three truncated

#### Scenario: Small task is whole
- **WHEN** an agent calls `task_get` on a task with 3 journal entries of at most 2,000 bytes that are valid UTF-8, no subtasks, and 1 message
- **THEN** everything is returned whole and readable, and nothing is marked truncated or cut

#### Scenario: Results and revisions stay whole
- **WHEN** a task has more than 50 results or revisions, and a review handoff is outstanding
- **THEN** `task_get` returns the outstanding result whole with the blind-first seal applied as before, the newest 50 other results and revisions as rows, and anchors that reach every older one

#### Scenario: Umbrella task fits a context
- **WHEN** an agent calls `task_get` with default arguments on a task with 1,993 journal entries, 163 subtasks, 114 messages, 8 revisions, and 5 results
- **THEN** the serialized result is under 256 KB

#### Scenario: Human detail stays complete
- **WHEN** the human opens the same long-running task in the Tasks tab
- **THEN** its detail carries the whole journal, every subtask, message, revision, and result, with full bodies, instructions, and diffs

### Requirement: Agents are told task_get is bounded
The `task_get` and `task_journal_read` descriptions, the system prompt's task note, and the delivered task-mail header SHALL state that `task_get` returns bounded windows with totals and byte-bounded previews, and name `journal_before`, `journal_limit`, and `task_journal_read`; none SHALL promise the full journal. The description and the task note SHALL also name `subtasks_before`, `messages_before`, `full_messages`, `revisions_before`, `revision`, `results_before`, `result_id`, and `task_result_diff_read`.

#### Scenario: Prompt names the paging
- **WHEN** an agent starts with the team prompt
- **THEN** its task note describes `task_get` as bounded and names `journal_before`, `journal_limit`, `task_journal_read`, `subtasks_before`, `messages_before`, `full_messages`, `revisions_before`, `revision`, `results_before`, `result_id`, and `task_result_diff_read`

#### Scenario: Header stops promising the full journal
- **WHEN** task mail is delivered
- **THEN** its header names the bounded `task_get` and `task_journal_read` rather than a full journal
