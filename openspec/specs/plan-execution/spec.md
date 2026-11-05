# plan-execution Specification

## Purpose
Lets the owner start an approved plan revision and have Kawai deliver it. Kawai schedules each change by its dependencies and provisions its worktree. It dispatches the work as Kawai-owned tasks with recorded attempts and gates every result on the check floor, a clean review, and the plan's extra checks. A change that fails three consecutive fix rounds stops, independent work continues, and the plan completes when every change has landed.

## Requirements

### Requirement: Only the human starts an execution
The human SHALL be able to start an execution of an open plan's current approved revision, naming the revision and its content hash under a command id. A retry with the same command id and payload SHALL return the prior execution, and the same command id with a different payload SHALL be refused naming the differing field. No agent tool SHALL start, stop, or retry an execution, and the service SHALL refuse an agent caller on those paths.

#### Scenario: A lost Start result replays
- **WHEN** the human's Start succeeds, its result is lost, and the dialog resends it under the same command id
- **THEN** the same execution is returned and no second execution, task, or mail exists

#### Scenario: No agent can start
- **WHEN** an agent looks for a tool to start, stop, or retry an execution, or calls the service path directly
- **THEN** no such tool exists and the direct call is refused with nothing written

### Requirement: Start evaluates named preconditions
Start SHALL evaluate an ordered list of named preconditions: `plan-open`, `revision-current`, `validation-current`, `start-conditions-resolved`, `strategy-impact`, `one-execution`, `changes-unclaimed`, `changes-on-base`, `roles-routable`, `landing-ready`, and `landing-mode-supported`. Every entry SHALL run. Any failure SHALL refuse Start, naming every failing entry with its message, and SHALL write nothing. Later capabilities MAY append entries but SHALL NOT change shipped ones.

#### Scenario: Every failing precondition is named
- **WHEN** the human starts a revision whose report is out of date while another plan's running execution owns one of its changes
- **THEN** Start is refused naming both `validation-current` and `changes-unclaimed`, and no execution exists

#### Scenario: A superseded revision cannot start
- **WHEN** the human starts revision 2 after revision 3 was approved
- **THEN** Start is refused as `revision-current`, naming revision 3 as the current approved revision

#### Scenario: A stale strategy pin cannot start
- **WHEN** the revision's strategy impact gate is in the decision-required state
- **THEN** Start is refused as `strategy-impact`, naming that state

### Requirement: Start rests on a current validation report
Start SHALL read the file-held validation inputs just before its transaction. Inside it, Start SHALL compare the newest report's input hash with the inputs recomputed then, using the same comparison as plan approval. A missing, unready, or out-of-date report SHALL refuse Start, naming what changed or what still blocks. Every carried `start` condition SHALL be resolved. The execution SHALL record the report and input hash it rested on.

#### Scenario: A change edited after validation refuses Start (R06)
- **WHEN** a change's design is edited after its ready report and the human starts the revision
- **THEN** Start is refused as `validation-current`, naming that change's artifacts, until the revision is validated again

#### Scenario: A start condition must be resolved
- **WHEN** the effective alignment assessment carries an unresolved `start` condition
- **THEN** Start is refused as `start-conditions-resolved`, quoting the condition

### Requirement: Changes start from artifacts on the base branch
Start SHALL be refused as `changes-on-base` when an unlanded change's artifacts, or a base spec its deltas touch, differ between the validated files and the base branch's head on `origin`, naming the change and each differing file. Kawai SHALL NOT copy or commit artifacts into a change's worktree.

#### Scenario: A proposal that was never pushed
- **WHEN** a change's artifacts exist in the main checkout but not on the base branch on `origin`
- **THEN** Start is refused as `changes-on-base`, naming the change and its files

#### Scenario: The base branch changed after validation
- **WHEN** the change's design on `origin`'s base branch was edited after the report, while the main checkout still holds the validated copy
- **THEN** Start is refused as `changes-on-base`, naming that design file

### Requirement: An execution owns its changes exclusively
At most one execution of a plan SHALL be running, and two racing Starts SHALL leave exactly one. A running execution SHALL own the unlanded changes of its revision. Start SHALL be refused as `changes-unclaimed` while another plan's running execution owns one of the plan's unlanded changes, naming that change and plan.

