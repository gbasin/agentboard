# task-assignment Specification

## Purpose
Names who is responsible for a team task: a durable assignment record per dispatch — target group (its role) or session, initial instruction, state, and history — kept separate from participants, with human-driven dispatch that is idempotent, retryable, previewed, and routed to the task's worktree.

## Requirements

### Requirement: An assignment names who is responsible, separately from participants
Each dispatch SHALL create an assignment record: target (a group — the requested role — or a session), initial instruction, dispatcher, state, claimed agent when claimed, and supersession. Records are kept separate from the participant list; assigning SHALL NOT change it. A task SHALL have at most one outstanding assignment — the newest neither superseded nor failed; delivered work stays outstanding until superseded. A queued group assignment has a requested role and no claimed agent.

#### Scenario: Queued group assignment has no agent yet
- **WHEN** a task is assigned to a group whose members are all busy and dispatch is accepted
- **THEN** the task shows the assignment as queued with the group as its requested role and no claimed agent

#### Scenario: Owner becomes visible after claim
- **WHEN** an idle member of the assigned group takes the queued instruction
- **THEN** the assignment shows that member as the claimed agent, and the task names it as the responsible owner

#### Scenario: Assignment does not change participants
- **WHEN** a task with no prior task mail is assigned and dispatched
- **THEN** its participant list is unchanged until the instruction is delivered, while the assignment record already names the target

### Requirement: A task is created unassigned and may be dispatched on creation
The task form SHALL offer **Create task** and **Create and assign**. **Create task** stores the task with no assignment; a task remains unassigned until a dispatch is accepted. **Create and assign** stores the task, then dispatches to the chosen group or session with a non-empty instruction; an empty instruction is refused without dispatching, and when creation succeeds but dispatch is refused the task remains stored. The UI SHALL state that group assignment selects one eligible member.

#### Scenario: Create task leaves the task unassigned
- **WHEN** the human creates a task with **Create task**
- **THEN** the task exists with no assignment and no instruction is sent

#### Scenario: Create and assign dispatches one instruction
- **WHEN** the human creates a task with **Create and assign** to group `devs` with an instruction
- **THEN** the task exists, exactly one instruction message is dispatched under it, and the assignment records `devs` as the requested role

#### Scenario: Empty instruction refused
- **WHEN** dispatch is attempted with an empty instruction
- **THEN** the dispatch is refused with an error and no instruction is sent

### Requirement: Creation and dispatch are idempotent under a stable request identity
Create and dispatch requests SHALL carry a request key that identifies one user intent, unique within the team. Repeating a request with the same key and the same payload SHALL return the prior outcome and SHALL NOT create a second task or dispatch a second instruction. A request that reuses an existing key with a different payload SHALL be refused. Retrying after a reconnect or a repeated click with the same key SHALL NOT duplicate a task or an instruction.

#### Scenario: Reconnect during submission does not duplicate
- **WHEN** the connection drops while **Create and assign** is being submitted and the human resubmits the same request after reconnecting
- **THEN** the original task and the original instruction are returned and no second task or instruction exists

#### Scenario: Double click sends one instruction
- **WHEN** the dispatch button is clicked twice and both requests carry the same key
- **THEN** exactly one instruction is dispatched and the second request returns the first assignment

#### Scenario: Key reuse with a different payload is refused
- **WHEN** a dispatch request reuses an existing request key with a different target or instruction
- **THEN** the request is refused with an error and the original assignment is unchanged

### Requirement: A refused dispatch retains the task and the assignment draft
When task creation succeeds and dispatch fails, the error SHALL be shown inline, the task SHALL remain, the assignment draft (target and instruction) SHALL remain as entered, and a **Retry assignment** action SHALL dispatch the existing task without creating a new one; once creation has committed, only that dispatch-side retry is offered, never a repeated create. A refused create or dispatch SHALL never silently erase entered form input.

#### Scenario: Retry assignment reuses the existing task
- **WHEN** creation succeeded, dispatch to a group failed, and the human retries the assignment successfully
- **THEN** the original task is used, exactly one instruction is dispatched under it, and no duplicate task exists

#### Scenario: Invalid worktree refusal keeps the form
- **WHEN** creation is refused because the chosen worktree is invalid
- **THEN** the error names the worktree and every entered form field, including the assignment target and instruction, remains as entered

