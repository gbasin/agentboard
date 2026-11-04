# team-workspace Specification

## Purpose
Provide the repository-level Team workspace where the human supervises a team's product strategy, tasks, attention items, and group settings in one view that is independent of any selected chat.

## Requirements

### Requirement: A Team workspace opens at repository level, independent of the selected chat
The system SHALL open a full workspace view for a repository's team from its navigator **Team** entry, with a **Strategy | Tasks | Messages | Mailbox | Members** tab strip under a header showing the strategy status, independent of the selected chat. The Plans tab SHALL be a registered extension point that renders no content or placeholder until a Plans view registers. Returning from a chat SHALL restore the team, tab, and selection.

#### Scenario: Open the workspace from the navigator
- **WHEN** the human opens the **Team** entry of a repository
- **THEN** the full workspace view for that repository's team opens with the Strategy, Tasks, Messages, Mailbox, and Members tabs and the strategy status in its header

#### Scenario: The workspace survives chat selection
- **WHEN** the human selects a chat while the Team page is open on a selected task, then returns through the Team entry or the browser's Back
- **THEN** the Team page reopens on the same team with the same tab and selection

#### Scenario: The workspace survives its transport chat being killed
- **WHEN** the chat session whose connection carries the Team page's requests is killed while the page is open
- **THEN** the page stays open on its team, because it is addressed by the team's directory and not by any chat, and shows a disconnected state only when no connection is left

#### Scenario: No placeholder Plans
- **WHEN** no Plans view is registered and the workspace renders its tab strip
- **THEN** no Plans tab content or placeholder row is shown, and the place a future Plans tab occupies is a documented extension point

### Requirement: Task rows show workflow stage separately from task status
Each task row SHALL show its title, task status, workflow stage, accountable session or role, worktree, current waiting reason, and next action. The workflow stage SHALL be projected from the task's assignment and its result, findings, and handoff records, and displayed separately from task status. A finished agent turn SHALL NOT mark a task done.
#### Scenario: Stage and status are distinct
- **WHEN** an assigned task's agent finishes a turn with no result submitted
- **THEN** the row still shows the task's own status and a workflow stage of Implementing, not done

#### Scenario: A review request moves the stage
- **WHEN** a result's review handoff is outstanding
- **THEN** the row shows a workflow stage of In review alongside the unchanged task status

#### Scenario: A queued review handoff already shows In review
- **WHEN** a review handoff is dispatched and still queued while its result is unaccepted
- **THEN** the row shows In review — the ladder's handoff order precedes Awaiting acceptance

#### Scenario: Failing findings show Fixes requested
- **WHEN** no handoff is outstanding and the newest findings bound to the task's unaccepted outstanding result have the verdict fail
- **THEN** the row shows a workflow stage of Fixes requested and a next action of Wait for fixes, not Awaiting acceptance

#### Scenario: Passing findings leave the result awaiting acceptance
- **WHEN** the newest findings bound to the unaccepted outstanding result have the verdict pass, or the result has no findings
- **THEN** the row shows a workflow stage of Awaiting acceptance

#### Scenario: A closed task shows no stage
- **WHEN** a task's status is done while its last assignment stands delivered
- **THEN** the row shows no workflow stage, not Implementing

#### Scenario: Accountability falls back to the requested role
- **WHEN** a group assignment is queued with no claimed agent
- **THEN** the row shows the requested role as the accountable party and names no session

### Requirement: Task rows can be filtered and closed tasks stay searchable
The task list SHALL filter by active, blocked, awaiting human, awaiting acceptance, group, and worktree. Tasks with status done or cancelled SHALL be searchable but excluded from the default list. Filters and the selected task SHALL survive navigation within the workspace.
#### Scenario: Closed tasks are absent by default
- **WHEN** the workspace opens on a team with done tasks
- **THEN** those tasks are not in the default list and are found by search

#### Scenario: Awaiting-human filter narrows the list
- **WHEN** the human applies the awaiting-human filter
- **THEN** only tasks whose next action requires a human are listed

#### Scenario: Filters survive navigation
- **WHEN** the human filters by worktree, opens a task, and navigates back
- **THEN** the worktree filter and the selected task are unchanged

### Requirement: The attention queue lists what needs a human or is waiting on an agent
The attention queue SHALL consolidate pending approvals and questions, uncertain deliveries, staffing waits, pending acceptance, and results whose review requested fixes. Each item SHALL show its cause, owner, impact scope, next action, and a link to its card, task, or message. Human-required items SHALL be separated from agent-owned waits. Pending acceptance SHALL be owned by the party expected to close the task.
#### Scenario: An open approval is a human-required item (E05)
- **WHEN** a session has a pending approval
- **THEN** the queue lists it as human-required with the session as owner, its task as impact scope, and a link to that chat's approval card