#### Scenario: Racing Starts
- **WHEN** two Start commands with different command ids for the same revision commit at the same time
- **THEN** one execution is running and the other command is refused as `one-execution`

#### Scenario: Another plan's execution owns a change
- **WHEN** plan A's execution runs with change `x` unlanded and the human starts plan B, which also names `x`
- **THEN** B's Start is refused as `changes-unclaimed`, naming `x` and plan A

### Requirement: Roles must be routable at Start
Start SHALL be refused as `roles-routable`, naming the group or role, when a change's implementing group's current file sets `worktreeScoped: false`, or when a role names no profile that its group's current file allows. A review group MAY be unscoped.

#### Scenario: An unscoped implementing group
- **WHEN** a plan's change names an implementing group whose file sets `worktreeScoped: false`
- **THEN** Start is refused as `roles-routable`, naming the group

#### Scenario: A role with no allowed profile
- **WHEN** a role lists only profile `opus` for a group whose file allows `glm` and `sonnet`
- **THEN** Start is refused as `roles-routable`, naming the role, the group, and the profiles each allows

### Requirement: An execution records what it started from
An execution SHALL record its inputs at Start, and they SHALL never change afterwards:
- the plan, the revision, and the content hash;
- the validation report and input hash;
- the base branch and its commit;
- the floor checks with their CI mapping and the floor version;
- the landing mode, the parallel limit, and the merge method;
- who started it, and when.

A later edit of the team's settings SHALL apply only to later executions.

#### Scenario: Settings edited during an execution
- **WHEN** the operator changes the team's parallel limit while an execution runs
- **THEN** the running execution keeps the limit it recorded and the next execution uses the new one

#### Scenario: The base branch moves on
- **WHEN** the base branch advances after Start and a change is provisioned later
- **THEN** the execution's recorded base commit is unchanged, and the change records the base branch's commit at its provisioning as its baseline

### Requirement: Changes are scheduled once their dependencies have landed
The execution SHALL schedule a change, in plan order, only once each of its dependencies has a landing fact for the plan. At most the parallel limit (default 3) of its changes SHALL be in progress: scheduled and not yet landed, stopped, or cancelled. A change landed by an earlier execution of the plan SHALL count as landed and SHALL NOT run again. A stopped dependency SHALL keep its dependents waiting while independent changes proceed.

#### Scenario: A dependent waits for the landing
- **WHEN** change B depends on change A and A's review has passed but A has not yet merged
- **THEN** B stays waiting on A, and is scheduled after A's landing fact is recorded

#### Scenario: The parallel limit holds back ready changes
- **WHEN** four changes have no dependencies and the execution's parallel limit is 3
- **THEN** the first three in plan order are scheduled, and the fourth shows it waits for a free slot

#### Scenario: Landed work is not redone
- **WHEN** the owner starts a new execution of a plan whose earlier execution landed two of its five changes
- **THEN** those two changes show as landed and only the other three are scheduled

#### Scenario: Independent work continues past a stop
- **WHEN** change A stops after three failed fix rounds, B depends on A, and C depends on nothing
- **THEN** B keeps waiting on A and C runs to its landing

### Requirement: Provisioning is an explicit execution step
For a scheduled change, the execution SHALL create the worktree `.worktrees/<change>` in the main checkout on a new branch `<change>` from the base branch's commit at that moment, recorded as the change's baseline. It SHALL reuse a worktree and branch that an earlier execution of the plan created. Any other worktree or branch with that name, locally or on `origin`, SHALL stop the change as `name-taken`. No message SHALL cause a worktree to be created.

#### Scenario: A foreign branch is never taken over
- **WHEN** a branch named like the change exists that no execution of the plan created
- **THEN** the change stops as `name-taken`, naming the branch, and the branch is left untouched

#### Scenario: A later execution reuses the worktree
- **WHEN** the owner starts a new execution after an earlier one of the plan stopped with a change half done
- **THEN** that change reuses its worktree and branch at their current head, and its first attempt's manifest records that head as its starting commit

### Requirement: Kawai creates and dispatches one task per change
After provisioning, the execution SHALL create one task for the change. Its creator SHALL be Kawai. The task SHALL be linked to the plan change, target the worktree, name the OpenSpec change, and carry the change's guidance and acceptance rules. Kawai SHALL then dispatch it to the change's implementing group. The instruction SHALL name the change, branch, and plan revision, ask for a committed result through the result tool, and say that Kawai pushes.

