# Spec Delta

## ADDED Requirements

### Requirement: Team mode has its own shell
The Team page SHALL render in its own shell exactly when the URL names a team location, without mounting the session navigator or session header. Its top bar SHALL offer Sessions | Team, a team switcher, a command palette, and connection state. Switching to Sessions SHALL leave the team route without changing the selected chat. The mode SHALL toggle with ⌘. except while focus is in a text field.

#### Scenario: Areas are grouped by work
- **WHEN** Team mode renders its rail
- **THEN** it shows Today; Work: Plans, Tasks, Conversations; Direction: Strategy; Team: Agents, Insights, Outbound audit

#### Scenario: Team mode hides the session navigator
- **WHEN** the human switches to Team from a chat
- **THEN** the team's last area is shown full width, the session navigator and session header are not shown, and the selected chat is unchanged

#### Scenario: Switching back restores the chat
- **WHEN** the human switches from Team to Sessions
- **THEN** the previously selected chat is shown and the URL no longer names a team location

#### Scenario: The shortcut leaves typing alone
- **WHEN** focus is in a message composer in Team mode and the human presses ⌘.
- **THEN** the mode does not change

#### Scenario: Switching teams keeps the area
- **WHEN** the human is on Tasks of team A and picks team B in the team switcher
- **THEN** Tasks of team B is shown

### Requirement: The mode switch shows where the human is needed
The **Team** side of the switch SHALL show the number of human-required attention items of the last team shown, in both modes. The **Sessions** side SHALL show a marker when a chat that is not a member of that team has a pending approval or question. An item SHALL count on only one side. Both markers SHALL have text for assistive technology.

#### Scenario: A team approval counts on Team only
- **WHEN** a member of the team has a pending approval and no other chat waits on the human
- **THEN** Team shows 1 and Sessions shows no marker

#### Scenario: A solo chat's question marks Sessions
- **WHEN** a chat outside the team asks a question while the human is in Team mode
- **THEN** Sessions shows its marker, named as one chat needing the human

### Requirement: Opening a chat from Team offers a way back
Opening a chat from Team mode SHALL switch to Sessions with a **Back to Team** control that returns to the exact Team location, including its selection. Selecting a chat any other way SHALL remove the control.

#### Scenario: Back to the same task
- **WHEN** the human opens an agent's chat from a task's side sheet on Tasks and then activates **Back to Team**
- **THEN** Tasks is shown with the same task's sheet open

#### Scenario: Navigating elsewhere drops the way back
- **WHEN** after opening a chat from Team the human selects another chat in the navigator
- **THEN** no **Back to Team** control is shown

### Requirement: Today lists what needs the human and acts in place
Team mode SHALL open on Today by default. Today SHALL group human-required attention under Needs you and agent waits under folded Waiting on agents. Expanding an item SHALL reuse its owning control and existing command, or show its source link when no inline control exists. Controls SHALL disable while disconnected and refusals SHALL render inline.

#### Scenario: Today keeps each owning action available
- **WHEN** the corresponding attention items appear on Today
- **THEN** their controls offer approve or deny, answer a question or decision card, accept or request fixes, retry or discard delivery, retry or stop execution, and promote again, using the existing commands

#### Scenario: Today shows the work overview
- **WHEN** Today opens
- **THEN** it shows task flow, plans in flight, live agents, and the last 24 hours alongside the inbox

#### Scenario: Approve from Today
- **WHEN** an agent waits on approval of a command and the human expands the item on Today and chooses **Approve once**
- **THEN** the same approval message the chat's card sends is sent for that request, and the item leaves Needs you

#### Scenario: Answer a decision card from Today
- **WHEN** a plan's decision card is open and the human answers it from Today
- **THEN** the plan's decision is recorded as if answered on the plan, and the plan's blocked changes resume

#### Scenario: A second answer is refused
- **WHEN** an approval was answered in the chat and the human then answers it from a stale Today view
- **THEN** the refusal is shown inline and the item disappears on the next update

#### Scenario: An unknown kind still has a way forward
- **WHEN** the workspace carries an attention kind this client does not know
- **THEN** Today lists it with its raw kind and a link to its source