#### Scenario: A staffing wait is agent-owned (E05)
- **WHEN** a message waits on a group cap
- **THEN** the queue lists it under agent-owned waits with the capacity as its cause and a link to the message

#### Scenario: An uncertain delivery needs the human
- **WHEN** a message is held as an uncertain delivery
- **THEN** the queue lists it as human-required with retry or discard as its next action and a link to the message

#### Scenario: Pending acceptance needs the human
- **WHEN** a submitted result of a task the human created awaits **Accept result**, and its newest findings, if any, pass
- **THEN** the queue lists it as human-required with the task as impact scope and a link to the task

#### Scenario: An agent-created task's acceptance waits on its creator
- **WHEN** a submitted result of a task created by a live agent session awaits acceptance, and its newest findings, if any, pass
- **THEN** the queue lists it under agent-owned waits with that session as owner, the task as impact scope, and a link to the task
- **AND** the human can still accept the result from the task

#### Scenario: A creator that is gone hands acceptance to the human
- **WHEN** the agent session that created the task is archived or killed and the task's result awaits acceptance
- **THEN** the queue lists that pending acceptance as human-required

#### Scenario: Failing findings are a wait for fixes
- **WHEN** the newest findings bound to a task's unaccepted outstanding result have the verdict fail
- **THEN** the queue lists one agent-owned fixes-requested item with the result's submitter as owner, Wait for fixes as its next action, the task as impact scope, and a link to the task
- **AND** no pending acceptance is listed for that result

### Requirement: Attention items have a stable identity and accept later sources
Each attention item SHALL carry a kind, a stable identity, and a link that MAY target a card. A later change MAY add kinds — plan holds, stalls, Lead decision cards — without changing the item shape. An item of an unrecognized kind SHALL still be rendered with its cause and next action rather than dropped.
#### Scenario: An unrecognized kind still renders
- **WHEN** the queue receives an item whose kind this client does not know
- **THEN** the item is listed with its cause, owner, impact scope, next action, and link

#### Scenario: A card link is accepted
- **WHEN** an item's link targets a card
- **THEN** the item renders and its link opens that card

### Requirement: Attention counts reconcile after reconnect without duplicate toasts
On open and on reconnect the workspace SHALL replace its attention items and counts with the authoritative snapshot rather than incrementing them. Each item identity SHALL raise at most one toast per client session across its transitions; a reconnect that replays unchanged state SHALL raise no toast.
#### Scenario: Reconnect converges the counts (E05, E13)
- **WHEN** the connection drops while two approvals are pending and one is resolved, then the client reconnects
- **THEN** the workspace shows one attention item, not two and not three

#### Scenario: Replaying state does not re-toast (E05, E13)
- **WHEN** a reconnect resends a snapshot whose items are unchanged
- **THEN** no toast is raised for those items

### Requirement: Members is a read-only inspection of group settings
The Members tab SHALL list each of the team's groups with its role description, live membership, task-creation right, effective workers grouped by provider with caps and live counts, effective approval policy with its source (group file, team default, or built-in), member cap, routing strategy and limit policy, effort with any per-model effort, and routing warnings. No control SHALL edit a group. A prompt change SHALL affect future agent starts only and SHALL NOT elevate runtime permissions.

#### Scenario: Caps show live counts
- **WHEN** a group allows two members on a model and one is live
- **THEN** the row shows 1 of 2 for that model with the live member named

#### Scenario: Workers are grouped by provider
- **WHEN** the `juniors` group sets `workers: { glm-flash: 3, haiku: 2 }`, with `glm-flash` a model of provider Z.AI and `haiku` a model of provider Claude
- **THEN** the group's row shows `glm-flash` under Z.AI and `haiku` under Claude, each with its cap and live count

#### Scenario: Members cannot be edited
- **WHEN** the human opens the Members tab
- **THEN** it presents no control that writes a group file or changes a running agent's permissions

#### Scenario: A warning names what fell back
- **WHEN** a group file lists a model the catalog does not define
- **THEN** the group's row shows that warning alongside the settings that took effect

#### Scenario: Per-profile effort is shown beside the group effort
- **WHEN** a group sets `effort: low` and `modelEffort: { haiku: xhigh }`
- **THEN** the group's row shows effort `low` together with `xhigh` for the `haiku` model

#### Scenario: Approval source is shown
- **WHEN** the team has no default and a group has no `approval:` key
- **THEN** the group's row shows manual as the built-in policy