#### Scenario: The implementer receives Kawai's instruction
- **WHEN** a change is provisioned
- **THEN** its task exists with Kawai as creator and one assignment dispatched by Kawai, and a member of the implementing group in that worktree receives the instruction

#### Scenario: A later execution creates fresh tasks
- **WHEN** the owner starts a new execution after stopping one
- **THEN** each unlanded change gets a new task created by Kawai, and the stopped execution's cancelled tasks stay as they were

### Requirement: A failed instruction stops the change
When an instruction Kawai dispatched for a change fails (its mail dead-lettered, cancelled, or discarded), or a service refuses to dispatch it, the change SHALL stop as `instruction-failed`, naming the instruction or stage and the reason. Kawai SHALL NOT dispatch a replacement on its own. An instruction Kawai itself superseded with a later stage SHALL NOT count as failed.

#### Scenario: The human cancels Kawai's instruction
- **WHEN** the human cancels a queued fix instruction in the Mailbox
- **THEN** the change stops as `instruction-failed`, naming that instruction and the cancellation, and no other instruction is dispatched for it

#### Scenario: Kawai supersedes a queued stage
- **WHEN** the human publishes a new task revision while the change's review handoff is still queued
- **THEN** Kawai's fix attempt supersedes the review handoff and its mail is cancelled, and the change does not stop

#### Scenario: The worktree disappears under queued mail
- **WHEN** the change's worktree is removed by hand while its fix instruction is queued
- **THEN** the mail is dead-lettered `worktree-missing` and the change stops as `instruction-failed`, naming that reason

#### Scenario: A refused dispatch is contained
- **WHEN** the task, assignment, or result service refuses a stage's dispatch, for example because the change's group file was removed after Start
- **THEN** the change stops as `instruction-failed`, naming the stage and the refusal, the server keeps running and its other executions keep advancing, and Retry dispatches that stage again

### Requirement: Every dispatch is an attempt with an immutable manifest
Each implementer dispatch SHALL record an attempt with its number, its kind (implement, fix, or update), and its assignment. It SHALL also record an immutable input manifest naming:
- the plan revision and hash, and the execution;
- the task revision;
- the report and input hash;
- the commit it starts from, and the change's artifact digests;
- for fix and update attempts, the result and findings it answers.

The manifest SHALL stay readable after the worktree is removed.

#### Scenario: A fix attempt names what it answers
- **WHEN** a round fails and a fix attempt is dispatched
- **THEN** the attempt's manifest names the failed result, the findings and failing checks it answers, and the branch head it continues from

#### Scenario: The manifest outlives the worktree
- **WHEN** a change lands and its worktree is removed
- **THEN** each of its attempts and manifests is still readable in plan detail and through `plan_get`

### Requirement: Each result is gated as one round
Each result an attempt produces SHALL be gated as one round: Kawai pushes its commit to the change's branch, opens or reuses the change's pull request, and waits for CI on that commit. The round SHALL pass only when CI passes, the review passes on that exact result, and every extra check is satisfied. A newer result SHALL supersede the current round, which then neither passes nor fails. A pass SHALL never transfer to another commit except through a clean base merge.

#### Scenario: Kawai pushes, not the implementer
- **WHEN** an implementer submits a result at commit C
- **THEN** Kawai pushes C to the change's branch on `origin`, opens the change's pull request if none is open, and the round names C and the pull request

#### Scenario: A newer result supersedes the round
- **WHEN** the implementer submits a result at commit B while the round for commit A awaits review
- **THEN** A's round shows as superseded, a verdict on A no longer counts, and B is gated as a new round with its own CI and review

### Requirement: A new task revision returns the change for re-evaluation
When the human publishes a new revision of a running change's task before its merge starts, the current round SHALL be superseded, and, after any in-flight branch update settles, Kawai SHALL dispatch a fix attempt naming that revision. A change that was landing SHALL leave the landing slot, and the fix attempt's result SHALL be accepted and gated. A result pinned to an older task revision SHALL NOT pass a round.

#### Scenario: Direction changed during review
- **WHEN** the human publishes revision 3 of a change's task while the round for a result pinned to revision 2 awaits review
- **THEN** the round is superseded, a verdict on it no longer counts, and a fix attempt naming revision 3 is dispatched