### Requirement: The task flow strip shows where work piles up
Today and Tasks SHALL show open task counts and oldest stage waits for Planning, Writing, Review, QA, and Accept. Planning through QA SHALL qualify as bottleneck with at least two tasks; the greatest count wins, then oldest wait, then earlier stage. Accept SHALL never be the bottleneck and SHALL count results waiting on the human. Stages SHALL filter Tasks; a plan choice SHALL narrow the strip to that plan.

#### Scenario: Stages map to workflow
- **WHEN** open rows have unstarted, implementing, fixes-requested, in-review, ready-for-qa, or awaiting-acceptance stages
- **THEN** they count under Planning, Writing, Writing, Review, QA, or Accept respectively, and closed rows count nowhere

#### Scenario: Today opens a stage filter
- **WHEN** the human activates a stage on Today
- **THEN** Tasks opens with that stage filter

#### Scenario: Writing is the bottleneck
- **WHEN** three tasks are implementing, the oldest for six hours, and one is in review
- **THEN** the strip names Writing as the bottleneck with three tasks and an oldest wait of six hours

#### Scenario: Acceptance waits are the human's, not a bottleneck
- **WHEN** four results await acceptance, two of them on the human, and no other stage has two tasks
- **THEN** no bottleneck is named and Accept shows two waiting on the human

#### Scenario: A stage filters the board
- **WHEN** the human activates Review on the Tasks strip
- **THEN** the board shows only tasks in review and Review is marked pressed

### Requirement: Task rows report time in stage and rework rounds
Each task row SHALL carry the time it entered its current stage and the number of its results whose single newest review-or-QA findings record has verdict `fail`, ordered by creation time then rowid (rework rounds). Neither SHALL be stored; both SHALL be projected when the workspace is read.

#### Scenario: Re-review that passes does not count
- **WHEN** a result's first findings failed and a later review of the same result passed
- **THEN** that result does not add to the task's rework rounds

#### Scenario: Unchanged stage keeps its oldest wait
- **WHEN** a task receives a comment or another event that leaves its projected stage unchanged
- **THEN** its time in stage still starts at the last transition into that stage

#### Scenario: Two failed results and a passing one
- **WHEN** a task has three results whose newest findings are fail, fail, and pass
- **THEN** its rework rounds are 2

### Requirement: A task stuck in rework needs the human
Kawai SHALL raise human-required Stuck in rework for open implementing, fixes-requested, or review tasks at the team threshold, unless acknowledged. Let it continue SHALL record the current rounds under a command id and suppress the item until rounds exceed the highest acknowledgement. The strip SHALL mark only tasks with a raised item as stuck; other rework SHALL remain neutral. Closed tasks and tasks awaiting acceptance or QA SHALL have no stuck item.

#### Scenario: Stuck actions address the task
- **WHEN** a stuck item is expanded
- **THEN** it names the task and offers Make the call (message its thread), Take over in chat, and Let it continue

#### Scenario: Acknowledgement commands retain their response
- **WHEN** the human replays an acknowledgement after a later acknowledgement
- **THEN** the original response is returned; conflicting payloads, stale rounds, and tasks outside the addressed team are refused

#### Scenario: Third send-back raises the item
- **WHEN** the threshold is 3 and review sends a task back for the third time
- **THEN** Needs you lists the task as stuck in rework and the strip marks it stuck

#### Scenario: Normal rework stays quiet
- **WHEN** review sends a task back for the second time and the threshold is 3
- **THEN** no attention item is raised and the strip shows the task in rework without alarm

#### Scenario: Letting it continue until the next round
- **WHEN** the human chooses **Let it continue** on a task stuck at 3 rounds, and review later fails its next result
- **THEN** the item is hidden until that fourth failing round, and is listed again after it

#### Scenario: Convergence clears the item
- **WHEN** a stuck task's newest result passes review and awaits acceptance
- **THEN** the stuck item is no longer listed

#### Scenario: Only the human acknowledges rework
- **WHEN** an agent attempts either rework command
- **THEN** the command is refused without changing the threshold or acknowledgement

#### Scenario: Rework acknowledgement survives a lower count
- **WHEN** a task was acknowledged at 3 rounds and a passing re-review reduces it to 2 while the threshold is 2
- **THEN** no stuck item is raised until its rounds exceed 3

### Requirement: The rework threshold is a team setting
The team SHALL have a rework threshold from 2 to 10, defaulting to 3, set only by the human from Agents or from the task flow strip. A value outside the range SHALL be refused inline, the control SHALL be disabled while disconnected, and every open view of the team SHALL follow a change without reloading.