### Requirement: Dispatch can be previewed before sending
Before dispatch, the UI SHALL show a preview with the target worktree, the requested role, the effective profile, the approval policy, and whether staffing is available for the target. A group preview's policy SHALL be the one a spawn would get, with its source. For a session target the preview SHALL show that session's resolved worktree, profile, and policy, and SHALL warn, not block, when that worktree differs from the task's. Every constraint SHALL be revalidated at dispatch.

#### Scenario: Group preview shows staffing availability
- **WHEN** the human previews an assignment to a group for a task targeting a worktree with no idle matching member
- **THEN** the preview names the worktree, the group's role, the profile a spawned member would use, the approval policy a spawned member would get, and whether staffing can add a member

#### Scenario: Group preview shows the resolved policy and its source
- **WHEN** the team default is auto and the human previews an assignment to a group with no `approval:` key
- **THEN** the preview shows auto from the team default, the policy a member spawned by that dispatch starts with

#### Scenario: Group preview names a group key over the default
- **WHEN** the team default is auto and the group sets `approval: manual`
- **THEN** the preview shows manual from the group file

#### Scenario: Session preview shows profile and policy
- **WHEN** the human previews an assignment to a specific session
- **THEN** the preview shows that session's resolved worktree, effective profile, and approval policy

#### Scenario: Worktree mismatch is warned, not blocked
- **WHEN** the previewed session's resolved worktree differs from the task's target worktree
- **THEN** the preview shows a warning naming both worktrees, and dispatch remains available

### Requirement: Reassignment is an explicit handoff
Task detail SHALL offer **Assign / send task**. A new dispatch onto an outstanding assignment SHALL show it and require the human to choose **notify** or **stop**. **Stop** supersedes it and cancels its instruction only while it is queued or waiting on a pending request; it never stops or archives the previous recipient nor undoes delivered work. **Notify** supersedes it and sends the previous claimed agent, if any, a normal-priority direct note. Superseded assignments remain in history.

#### Scenario: Reassignment requires an explicit choice
- **WHEN** the human dispatches a new assignment while the task has an outstanding assignment
- **THEN** dispatch waits until the human chooses **notify** or **stop**, showing the outstanding assignment's target and state

#### Scenario: Stop cancels only an undelivered instruction
- **WHEN** the human reassigns and chooses **stop** while the outstanding instruction is still queued
- **THEN** the queued instruction is cancelled, the old assignment is superseded, and no recipient is interrupted

#### Scenario: Delivered work is not auto-cancelled
- **WHEN** the human reassigns and chooses **stop** after the outstanding instruction was delivered
- **THEN** the old assignment is superseded, the previous recipient's session keeps running, and its delivered work is untouched

#### Scenario: Notify sends the previous assignee a note
- **WHEN** the human reassigns and chooses **notify** and the outstanding assignment has a claimed agent
- **THEN** that agent receives a direct message naming the reassignment, and the old assignment is superseded

#### Scenario: Superseded assignment remains in history
- **WHEN** a task has been reassigned
- **THEN** the earlier assignment remains viewable in the assignment history, marked superseded, alongside the new outstanding one

### Requirement: Dispatched instructions follow worktree routing
A group assignment whose task targets a worktree SHALL reach only members whose current worktree resolves to that worktree; a member elsewhere SHALL NOT take it. When no eligible member exists, staffing MAY spawn a member in that worktree under the existing staffing caps, and that member receives the instruction as its first turn. Dispatching SHALL NOT create a worktree.

#### Scenario: Parallel subtasks reach only matching recipients
- **WHEN** API and UI subtasks target two different linked worktrees and each is assigned to the developer group
- **THEN** each instruction reaches only a member resolved in its own target worktree, and the parent task lists both children

#### Scenario: Idle main-checkout developer is skipped
- **WHEN** a worktree-targeted group instruction is queued and an idle group member is resolved in the main checkout
- **THEN** that member does not take the instruction

#### Scenario: No worktree is created by dispatch
- **WHEN** a group assignment targets a worktree with no eligible member and staffing caps do not allow a spawn
- **THEN** the instruction waits, and no worktree is created

### Requirement: Worktrees and changes are chosen from team-scoped searchable lists
The task form's worktree and OpenSpec-change fields SHALL be searchable pickers listing the team repository's worktrees (path and branch) and valid changes (name and location), scoped to the team — another team's entries never appear. Advanced manual entry SHALL remain available under the same server validation. The picker SHALL link to the existing worktree-creation flow and refresh after a worktree is created there; worktree creation stays a separate deliberate action.