#### Scenario: Direction changed while landing
- **WHEN** the human publishes a new task revision while the change holds the landing slot and waits for CI on its base merge
- **THEN** the round is superseded, the change leaves the landing slot, and the fix attempt's result is gated as a new round

#### Scenario: Direction changed while Kawai updates the branch
- **WHEN** the human publishes a new task revision while GitHub merges the base into the change's branch, and that update conflicts
- **THEN** once the update settles, one fix attempt is dispatched, naming the revision, the base head, and the conflicting files, and no update attempt is dispatched

#### Scenario: Direction changed while implementing
- **WHEN** the human publishes a new task revision while the implementer is still working and no round is gating
- **THEN** no attempt is dispatched, the implementer receives the revision notice, and its next result pins the new revision

### Requirement: CI passes only with every check green and the floor covered
CI for a round SHALL pass only when every check reported for the commit has passed, ended neutral, or been skipped, and each floor check run in CI (lint, typecheck, unit tests, and CI end-to-end) is covered by a reported check named in the team's mapping. A pending check SHALL keep the round waiting. Any other conclusion SHALL fail the round unless the flaky rule clears it.

#### Scenario: A docs-only change skips end-to-end
- **WHEN** the repository's workflow skips its mapped end-to-end check for a docs-only commit and every other check passes
- **THEN** CI passes and the skipped check is shown as skipped

#### Scenario: Every reported check counts
- **WHEN** every mapped floor check passes but another reported check fails, and fails again when rerun
- **THEN** the round fails, naming that check

### Requirement: A check that passes on its one rerun is flaky for that round
When a round's CI has failed checks, Kawai SHALL rerun the failed checks once on the same commit. Checks that then pass SHALL be recorded as flaky for that round, with both outcomes, and SHALL NOT fail the round. Flaky SHALL describe the round's evidence, not the check. A check that fails again SHALL fail the round. A round SHALL get at most one rerun.

#### Scenario: A flaky test does not cost a round
- **WHEN** the unit-test check fails, and passes when rerun on the same commit
- **THEN** the round continues to review, and the check is shown as flaky with both runs

#### Scenario: A second failure fails the round
- **WHEN** the end-to-end check fails, and fails again when rerun
- **THEN** the round fails with both runs of the check shown, and no further rerun is requested

### Requirement: The review follows green CI
Once a round's CI passes, Kawai SHALL hand the result to the change's review group as a review handoff. The handoff SHALL name the result, commit, pull request, acceptance rules, and the extra checks to attest, and SHALL ask for a verdict on that result through the findings tool.

#### Scenario: The review names what to check
- **WHEN** a round's CI passes
- **THEN** the review group receives a handoff naming the result, its commit, the pull request, the acceptance rules, and the extra checks to attest

#### Scenario: Changes requested fail the round
- **WHEN** the review handoff's claimant submits a `fail` verdict on the result
- **THEN** the round fails and its findings go into the fix attempt's instruction

### Requirement: Only an independent claimant's verdict counts
Only a `pass` verdict on the round's result from the review handoff's claimant SHALL satisfy the review, and only if the claimant authored none of the change's results in the execution. Other findings SHALL be recorded but SHALL NOT count. When the claimant, following forwards, is such an author, the change SHALL stop as `review-unavailable` as soon as the claim is known, before any findings, naming the claimant.

#### Scenario: The author cannot pass its own work
- **WHEN** a session that submitted one of the change's results, and is not the review handoff's claimant, submits a `pass` verdict on the round's result
- **THEN** the verdict is recorded and the round still waits for the review handoff's claimant

#### Scenario: An author claims the review
- **WHEN** a session that submitted one of the change's results claims the review handoff, before it submits any findings
- **THEN** the change stops as `review-unavailable`, naming that session, and Retry dispatches the review again

### Requirement: A worktree-scoped review group gets the worktree
When the change's review group is worktree-scoped, Kawai SHALL release the worktree's live spawned members before dispatching the review handoff. It SHALL use member release's readiness rules, never killing anyone, and SHALL wait while a member is not ready. Human-created sessions SHALL never be released, and an unscoped review group SHALL leave the implementer in place.

#### Scenario: A finished reviewer gives the worktree back
- **WHEN** a change is back with its implementer after a review, and a spawned member of its worktree-scoped review group is live in the worktree
- **THEN** that member is released once it is ready, so the implementer's instruction is not left waiting for the worktree, and nobody is killed