#### Scenario: Raising the threshold
- **WHEN** a task is stuck at 3 rounds and the human sets the threshold to 4
- **THEN** the task is no longer listed as stuck, and the strip shows it in rework

#### Scenario: Out of range
- **WHEN** the human tries to set the threshold to 1
- **THEN** the change is refused inline and the threshold is unchanged

### Requirement: Conversations holds threads and delivery operations
Conversations SHALL compose Threads (mail grouped by thread, with existing search, compose, reply, and textual delivery state) and Delivery (all unsettled messages and their waiting reasons). Unsettled messages in Threads SHALL offer applicable Delivery actions using the same commands. Delivery issues SHALL filter threads holding held, dead-lettered, or uncertain messages.

#### Scenario: Delivery retains all operations and routing
- **WHEN** Delivery opens
- **THEN** it offers applicable Cancel, Retry, Discard, Hand off, and Reload routing rules actions; Held for review, Dead letters, and Parked lead and start expanded, other sections start collapsed with counts, and routing has its own collapsible section

#### Scenario: Retry from the thread
- **WHEN** a message in a thread is held as an uncertain delivery and the human chooses Retry on it
- **THEN** the same retry the Delivery view offers is sent, and the message is marked as a possible duplicate

#### Scenario: Delivery issues filter
- **WHEN** the human turns on **Delivery issues** while one of six threads holds a dead letter
- **THEN** only that thread is listed

#### Scenario: Delivery sections lead with actions
- **WHEN** Delivery opens with one held message, two queued, and three scheduled
- **THEN** Held for review is first and expanded, Queued and Scheduled are collapsed showing 2 and 3, and the held row's Retry and Discard are available

### Requirement: The strategy status is shown in the rail and on Strategy
The rail's Strategy entry SHALL show a marker while a revision is in review. Strategy SHALL show the revision in review as a banner with its proposer, the sections it changes, its impact on plans, **Review changes**, and **Approve**; with no revision in review it SHALL show the approved revision, or that none is approved, or the capture affordance when there is no strategy.

#### Scenario: A revision awaits review
- **WHEN** revision 2 is approved and revision 3 is in review while the human is on Tasks
- **THEN** the rail's Strategy entry shows its review marker, and Strategy shows the banner for revision 3

#### Scenario: No strategy
- **WHEN** the team has no strategy record
- **THEN** the rail shows no review marker and Strategy offers capture

## MODIFIED Requirements

### Requirement: A Team workspace opens at repository level, independent of the selected chat
The system SHALL open Team mode for a repository's team from its navigator **Team** entry, the chat header's **Team** button, or the mode switch, on the team's last area or on Today the first time, independent of the selected chat. Returning from a chat SHALL restore the team, area, and selection.

#### Scenario: Open the workspace from the navigator
- **WHEN** the human opens the **Team** entry of a repository for the first time in this browser tab
- **THEN** Team mode opens on Today for that repository's team

#### Scenario: The workspace survives chat selection
- **WHEN** the human selects a chat while Team mode shows a selected task, then returns through the mode switch, the Team entry, or the browser's Back
- **THEN** Team mode reopens on the same team with the same area and selection

#### Scenario: The workspace survives its transport chat being killed
- **WHEN** the chat session whose connection carries Team mode's requests is killed while Team mode is open
- **THEN** Team mode stays open on its team, because it is addressed by the team's directory and not by any chat, and shows a disconnected state only when no connection is left

#### Scenario: No placeholder Plans
- **WHEN** no Plans view is registered and Team mode renders its rail
- **THEN** no Plans content or placeholder is shown; Plans remains a documented extension point until its view registers

### Requirement: The morning summary groups the interval's outcomes
Today's **Last 24 hours** section SHALL list completed results, capacity waits, approvals, uncertain deliveries, and finished turns without a result over the last 24 hours, each bucket counting its items and linking to them. A finished turn with no submitted result SHALL NOT be counted as a completed result.

#### Scenario: Each bucket is populated (E13)
- **WHEN** the last 24 hours hold a submitted result, a cap wait, an open approval, an uncertain delivery, and an agent that finished a turn with no result
- **THEN** the summary shows one item in each of the five buckets

#### Scenario: A finished turn is not a completion (E13)
- **WHEN** an agent finishes a turn and submits no result
- **THEN** it appears only in the finished-turn-without-result bucket and never among completed results