### Requirement: Members names the source file of every setting
Each group row SHALL name the file that defines it and, when both layers define it, both paths with the one in effect marked. The row SHALL state that prompt changes apply to future agent starts only.
#### Scenario: A project file overrides a user file
- **WHEN** `~/.kawai/groups/devs.md` and `<main-checkout>/.kawai/groups/devs.md` both define `devs`
- **THEN** the row marks the project file as in effect and lists the user file beneath it

#### Scenario: A single-layer group names one file
- **WHEN** a group is defined only in the user's home
- **THEN** the row names that file as its source

### Requirement: The morning summary groups the interval's outcomes
A summary band SHALL list completed results, capacity waits, approvals, uncertain deliveries, and finished turns without a result over the last 24 hours, each bucket naming its items with links. A finished turn with no submitted result SHALL NOT be counted as a completed result.
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

### Requirement: The workspace supports one-handed list and detail navigation
At a narrow viewport the workspace SHALL use list and detail panes with an explicit **Back** action. Opening a chat SHALL preserve the task selection and filters. Unsubmitted composer drafts and the current selection SHALL survive navigation within the workspace.
#### Scenario: Back returns to the preserved list (E14)
- **WHEN** the human filters tasks, opens one on a narrow viewport, then uses **Back**
- **THEN** the filtered list and selection are as they were

#### Scenario: Opening a chat preserves workspace state (E14)
- **WHEN** the human opens a session from an attention item and returns
- **THEN** the workspace tab, filters, and selection are unchanged

### Requirement: The workspace is keyboard accessible
Every workspace control SHALL be reachable and operable from the keyboard, show a visible focus indicator, and have an accessible name. Every state SHALL carry a text label in addition to any color or icon.
#### Scenario: Keyboard-only attention handling (E14)
- **WHEN** the human uses only the keyboard to open the workspace and resolve an attention item
- **THEN** each control shows visible focus, is named, and the item's state change is announced as text

### Requirement: Workspace reads are team-scoped and refuse cross-team access
Every Team page read and action SHALL be scoped to the team of the repository path the page addresses. A path that is not a discovered repository, one of its listed worktrees, or the project directory of an existing chat session SHALL be refused. Another team's task, message, strategy, session, or worktree SHALL be refused server-side and SHALL NOT appear on the page.

#### Scenario: A second repository stays isolated (E14)
- **WHEN** a second repository's team is open beside the first
- **THEN** each workspace lists only its own team's tasks, members, messages, attention counts, and worktrees

#### Scenario: Cross-team ids are refused (E14)
- **WHEN** a workspace request names a task id belonging to another team
- **THEN** the server refuses it and no data for that task is returned

#### Scenario: Cross-team links are refused (E14)
- **WHEN** a workspace link names a task, message, or strategy of another team
- **THEN** the owning connection refuses it and the workspace shows no data for it

#### Scenario: An unknown path is refused
- **WHEN** a Team page request addresses a directory that is neither a discovered repository, a listed worktree, nor a chat session's project directory
- **THEN** the server refuses it and returns no team data

#### Scenario: Works with no chat
- **WHEN** a repository has only terminal sessions and the human opens its Team entry
- **THEN** its tasks, messages, mailbox, strategy, and members load

### Requirement: The workspace stays current without a manual refresh
The workspace SHALL receive one authoritative snapshot on open and on reconnect, and unfiltered change pushes the client applies. A new attention item or a stage change SHALL appear without a manual reload.
#### Scenario: A new approval appears live
- **WHEN** a session raises a pending approval while the workspace is open
- **THEN** the attention queue shows it without a manual refresh

#### Scenario: Opening always snapshots
- **WHEN** the workspace is opened after a period of change
- **THEN** it receives a full authoritative snapshot before any incremental push is applied

### Requirement: Team views are mounted only on the Team page
Tasks, Messages, Mailbox, and Product Strategy SHALL be shown only as tabs of the Team page, never in a chat's side slot. A chat SHALL reach them through its header's Team button or task chip, which open the Team page for the chat's team.

#### Scenario: A task chip opens the Team page
- **WHEN** the human clicks a chat's task chip
- **THEN** the Team page for the chat's team opens on Tasks with that task selected

#### Scenario: Same record from any entry point
- **WHEN** the human opens a task from the navigator's Team entry and later from a chat's task chip
- **THEN** both show the same Team page view of that task, with the same revisions, journal, and messages

### Requirement: Product Strategy is a tab with full-width sub-views
The **Strategy** tab SHALL hold the strategy as four sub-views at the page's full width: an overview of the direction, a review of one revision in review, the draft editor, and the revision history. Each sub-view SHALL keep the existing strategy actions and their human-only approval rules. A team with no strategy record SHALL show the capture affordance in the overview.