#### Scenario: Unscoped reviewers leave the implementer working
- **WHEN** a round's CI passes and the review group sets `worktreeScoped: false`
- **THEN** the review handoff is dispatched and the implementer stays live in its worktree

#### Scenario: A busy implementer delays the review
- **WHEN** a round's CI passes, the review group is worktree-scoped, and the implementer awaits an approval
- **THEN** the review handoff waits, the change shows it waits for that member's release with the reason, and nobody is killed

### Requirement: Extra checks are decided by CI or attested in review
An extra check whose name matches a check reported for the round's commit SHALL be decided by that check under the CI rules. Every other extra check SHALL be listed in the review handoff with its description and command, and SHALL be satisfied by the review's `pass`. It SHALL be shown as attested by the reviewer. Kawai SHALL NOT run extra-check commands itself.

#### Scenario: An extra check without a CI job
- **WHEN** a plan adds an extra check that no CI check reports, and the reviewer passes the result
- **THEN** the check is shown as attested by that reviewer, not as verified by CI

#### Scenario: An extra check with a CI job
- **WHEN** a plan's extra check `bundle-size` is reported by CI for the round's commit and passes
- **THEN** the check is shown as verified by CI and is not listed for the reviewer to attest

### Requirement: A failed round returns the change for fixes
When a round fails, Kawai SHALL dispatch a fix attempt to the change's implementing group as a handoff. The handoff SHALL carry the failing checks with their links, the review findings, the fix-round count, and the branch head to continue from. A round whose attempt is a fix or update attempt SHALL be a fix round.

#### Scenario: The fix instruction carries the failure
- **WHEN** a round fails on the end-to-end check
- **THEN** the implementing group receives a fix handoff naming the check, its link, and the commit to continue from

#### Scenario: Failed CI skips the review
- **WHEN** a round's CI fails after its rerun
- **THEN** no review handoff is dispatched for that result, and the fix handoff goes to the implementing group

### Requirement: Three consecutive failed fix rounds stop the change
When three consecutive fix rounds of a change fail, the change SHALL stop as `round-limit` with its last evidence, and no further attempt SHALL be dispatched for it. The first implementation round SHALL NOT count as a fix round. A passing round SHALL reset the count, and flaky checks SHALL NOT fail a round. The rest of the execution SHALL continue.

#### Scenario: The third failed fix round stops
- **WHEN** a change's implementation round fails and its next three fix rounds also fail
- **THEN** the change shows as stopped after three failed fix rounds, with the last round's evidence, and no fourth fix is dispatched

#### Scenario: A passing round resets the count
- **WHEN** two fix rounds fail, the next round passes, and the landing's update attempt then fails its round
- **THEN** the change shows one failed fix round of three and gets another fix attempt

### Requirement: The owner retries a stopped change
The human SHALL be able to retry a stopped change of a running execution under a command id, which replays like Start's. Retry SHALL be refused while the change has a task and that task is closed. A retried change SHALL wait for a slot under the parallel limit.

#### Scenario: Retry needs an open task
- **WHEN** the human retries a change whose task they cancelled
- **THEN** Retry is refused naming the closed task, and once the task is reopened, Retry dispatches the stage's instruction again

#### Scenario: Retry before a task exists
- **WHEN** the human retries a change that stopped as `name-taken` after the foreign branch was removed
- **THEN** Retry is accepted, the names are checked again, and the change is provisioned

### Requirement: Retry runs again the stage the change stopped in
Retry SHALL run the stage of the change's stop reason:
- `round-limit`: a fix attempt, with a new fix-round count;
- `instruction-failed` and `task-closed`: that stage's instruction;
- `review-unavailable`: the review handoff;
- `name-taken`: the name check, then provisioning;
- `effect-failed` and `pr-closed`: the effect;
- `effect-unknown`: the effect's inspection first;
- `ci-missing` and `ci-timeout`: CI, with new timeouts.

#### Scenario: Retry after the round limit
- **WHEN** the human retries a change stopped after three failed fix rounds
- **THEN** a fix attempt is dispatched, its fix-round count starts again at one, and the retry is recorded with the owner as actor

#### Scenario: Retry after an unknown outcome
- **WHEN** the human retries a change stopped as `effect-unknown` on its merge
- **THEN** Kawai inspects the pull request first, and records the landing if the merge had completed instead of merging again