#### Scenario: Resolved items leave the buckets (E13)
- **WHEN** an approval in the summary window is answered
- **THEN** the recomputed summary no longer lists it as an open approval

#### Scenario: A restart keeps durable buckets (E13)
- **WHEN** the server restarts and the workspace opens
- **THEN** completed results and uncertain deliveries in the window are still listed, while capacity waits list only waits the running server has observed

#### Scenario: Capacity waits state their runtime bound (E13)
- **WHEN** the summary shows the capacity-waits bucket
- **THEN** the bucket carries a label naming it runtime-only — it lists only waits the running server has observed

### Requirement: The Team page location is in the URL
The URL SHALL identify the team, the area, the Strategy or Conversations sub-view, the Insights window, and the selected task, thread, plan, revision, report, or call. Reloading SHALL reopen that location, the browser's Back and Forward SHALL move between locations visited, and a location for an unknown repository or a missing item SHALL open the nearest valid view with a notice. A location naming a former tab (Messages, Mailbox, Members, Metrics) SHALL open the area that replaced it and replace the URL without adding a history entry.

#### Scenario: Reload keeps the location
- **WHEN** the human reloads while viewing task `t_12` on Tasks of `kawai`
- **THEN** Tasks reopens with `t_12` selected

#### Scenario: Back returns to the previous tab
- **WHEN** the human moves from Tasks to Conversations and presses the browser's Back
- **THEN** Tasks is shown again

#### Scenario: A missing task
- **WHEN** the URL names a task that no longer exists in the team
- **THEN** Tasks opens with no selection and a notice that the task was not found

#### Scenario: An old Mailbox link
- **WHEN** the human opens a saved link to the team's Mailbox tab
- **THEN** Conversations opens on Delivery, and Back leaves the page instead of returning to the old link

### Requirement: The workspace supports one-handed list and detail navigation
Below a 768 px viewport width Team mode SHALL replace the rail with a bottom bar (Needs you, Plans, Task flow, Messages) and show Today as a phone inbox: the plans paused on the human first, then items that unblock a plan, then quick yes-or-no items, each with its actions as full-width targets of at least 44 by 44 px. A decision SHALL open as a full-screen answer view with its send action pinned at the bottom and an **Undo** for 10 seconds before transmission. Navigation within the tab SHALL preserve the deadline and a visible Undo; disconnect or resolution elsewhere SHALL cancel the pending send and retain the draft with a notice. Closing or reloading the tab SHALL cancel an unsent answer, as disclosed in the pending view. Lists and details SHALL use an explicit **Back** action. Opening a chat SHALL preserve the selection and filters, and unsubmitted drafts and the current selection SHALL survive navigation within Team mode.

#### Scenario: Back returns to the preserved list (E14)
- **WHEN** the human filters tasks, opens one on a narrow viewport, then uses **Back**
- **THEN** the filtered list and selection are as they were

#### Scenario: Opening a chat preserves workspace state (E14)
- **WHEN** the human opens a session from an attention item and returns
- **THEN** the area, filters, and selection are unchanged

#### Scenario: Answer a decision on a phone
- **WHEN** on a 390 px wide viewport the human opens a decision from Needs you, picks an option, and sends
- **THEN** the answer is sent once after the 10-second undo window, and the view offers the next item that blocks a plan

#### Scenario: Navigation preserves the undo window
- **WHEN** the human schedules a decision answer on a phone and opens a chat after two seconds
- **THEN** Undo remains available for the remaining eight seconds and no answer is sent early

#### Scenario: Undo stops the send
- **WHEN** the human sends a decision on a phone and presses **Undo** within 10 seconds
- **THEN** no answer is sent and the answer view is shown again with the choice kept

## REMOVED Requirements

### Requirement: The Team page header shows the strategy status
**Reason**: Team mode has no page header line; the strategy status moves to the rail's Strategy marker and the Strategy banner.
**Migration**: See "The strategy status is shown in the rail and on Strategy".

### Requirement: Mailbox is a tab of delivery operations
**Reason**: Messages and Mailbox merge into Conversations; the Mailbox's sections become its Delivery view and its actions also appear on the messages they act on.
**Migration**: See "Conversations holds threads and delivery operations". Old Mailbox links open Conversations › Delivery.