#### Scenario: Overview leads with direction
- **WHEN** the human opens the Strategy tab of a team with an approved revision
- **THEN** purpose, primary users, needs and outcomes, use cases, principles, and boundaries are shown first, with every other section collapsed and expandable

#### Scenario: Review shows the diff beside the findings
- **WHEN** the human opens the review of revision 3 on a wide viewport
- **THEN** the changes from the approved revision and the Known / Assumed / Not decided findings are side by side, with **Approve revision 3** and **Withdraw** below them

#### Scenario: The draft editor keeps its text across sub-views
- **WHEN** the human edits a draft, switches to History, and returns to the draft
- **THEN** the unsaved text is unchanged

#### Scenario: No record offers capture
- **WHEN** the team has no strategy record
- **THEN** the overview offers capture, and the Tasks, Messages, Mailbox, and Members tabs work as usual

### Requirement: The Team page header shows the strategy status
The Team page header SHALL show a one-line strategy status on every tab: the approved revision number, or that none is approved, and a count of revisions in review. Activating it SHALL open the Strategy tab on the overview, or on the review when a revision is in review.

#### Scenario: A revision awaits review
- **WHEN** revision 2 is approved and revision 3 is in review while the human is on Tasks
- **THEN** the header shows approved revision 2 and one revision in review, and activating it opens the review of revision 3

#### Scenario: No strategy
- **WHEN** the team has no strategy record
- **THEN** the header shows that no strategy is captured, and activating it opens the Strategy overview

### Requirement: Mailbox is a tab of delivery operations
The **Mailbox** tab SHALL list every unsettled message in its delivery section with its waiting reason, and SHALL offer the existing Cancel, Retry, Discard, Hand off, and Reload routing rules actions. Held for review, Dead letters, and Parked SHALL come first and start expanded; the other sections SHALL start collapsed and show their counts. Routing state SHALL be its own collapsible section.

#### Scenario: Action sections lead
- **WHEN** the Mailbox tab opens with one held message, two queued, and three scheduled
- **THEN** Held for review is first and expanded, Queued and Scheduled are collapsed showing 2 and 3, and the held row's Retry and Discard are available

#### Scenario: A collapsed section expands
- **WHEN** the human expands Scheduled
- **THEN** its three rows are listed with their due times

### Requirement: Mailbox rows collapse to one line and can be searched
Each Mailbox row SHALL show by default one line: sender, recipient, age, priority, its waiting reason's immediate blocker, and the first line of its body. Expanding a row SHALL show the full body, every constraint, and any handoff detail. A search box SHALL narrow every section to rows whose sender, recipient, body, or reason contains the text. Empty sections SHALL be hideable.

#### Scenario: Expand a row
- **WHEN** the human expands a queued row whose body is twenty lines
- **THEN** the full body and the row's other waiting constraints are shown, and collapsing it returns to one line

#### Scenario: Search narrows the sections
- **WHEN** the human searches `strategy-ui`
- **THEN** only rows whose sender, recipient, body, or reason contains `strategy-ui` remain, and each section's count reflects the match

#### Scenario: Hide empty sections
- **WHEN** the human turns on hiding empty sections and Receiving has no rows
- **THEN** Receiving is not shown

### Requirement: Messages rows group by thread and collapse
The **Messages** tab SHALL group its list by thread: one collapsible row per thread, showing its latest message and message count. Message bodies SHALL be clamped to a few lines until expanded. **Expand all** and **Collapse all** SHALL act on every loaded thread. Opening a thread SHALL keep showing its detail and composer.

#### Scenario: A thread collapses to one row
- **WHEN** a thread holds six messages
- **THEN** the list shows one row for it with its latest message and a count of 6, and expanding it lists the six messages

#### Scenario: Long bodies are clamped
- **WHEN** a message body is longer than the clamp
- **THEN** the row shows its first lines with a control to show the full body

#### Scenario: Expand all
- **WHEN** the human chooses Expand all
- **THEN** every loaded thread row is expanded, and Collapse all collapses them again

### Requirement: Messages search covers the whole history
The Messages tab SHALL offer a text search that the server applies to the team's whole message history alongside the other filters, matching message bodies and participant names. It SHALL NOT be limited to loaded pages. Paging SHALL continue within the search's results.

#### Scenario: Search finds an old message
- **WHEN** the human searches a phrase that appears only in a message older than every loaded page
- **THEN** the list shows that message's thread