### Requirement: The owner stops an execution
The human SHALL be able to stop a running execution with a reason under a command id. Nothing more SHALL be scheduled or dispatched for it, and no new effect SHALL start; a running effect SHALL settle and be recorded. Kawai SHALL cancel the execution's unlanded tasks, withdrawing their undelivered instructions and releasing their spawned members. Worktrees, branches, pull requests, results, and landing facts SHALL be kept. Closing the plan SHALL stop its execution the same way.

#### Scenario: Stopping keeps the work
- **WHEN** the human stops an execution while one change is gating and another is waiting
- **THEN** both tasks are cancelled, the gating change's branch and pull request stay as they were, and nothing is merged

#### Scenario: Stop during a merge
- **WHEN** the human stops the execution while a change's merge is running
- **THEN** the merge's outcome is recorded, a completed merge as that change's landing fact with its task accepted, and no later effect starts

### Requirement: Closing an execution task by hand stops its change
When the human closes a task that an execution created, the execution SHALL stop that change as `task-closed`. It SHALL NOT create a replacement task. Retry SHALL resume the change once the human reopens the task.

#### Scenario: The owner cancels one change's task
- **WHEN** the human cancels the task of a running change
- **THEN** that change shows as stopped because its task was closed, and the execution's other changes continue

#### Scenario: Accepting by hand closes without landing
- **WHEN** a human accept of a change's result reaches the server before its review passed
- **THEN** the task is done, the change stops as `task-closed`, and nothing is merged

#### Scenario: The task view does not offer closing as done
- **WHEN** the human views a task a running execution owns
- **THEN** the view offers neither Accept result nor Mark done, says Kawai accepts the task when the change lands, and still offers Mark cancelled

#### Scenario: A hand close while the merge runs
- **WHEN** the human accepts or cancels a change's task while its merge runs
- **THEN** a merge that completes is recorded with its landing fact and the change lands, leaving the task as the human closed it; a merge that fails stops the change as `task-closed` with nothing merged

### Requirement: An execution completes when its changes have landed
When every change of the execution's revision has a landing fact, the execution SHALL finish as completed. If that revision is still the plan's current approved revision, Kawai SHALL complete the plan as the system, with an event naming the execution. Otherwise the plan SHALL stay open.

#### Scenario: The last landing completes the plan
- **WHEN** the last change of an execution lands and its revision is still approved
- **THEN** the execution is completed, and the plan is completed by the system with an event naming the execution

#### Scenario: A newer approved revision keeps the plan open
- **WHEN** an execution's last change lands after the owner approved a later revision of the plan
- **THEN** the execution is completed and the plan stays open

### Requirement: A running execution keeps its revision
Approving another revision of the plan SHALL NOT change a running execution. It SHALL keep its revision, manifests, tasks, and instructions. A newer revision SHALL run only in a new execution, started after the running one finishes or is stopped, and that execution SHALL skip changes that have already landed.

#### Scenario: Approval during an execution
- **WHEN** the owner approves revision 4 while an execution of revision 3 runs
- **THEN** the execution continues on revision 3, and Start for revision 4 is refused as `one-execution` until it finishes or is stopped

#### Scenario: Later instructions keep the revision
- **WHEN** revision 4 is approved while a change of revision 3's execution awaits review, and the review fails
- **THEN** the fix attempt's instruction and manifest still name revision 3

### Requirement: Execution state survives restart
Executions, change states, attempts, rounds, effects, and landing facts SHALL be durable. After a restart, Kawai SHALL resume each running execution from its stored state. Before repeating any effect whose outcome was not recorded, it SHALL inspect that effect. No attempt SHALL be dispatched twice.

#### Scenario: Restart while CI runs
- **WHEN** the server restarts while a change waits for CI on its pushed commit
- **THEN** after the restart the change still waits for that commit's CI, with no new push, pull request, or dispatch

#### Scenario: Restart after a dispatch
- **WHEN** the server restarts right after a fix attempt was recorded
- **THEN** the attempt's instruction is delivered once, and no second attempt exists for that round

### Requirement: Progress of an executed plan reads landing facts
For a plan with any execution, a change with a landing fact SHALL show as landed. Any other change SHALL show its state in the newest execution: waiting (with what it waits on), provisioning, implementing, gating, landing, or stopped (with its reason). This replaces the linked-task proxy.