#### Scenario: Worktree picker lists paths and branches
- **WHEN** the human opens the worktree picker
- **THEN** each of the team repository's worktrees is listed with its path and its checked-out branch, and typing filters the list

#### Scenario: Change picker lists names and locations
- **WHEN** the human opens the OpenSpec-change picker
- **THEN** each valid active change of the team is listed with its name and where it lives, and typing filters the list

#### Scenario: Manual entry is validated identically
- **WHEN** the human types a worktree path or change name instead of choosing from the list
- **THEN** the same server validation accepts or refuses it as the picker choice would

#### Scenario: Create-worktree link returns to the form
- **WHEN** the human follows the picker's create-worktree link, creates a worktree there, and returns
- **THEN** the picker's refreshed list contains the new worktree and the form's other entries are retained

### Requirement: Assignments persist and remain visible
Assignment records and their history SHALL persist across server restart and SHALL remain after any participating session is archived or killed. Task detail SHALL show the current assignment — target, requested role, state, claimed agent when claimed — and the assignment history. Task list rows SHALL show the assignment's target and state. An instruction that settles without delivery SHALL mark its assignment failed with the reason visible.

#### Scenario: Restart preserves assignments
- **WHEN** the server restarts after a task was assigned and its instruction delivered
- **THEN** the assignment, its claimed agent, and its history are unchanged

#### Scenario: Killed assignee preserves the record
- **WHEN** the claimed agent's session is killed
- **THEN** the assignment record remains with its claimed agent named, and the human can reassign

#### Scenario: Failed instruction marks the assignment
- **WHEN** an instruction is dead-lettered without delivery
- **THEN** its assignment shows failed with the reason, and the task can be reassigned

#### Scenario: Task rows show the assignee
- **WHEN** a task list is shown
- **THEN** each row shows its assignment's target and state, or that the task is unassigned

### Requirement: Kawai dispatches plan-execution assignments
A plan execution SHALL dispatch its instructions and handoffs through task assignment with Kawai as the dispatcher. The assignment row and its mail SHALL commit in one transaction, under a request key derived from the execution, the change, and the step. A replayed step SHALL return the prior assignment and never dispatch twice.

#### Scenario: Kawai's assignment names its dispatcher
- **WHEN** Kawai dispatches a change's implement attempt
- **THEN** the task's assignment names Kawai as dispatcher and the implementing group as target, and its state follows the instruction mail like any assignment

#### Scenario: A replayed step dispatches once
- **WHEN** the executor runs the same dispatch step again after a restart
- **THEN** one assignment and one instruction exist for that step

### Requirement: Only Kawai dispatches a running change's task
While a running execution owns a change, a dispatch onto its task by the human or an agent, including reassignment, SHALL be refused naming the execution, with guidance to close the task or stop the execution, and SHALL write nothing. Kawai's own next stage SHALL supersede its earlier one as handoffs do.

#### Scenario: Human reassignment refused
- **WHEN** the human chooses **Assign / send task** on the task of a change a running execution owns
- **THEN** the dispatch is refused naming the execution, with the guidance, and nothing is written

#### Scenario: Kawai's next stage supersedes the review
- **WHEN** Kawai dispatches a fix handoff after a failed review
- **THEN** the review assignment is superseded, and its instruction is cancelled only while still queued or awaiting a request

### Requirement: Human dispatch can name a worker
**Create and assign** and **Assign / send task** SHALL offer an optional worker when the target is a group. The picker SHALL list the group's workers grouped by provider, each with its provider's usage and cooldown. The choice SHALL be stored on the assignment, carried by its instruction mail, and part of the request key's payload identity.

#### Scenario: Assign on a chosen provider
- **WHEN** the human assigns a task to `middle-devs` with worker `claude`
- **THEN** the assignment records the choice and its instruction can be taken only by a `claude` worker of the group

#### Scenario: Replay with a different worker
- **WHEN** a dispatch is resent with the same request key and a different worker
- **THEN** it is refused naming `worker` as the differing field

#### Scenario: Session target
- **WHEN** the target is a session
- **THEN** no worker picker is offered

### Requirement: The dispatch preview reflects the worker choice
The read-only dispatch preview SHALL state the chosen worker and its provider's cooldown. Its effective profile and staffing availability SHALL be computed with the choice applied. The preview SHALL warn, never block, when the chosen provider is cooling.

#### Scenario: Cooling choice in the preview
- **WHEN** the human previews a dispatch whose chosen provider is cooling
- **THEN** the preview warns that the instruction will wait until the cooldown end, and the dispatch stays allowed