#### Scenario: Search combines with filters
- **WHEN** the human filters to urgent mail and searches `review`
- **THEN** only urgent messages containing `review` are listed, and **Load more** continues within those results

#### Scenario: A live message outside the search
- **WHEN** a new message that does not contain the search text arrives while a search is active
- **THEN** it is not added to the list

### Requirement: Tasks search and collapse
The **Tasks** tab SHALL offer a search box over each task's title and current direction. It SHALL show subtasks nested under their parent, with each parent collapsible. Each section of a task's detail — direction, acceptance, revision history, journal, subtasks, and messages — SHALL collapse and expand on its own.

#### Scenario: Search highlights matches
- **WHEN** the human searches `usage bar`
- **THEN** only tasks whose title or current direction contains it are listed, with the match marked, and a matching subtask is shown under its parent

#### Scenario: Collapse a parent
- **WHEN** the human collapses a parent task with two subtasks
- **THEN** its subtasks are hidden and the parent row shows that it has 2

#### Scenario: Detail sections collapse independently
- **WHEN** the human collapses Revision history and then opens another task
- **THEN** Revision history is collapsed in that task's detail too, while the other sections keep their own state

### Requirement: Each tab keeps its view state while the page is open
Each tab's search, filters, expanded items, and selection SHALL survive switching tabs, opening a chat and returning, and reconnecting, for as long as the browser tab is open. They SHALL be kept per team, so two teams' pages SHALL NOT share them. They SHALL NOT be sent to the server.

#### Scenario: State survives a chat visit
- **WHEN** the human searches Mailbox, expands two rows, opens a chat from one of them, and returns to the Team page
- **THEN** Mailbox shows the same search and the same two rows expanded

#### Scenario: Teams keep separate state
- **WHEN** the human searches Tasks on team A and then opens team B's Team page
- **THEN** team B's Tasks has no search applied

### Requirement: The Team page location is in the URL
The URL SHALL identify the Team page's repository, tab, Strategy sub-view, and selected task or thread. Reloading SHALL reopen that location, the browser's Back and Forward SHALL move between locations visited, and a location for an unknown repository or a missing item SHALL open the nearest valid view with a notice.

#### Scenario: Reload keeps the location
- **WHEN** the human reloads while viewing task `t_12` on the Tasks tab of `kawai`
- **THEN** the Team page reopens on Tasks with `t_12` selected

#### Scenario: Back returns to the previous tab
- **WHEN** the human moves from Tasks to Mailbox and presses the browser's Back
- **THEN** the Team page shows Tasks again

#### Scenario: A missing task
- **WHEN** the URL names a task that no longer exists in the team
- **THEN** the Tasks tab opens with no selection and a notice that the task was not found

### Requirement: Failed turns are not finished work
The morning summary SHALL count only turns that completed successfully as finished turns. A turn the agent reported as failed, including one marked as an error under a success subtype, SHALL never count.

#### Scenario: Exhausted turn in the summary
- **WHEN** a task-bound session's turn ended with `Prompt is too long`
- **THEN** the morning summary does not count it as a finished turn

### Requirement: The attention queue lists exhausted sessions
The attention queue SHALL list each context-exhaustion item with its cause (the session and terminal reason), its owner, its impact (the dropped message and task, if any), and a next action that opens its source. A dropped message's item opens its Mailbox row, and otherwise the item opens the chat.

#### Scenario: Item with a dropped message
- **WHEN** an exhaustion dead-lettered the lead's go mail
- **THEN** the item names the session and reason, is owned by the lead, and its action opens that Mailbox row expanded

#### Scenario: Item without mail
- **WHEN** a human-created session is flagged during a human-typed turn
- **THEN** the item is under needs you and its action opens the chat

### Requirement: The Members tab sets the team's default approval policy
The Members tab SHALL show the team's default approval policy for spawned members (not set, manual, or auto) and SHALL let the human set it to manual or auto. It SHALL say that the default covers spawned members of groups without an `approval:` key, and changes only later spawns. A save SHALL show the server's refusal inline, and the control SHALL be disabled while disconnected. After a save, every open view of that team SHALL show the new default and the resolved group policies.

#### Scenario: Setting the default updates the group rows
- **WHEN** the human sets the team default to auto on the Members tab
- **THEN** every group without an `approval:` key shows auto from the team default, and groups with the key keep their own policy

#### Scenario: Another open view follows the change
- **WHEN** two browser tabs show the same team's Members tab and one sets the default to auto
- **THEN** the other tab shows auto without reloading

#### Scenario: The control is disabled while disconnected
- **WHEN** the Team page loses its server connection
- **THEN** the default approval control is disabled and the last known value stays shown