#### Scenario: Done tasks are not landed
- **WHEN** a change's task is done but the change has no landing fact
- **THEN** the change does not show as landed

#### Scenario: A stopped change shows its reason
- **WHEN** a change stopped because an effect's outcome could not be decided
- **THEN** plan progress shows it stopped as `effect-unknown`, naming that effect

### Requirement: The Plans view offers Start with its preconditions
Plan detail SHALL offer **Start execution** on the current approved revision while no execution of the plan runs. Its dialog SHALL show each precondition's standing, the landing mode and base branch, the floor checks with their CI mapping, the parallel limit, and each role's effective profiles. It SHALL mint one command id when it opens, and a refusal SHALL show inline with every failing precondition.

#### Scenario: Start refused in the dialog
- **WHEN** the human confirms Start and `landing-ready` fails because `gh` is not authenticated
- **THEN** the dialog shows the refusal naming `landing-ready` and its message, and no execution exists

#### Scenario: Start only on the current approved revision
- **WHEN** a plan has an approved revision and no running execution
- **THEN** **Start execution** is offered on that revision, and on no in-review, superseded, or withdrawn revision

### Requirement: The Plans view shows each change's execution state
For each execution, plan detail SHALL show its state, starter, revision, and start time, and one row per change. Each row SHALL show:
- the change's state and what it waits on;
- its task, branch, and pull request;
- the current instruction's state and holder;
- its attempt and fix-round counts;
- CI checks with flaky marks;
- the review verdict and reviewer;
- each extra check with how it was satisfied;
- the landing fact.

It SHALL update as the execution changes.

#### Scenario: Waiting is explained
- **WHEN** a change waits for its dependency to land
- **THEN** its row says it waits on that dependency, not that it is idle or stuck

#### Scenario: Flaky and attested evidence is labeled
- **WHEN** a round passed with a flaky unit-test check and a reviewer-attested extra check
- **THEN** the row marks the check flaky with both runs, and labels the extra check as attested by the named reviewer

### Requirement: The owner retries and stops from the Plans view
Plan detail SHALL offer **Retry** on each stopped change of a running execution, and **Stop execution**, which asks for a reason. Each command SHALL carry a command id minted when its dialog opens. Every control SHALL disable while disconnected, and refusals SHALL show inline.

#### Scenario: Disconnected controls
- **WHEN** the connection drops while plan detail shows a running execution
- **THEN** Retry and Stop execution are disabled until the connection returns

#### Scenario: Stop states what it cancels and keeps
- **WHEN** the human chooses **Stop execution**
- **THEN** the dialog lists the tasks it cancels and the worktrees, branches, and pull requests it keeps, and confirms only with a reason

### Requirement: Agents read executions but cannot control them
`plan_get` SHALL include the plan's executions with their change states, attempts, rounds, and landing facts. The system prompt's plan note SHALL explain how Kawai's execution tasks work:
- results go through `task_submit_result` and findings through `task_submit_findings`;
- Kawai pushes and merges, and agents do not push the change's branch;
- replies to Kawai's mail are refused.

#### Scenario: The Lead follows an execution
- **WHEN** the Lead calls `plan_get` for a plan with a running execution
- **THEN** the result lists each change's state, its current attempt, and the latest round's evidence

#### Scenario: Implementers are told how results land
- **WHEN** a member receives an instruction from Kawai
- **THEN** its plan note tells it to submit with `task_submit_result` and not to push the change's branch, and a reply to that mail is refused with the same guidance

### Requirement: Execution settings are user-level
Each team's `planExecution` settings SHALL live only in the user-level `~/.kawai/teams.json`, and project files SHALL NOT set them. They SHALL map each floor check run in CI to CI check names, and SHALL set the parallel limit (default 3) and the merge method (default merge commit). A malformed value SHALL be logged and its default used. A floor check without a mapping SHALL refuse Start as `landing-ready`.

#### Scenario: Missing end-to-end mapping
- **WHEN** the team's mapping names CI checks for lint, typecheck, and unit tests but none for CI end-to-end
- **THEN** Start is refused as `landing-ready`, naming the unmapped floor check

#### Scenario: A malformed value falls back to its default
- **WHEN** the team's `maxParallelChanges` is the string `"three"`
- **THEN** the problem is logged and the next Start records the default limit of 3
