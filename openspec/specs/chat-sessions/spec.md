# chat-sessions Specification

## Purpose

Sessions driven by an agent SDK through a web chat interface instead of a
tmux terminal: lifecycle, streamed conversation events, permission approvals,
interruption, and event-derived status for chat sessions.

## Requirements

### Requirement: Users can start a Claude Code chat session
The system SHALL let a user start a chat session for a chosen project
directory, driven by the Claude Agent SDK, as an alternative to a terminal
(tmux) session, listed and selectable alongside terminal sessions without
requiring a tmux window. Creation SHALL be refused with an actionable error
when agent authentication is not configured server-side or the resolved
project path does not name an existing directory.

#### Scenario: Chat session created from the new-session form
- **WHEN** the user submits the new-session form with the chat kind selected and a project directory
- **THEN** a chat session is created, appears in the session list marked as a chat session, and the chat view opens for it

#### Scenario: Missing authentication is refused
- **WHEN** the user submits the new-session form with the chat kind selected and the server has no usable Claude authentication
- **THEN** no session is created and the user receives an error explaining how to configure authentication

#### Scenario: Chat sessions coexist with terminal sessions
- **WHEN** chat sessions and terminal sessions exist at the same time
- **THEN** both are listed, selectable, and killable, chat sessions appear in the session list without a tmux window, and terminal session behavior is unchanged

#### Scenario: Nonexistent project directory is refused
- **WHEN** the user submits the new-session form with the chat kind selected and a project path that does not exist, is not a directory, or carries tmux's ` (deleted)` suffix for a removed directory
- **THEN** no session is created and the user receives an error naming the path and saying it is not an existing directory

#### Scenario: Home-relative project path is resolved
- **WHEN** the user creates a chat session with a project path such as `~/work/app`, resolved as for terminal sessions (`~` expanded, made absolute), that names an existing directory
- **THEN** the session is created with the absolute path of that directory as its project directory

#### Scenario: Project directory removed after creation
- **WHEN** the user sends a message to a chat session whose project directory no longer exists
- **THEN** no agent process is started, the message is refused with an error saying the project directory is missing and suggesting a new session in an existing directory, and the session and its history remain available

### Requirement: Conversation events stream to the chat view
The system SHALL stream conversation events for a chat session to connected
clients in order: the user's submitted turn, assistant text, tool activity,
and turn completion. The chat view SHALL render assistant text as markdown
and tool activity as compact activity entries. A client that attaches to an
existing chat session SHALL receive the recent window of the session's prior
conversation, with older history available on request.

#### Scenario: Message exchange streams end to end
- **WHEN** the user submits a message in the chat view
- **THEN** the user turn appears in the transcript, assistant text and tool activity stream in as they are produced, and the turn ends with a completion event

#### Scenario: Reconnect during a turn or pending request
- **WHEN** a client reconnects while output streams or an approval/question is pending
- **THEN** it receives a snapshot containing the history window, unfinished output, current status, and pending requests before subsequent live events, without lost or duplicated content

#### Scenario: Multiple clients answer the same request
- **WHEN** two clients answer the same pending request
- **THEN** only the first valid answer takes effect and all attached clients remove the resolved request

#### Scenario: Reconnect replays prior conversation
- **WHEN** a client attaches to a chat session that already has history (including after a page reload)
- **THEN** the recent window of the prior conversation is displayed before any new live events arrive

### Requirement: Tool approval requests surface as approval cards
When the agent requests a tool use that requires approval and the session's
approval policy is manual, the system SHALL present an approval card in the
chat view showing the tool and its arguments, and SHALL hold the agent until
the user answers. Allowing SHALL let the tool run; denying SHALL return the
denial to the agent so the turn continues. Resolution and cancellation SHALL
update every attached client, and only the first valid answer SHALL take
effect.

#### Scenario: Pending approvals survive disconnects, not restarts
- **WHEN** an approval stays pending across a browser disconnect, or across a server restart
- **THEN** the pending approval survives the disconnect until it is answered, cancelled by the SDK, interrupted, granted by switching the session to the auto policy, or the session is killed, while a server restart cancels outstanding requests rather than restoring callbacks that no longer exist

#### Scenario: Approval card with allow and deny
- **WHEN** the agent requests a tool use that requires approval in a session with the manual policy
- **THEN** an approval card with the tool name and arguments is shown, and no tool execution occurs before the user answers

#### Scenario: Allow executes the tool
- **WHEN** the user chooses Allow on a pending approval card
- **THEN** the tool use proceeds and its result streams into the conversation

#### Scenario: Deny returns the denial to the agent
- **WHEN** the user chooses Deny on a pending approval card
- **THEN** the tool use is not executed, the denial is reported to the agent, and the turn continues

### Requirement: Chat sessions have a per-session approval policy
Each chat session SHALL have an approval policy of either manual or auto.
A new chat session SHALL start with the policy supplied at its creation, or
manual when none is supplied. A session's profile SHALL NOT choose its policy.
The policy SHALL be stored with the session and SHALL be kept across server
restarts, conversation resume, archive, and restore. Sessions created before
this feature SHALL behave as manual.

#### Scenario: New chat starts manual
- **WHEN** a user creates a chat session with any profile and no approval policy supplied
- **THEN** the session's approval policy is manual and tool approvals show approval cards

#### Scenario: New chat starts with the supplied policy
- **WHEN** a user creates a chat session with the auto policy
- **THEN** the session's approval policy is auto and its tool uses are granted without approval cards

#### Scenario: Policy survives restart
- **WHEN** a chat session's policy is auto and the server restarts
- **THEN** the session is listed with the auto policy and its next tool approval is granted without a card

#### Scenario: Policy survives archive and restore
- **WHEN** a chat session with the auto policy is archived and later restored
- **THEN** the restored session still has the auto policy

#### Scenario: Legacy session defaults to manual
- **WHEN** the server loads a chat session stored before approval policies existed
- **THEN** the session's approval policy is manual

### Requirement: Users configure the default approval policy for new chat sessions
The system SHALL let the user choose, from Settings, the approval policy that chat sessions they create start with, and SHALL apply it at creation unless they override it in the New Session dialog. A chat created by `/clear`, `/reset`, or `/new` carries over the previous chat's policy. Settings SHALL say that spawned team members follow their group's `approval:` key and the team default instead. The stored default SHALL NOT change any existing session's policy.

#### Scenario: Settings default seeds new chats
- **WHEN** the user sets the default approval policy to auto and then creates a chat session
- **THEN** the session starts with the auto policy and its tool uses are granted without approval cards

#### Scenario: Creation dialog overrides the default
- **WHEN** the default approval policy is auto and the user creates a chat session with Auto-approve unchecked
- **THEN** the session starts with the manual policy

#### Scenario: The default does not touch existing sessions
- **WHEN** the user changes the default approval policy while chat sessions exist
- **THEN** every existing session keeps the policy it already had

#### Scenario: Unspecified policy creates a manual session
- **WHEN** a client creates a chat session without naming an approval policy
- **THEN** the session starts with the manual policy regardless of the stored default

#### Scenario: Settings names where spawned members get their policy
- **WHEN** the user opens the Approval Policy setting
- **THEN** its description says it covers chats the user creates, and that spawned team members use their group's `approval:` key, then the team default set on the Team page

### Requirement: Auto policy grants tool approvals without a card
While a chat session's policy is auto, the system SHALL grant each tool
approval request immediately without showing an approval card, and the
session SHALL NOT enter the permission status for it. Agent questions SHALL
NOT be answered by the policy: they SHALL always be shown as question forms,
answered only by the user or by the recommended-option timeout. Tool uses
denied by the user's Claude Code permission settings SHALL remain denied.

#### Scenario: Tool runs without a card
- **WHEN** the agent requests a tool use that requires approval in a session with the auto policy
- **THEN** no approval card is shown, the tool runs, and the session stays working rather than permission

#### Scenario: Questions still reach the user
- **WHEN** the agent asks a question in a session with the auto policy
- **THEN** the question form is shown, the session reports permission, and the agent waits for the user's answer or the question's auto-answer deadline

#### Scenario: Settings deny rules still apply
- **WHEN** the user's Claude Code settings deny a tool and the agent attempts it in a session with the auto policy
- **THEN** the tool use is denied as it would be under the manual policy

### Requirement: Users switch the approval policy from the chat view
The chat view SHALL let the user switch a live chat session between manual
and auto. The switch SHALL take effect for the next request without
restarting the agent, and every attached client SHALL see the new policy.
Switching to auto SHALL grant that session's pending approval cards; pending
questions SHALL stay open. Switching to manual SHALL affect only later
requests.

#### Scenario: Enabling auto clears pending approvals
- **WHEN** a session has a pending approval card and a pending question and the user switches it to auto
- **THEN** the approval is granted and its tool runs, the question remains open, and the agent process is not restarted

#### Scenario: Disabling auto returns to cards
- **WHEN** the user switches a session from auto to manual during a turn
- **THEN** tool uses already granted keep running and the next tool approval request shows an approval card

#### Scenario: Other clients see the switch
- **WHEN** two browsers are attached to the same chat session and one switches its policy
- **THEN** both show the new policy without a reload

### Requirement: Approval policy changes are validated
The system SHALL refuse a policy change for an unknown session, for an
archived session, or with a value other than manual or auto, and SHALL report
an error to the requesting client without changing the stored policy.
Archived chats SHALL NOT show the policy control.

#### Scenario: Archived session refuses a change
- **WHEN** a client requests a policy change for an archived chat session
- **THEN** the request is refused with an error and the stored policy is unchanged

#### Scenario: Unsupported value is refused
- **WHEN** a client requests a policy value that is not manual or auto
- **THEN** the request is refused with an error and the stored policy is unchanged

#### Scenario: Archived chat hides the control
- **WHEN** the user opens an archived chat session
- **THEN** the read-only view shows no approval-policy control

### Requirement: Auto-approved activity is visible
While a chat session's policy is auto, its chat view header SHALL show a
clearly distinguishable auto-approve indicator. Each tool use granted by the
policy SHALL be marked in the transcript as auto-approved, distinct from a
user's Allow, and each policy change SHALL add a transcript notice. Reconnecting
clients SHALL receive these entries in the history snapshot.

#### Scenario: Header indicates auto
- **WHEN** a chat session's policy is auto
- **THEN** its chat view header shows the auto-approve indicator, and the indicator disappears when the policy returns to manual

#### Scenario: Transcript distinguishes who approved
- **WHEN** one tool use is allowed by the user and another is granted by the auto policy
- **THEN** the transcript marks the second as auto-approved and the first as allowed by the user

#### Scenario: Policy change is recorded
- **WHEN** the user switches a session's policy
- **THEN** a notice stating the new policy appears in the transcript of every attached client and in the snapshot sent to clients that attach later

### Requirement: Agent questions collect structured user answers
The system SHALL handle SDK `AskUserQuestion` requests with question forms
supporting offered options, multiple selections where requested, and the
user's own text. A single-select answer SHALL be one option or the user's
own text, and an answer carrying both SHALL be refused; a multi-select
answer SHALL add that text as one more selection. Validated answers SHALL
be returned as updated tool input. Questions SHALL follow the same
reconnect, cancellation, and first-answer rules as approvals.

#### Scenario: User answers an agent question
- **WHEN** the agent requests user input through `AskUserQuestion`
- **THEN** the chat view displays the questions and the user's submitted answers are returned to the agent so it can continue

#### Scenario: Own text replaces a single-select option
- **WHEN** the user selects an option of a single-select question and then types their own answer
- **THEN** the option is deselected and the typed text is the answer sent to the agent

#### Scenario: Selecting an option replaces own text
- **WHEN** the user types their own answer to a single-select question and then selects an option
- **THEN** the text is cleared and the option is the answer sent to the agent

#### Scenario: Both for single-select is refused
- **WHEN** a client submits an option and non-empty text for one single-select question
- **THEN** the answer is refused with an error naming the question and the request stays pending

#### Scenario: Own text joins multi-select options
- **WHEN** the user checks two options of a multi-select question and types their own answer
- **THEN** the agent receives both options and the typed text as the answer

### Requirement: Users can interrupt an in-flight turn
The system SHALL let the user interrupt a chat session's in-flight turn.
After an interrupt, output produced so far SHALL remain in the transcript
and the session SHALL return to an idle state.

#### Scenario: Stop cancels pending requests
- **WHEN** the user activates stop while an approval or question is pending
- **THEN** outstanding callbacks settle, queued unsent messages are discarded, all clients remove cancelled requests, and the session becomes waiting

#### Scenario: Approval resolution updates status
- **WHEN** a pending request is resolved
- **THEN** status remains permission while another request is pending, becomes working if the turn continues with none pending, and becomes waiting when idle

#### Scenario: Stop button aborts a working turn
- **WHEN** the user activates stop while a turn is streaming
- **THEN** the turn is aborted, previously streamed content stays in the transcript, and the session becomes idle

### Requirement: Chat session status derives from conversation events
The system SHALL derive a chat session's status directly from its
conversation events and spawned workers: working while a turn is in flight
or while any spawned worker is running, permission while an approval is
pending, and waiting when idle — without parsing agent log
files. Status changes SHALL be broadcast through the existing session-update
mechanism.

#### Scenario: Turn in flight reports working
- **WHEN** a chat session's turn starts producing events
- **THEN** the session is reported as working in the session list

#### Scenario: Pending approval reports permission
- **WHEN** a chat session has an unanswered approval card
- **THEN** the session is reported as permission in the session list

#### Scenario: Idle session reports waiting
- **WHEN** a chat session's turn completes with no pending approval
- **THEN** the session is reported as waiting in the session list

#### Scenario: Background workers keep the session working
- **WHEN** a chat session's turn has completed but one or more spawned workers are still running
- **THEN** the session is reported as working in the session list

#### Scenario: Session returns to waiting when the last worker settles
- **WHEN** the last running worker of a chat session settles and no turn is in flight
- **THEN** the session is reported as waiting in the session list

#### Scenario: A worker that has left the running set does not hold the session
- **WHEN** a worker is no longer reported among the running work and has not yet reported its result, and no turn is in flight
- **THEN** the session is reported as waiting in the session list

#### Scenario: Composer accepts messages while workers run
- **WHEN** a chat session is reported as working only because spawned workers are running
- **THEN** the user can still submit a new message and the agent accepts it

### Requirement: Chat sessions persist across server restarts
When its SDK transcript remains available, the system SHALL keep a chat session usable across server restarts: after a
restart the session SHALL be listed with its prior conversation, and the
next user message SHALL continue the same underlying agent conversation.

#### Scenario: Restart continues the conversation
- **WHEN** the server restarts while a chat session exists and the user then sends a message
- **THEN** the message continues the same conversation, with prior history intact

#### Scenario: Resume history is unavailable
- **WHEN** a stored SDK session transcript is missing or the SDK cannot resume it
- **THEN** the stored session and SDK id remain intact, the user receives an actionable error to restore the transcript or explicitly create a new session, and no fresh conversation is started implicitly

#### Scenario: Restart while a request is pending
- **WHEN** the server restarts with an unanswered approval or question
- **THEN** the previous request is marked cancelled and any request produced on resume has a new request id

#### Scenario: Kill removes the session
- **WHEN** the user kills a chat session
- **THEN** the underlying agent process is terminated and the session leaves the session list

### Requirement: Chat transcripts are not double-counted as sessions
Chat sessions' agent transcripts SHALL NOT be discovered and listed as
separate sessions by the server's agent-log discovery, so one chat session
appears exactly once in the UI.

#### Scenario: Transcript file does not spawn a duplicate session
- **WHEN** a chat session produces an agent transcript on disk
- **THEN** log discovery does not surface that transcript as an additional active or external session

### Requirement: Chat sessions run against a configurable provider
The system SHALL let an operator define a provider environment — a set of
environment-variable overrides such as an API base URL and model names — that
is applied to every Claude Agent SDK process spawned for chat sessions,
including the availability check. When no provider environment is configured,
the SDK process SHALL inherit the server environment unchanged.

#### Scenario: Provider overrides reach the SDK process
- **WHEN** the operator configures a provider environment containing a base URL and model overrides and a user sends a message in a chat session
- **THEN** the SDK process for that session runs with the server environment plus those overrides, with the overrides taking precedence

#### Scenario: Nothing configured
- **WHEN** no provider environment is configured
- **THEN** chat sessions spawn the SDK process with the server environment exactly as before

#### Scenario: Availability is re-checked for a changed or failed provider
- **WHEN** the SDK availability check failed, or the provider environment changed since it last succeeded, and the user creates a chat session
- **THEN** the availability check runs again under the current provider environment instead of reusing the earlier result

### Requirement: Provider overrides do not reach terminal sessions
The provider environment SHALL apply only to chat sessions and SHALL NOT change
the environment of terminal (tmux) sessions.

#### Scenario: Terminal sessions are unaffected
- **WHEN** a provider environment is configured and the user starts a terminal session
- **THEN** the terminal session's environment does not contain the provider overrides

### Requirement: Chat authentication is checked against the provider environment
The chat authentication check SHALL evaluate credentials against the same
effective environment the SDK process receives: the server environment plus
the provider overrides.

#### Scenario: Credential supplied through the provider environment
- **WHEN** the server environment has no Claude credentials and the provider environment supplies an API key or auth token
- **THEN** chat session creation is allowed

### Requirement: Operators configure the chat provider from Settings
The system SHALL seed the provider environment from the `AGENTBOARD_CHAT_ENV`
server variable and SHALL let the user override it from the Settings modal.
A Settings override SHALL persist across server restarts and SHALL apply to
the next SDK process spawned, without a server restart. Clearing the override
SHALL restore the server-variable default.

#### Scenario: Settings override applies to the next spawn
- **WHEN** the user saves provider overrides in Settings and then starts a new chat session
- **THEN** the new session's SDK process receives the saved overrides

#### Scenario: Clearing the override restores the default
- **WHEN** the user clears the provider overrides in Settings
- **THEN** the persisted override is removed and the provider environment falls back to `AGENTBOARD_CHAT_ENV`

### Requirement: Invalid provider entries are refused
The system SHALL refuse a Settings save containing an invalid entry with an
error rather than silently dropping the entry.

#### Scenario: Invalid entry refused
- **WHEN** the user saves an entry whose name is not a valid environment variable name
- **THEN** nothing is saved and Settings shows why

### Requirement: Provider credentials are not sent to the browser
Values of credential-like provider variables SHALL NOT be sent to the browser.
Saving without re-entering such a value SHALL keep the stored value.

#### Scenario: Credentials are not sent to the browser
- **WHEN** the provider environment contains a credential such as `ANTHROPIC_AUTH_TOKEN` and the user opens Settings
- **THEN** the variable is listed without its value, and saving other edits keeps the stored credential

### Requirement: Users can archive a chat session
The system SHALL let a user archive a chat session from the chat view header and from the session's row in the navigator. Archiving SHALL stop the session's agent process and keep the session record, its conversation ID, its transcript, and its protocol log. Archiving SHALL be recorded durably and SHALL survive server restarts. Every attached client SHALL see the change.

#### Scenario: Archive an idle chat
- **WHEN** the user archives a chat session that has no turn in flight
- **THEN** the agent process is stopped, the session is marked archived for every attached client, and its conversation remains available

#### Scenario: Archive during a turn asks first
- **WHEN** the user archives a chat session while a turn is in flight
- **THEN** the system asks for confirmation, and on confirmation interrupts the turn, cancels pending approvals and questions for every attached client, and archives the session

#### Scenario: Archive is cancelled
- **WHEN** the user declines the confirmation for archiving a chat with a turn in flight
- **THEN** the turn continues and the session is not archived

#### Scenario: Archived state survives a restart
- **WHEN** the server restarts while a chat session is archived
- **THEN** the session is still listed as archived and no agent process is started for it

### Requirement: Archived chats open read-only without starting an agent
The system SHALL display an archived chat session's prior conversation read-only, with a Restore action and without a message composer, stop control, or pending-request actions. Opening, attaching to, or reconnecting to an archived chat session MUST NOT start an agent process. Messages sent to an archived chat session SHALL be refused with an error.

#### Scenario: Open an archived chat
- **WHEN** the user selects an archived chat session
- **THEN** its prior conversation is displayed with a Restore action, no composer is offered, and no agent process is started

#### Scenario: Message sent to an archived chat
- **WHEN** a client sends a message to an archived chat session
- **THEN** no agent process is started and the client receives an error saying the session is archived

### Requirement: Users can restore an archived chat session
The system SHALL let a user restore an archived chat session from the read-only chat view and from the session's row in the navigator. A restored session SHALL behave as before it was archived: the next message continues the same conversation.

#### Scenario: Restore and continue
- **WHEN** the user restores an archived chat session and then sends a message
- **THEN** the session is no longer archived for every attached client, the composer is offered, and the message continues the same conversation with prior history intact

### Requirement: Archived chats are kept until restored or killed
Archived chat sessions SHALL NOT be hidden or removed by the history lookback window. Kill SHALL remain available for archived chat sessions and SHALL remain the only action that permanently removes a chat session.

#### Scenario: Archived chat older than the lookback window
- **WHEN** a chat session was archived longer ago than the configured history lookback
- **THEN** it is still listed among archived sessions

#### Scenario: Kill an archived chat
- **WHEN** the user kills an archived chat session
- **THEN** the session, its record, and its protocol log are removed and it leaves the session list

### Requirement: Assistant markdown renders with visible formatting
The chat view SHALL render assistant text as formatted content, not as plain
text. Block and inline markdown elements and GitHub-flavored markdown
extensions SHALL each be visually distinct from body text. Single line breaks
inside a paragraph SHALL be preserved. Raw HTML in assistant text SHALL NOT be
rendered or executed. User messages SHALL keep their literal text.

#### Scenario: Block elements are formatted
- **WHEN** assistant text contains a heading, a bulleted list, a numbered list, a blockquote, a horizontal rule and a fenced code block
- **THEN** the heading is larger or bolder than body text, list items show bullets or numbers and are indented, the blockquote is visually set off, the rule is visible, and the code block appears in a monospace block whose whitespace is preserved and whose wide lines scroll horizontally instead of overflowing the transcript

#### Scenario: Inline elements are formatted
- **WHEN** assistant text contains bold, italic, inline code and a link
- **THEN** bold and italic are visibly emphasized, inline code is visually distinct from surrounding text, and the link is visibly a link that opens in a new browser tab without giving the opened page access to the chat window

#### Scenario: GitHub-flavored markdown is supported
- **WHEN** assistant text contains a pipe table, `~~strikethrough~~`, a task list and a bare URL
- **THEN** the table renders as a bordered table with a header row, the strikethrough text is struck through, task list items show checkboxes, the bare URL is a link, and no raw `|` or `~~` syntax is visible

#### Scenario: Single line breaks are kept
- **WHEN** assistant text contains two lines separated by a single newline
- **THEN** they render on separate lines

#### Scenario: Raw HTML stays inert
- **WHEN** assistant text contains raw HTML such as a `<script>` tag
- **THEN** no script runs and no element is created from that HTML

#### Scenario: User messages are not reformatted
- **WHEN** the user sends a message that contains markdown syntax
- **THEN** the user's turn shows the literal text with its whitespace preserved

#### Scenario: Chat and session preview render markdown the same way
- **WHEN** the same markdown text appears as an assistant message in the chat view and in the session log preview
- **THEN** both render the same elements with the same styling in proportion to their base text size, so the chat follows the chat font size while the preview keeps its own size

### Requirement: Chat view uses a reduced-glare dark palette
In the dark theme, the chat view SHALL render on a lifted dark-gray background
with off-white text instead of the app's near-black palette. Primary message
text SHALL have a contrast ratio between 7:1 and 10:1 against the chat
background. Secondary text SHALL have at least 4.5:1 against every chat
surface it appears on. The light theme and views outside the chat view SHALL
be unchanged.

#### Scenario: Assistant and user messages in the dark theme
- **WHEN** the dark theme is active and the chat view shows user and assistant messages
- **THEN** the transcript background is a dark gray rather than near-black, and message text measures between 7:1 and 10:1 contrast against it

#### Scenario: Secondary text stays readable on every chat surface
- **WHEN** role labels, tool-activity summaries, notices or the session header details appear on the chat background, inside the user-message bubble, or on an approval or question card
- **THEN** that text measures at least 4.5:1 contrast against the surface behind it

#### Scenario: Status and error colors follow the palette
- **WHEN** the chat view shows an error, or the Debug panel lists outgoing, incoming, stderr and lifecycle frames
- **THEN** each of these colors comes from the chat palette, stays distinguishable from the others, and measures at least 4.5:1 contrast against the chat background

#### Scenario: Primary actions remain legible
- **WHEN** the chat view shows a primary button such as Send, Allow, Submit answers or Restore
- **THEN** its label measures at least 4.5:1 contrast against the button background

#### Scenario: Rest of the app keeps its dark palette
- **WHEN** the dark theme is active and the user looks at the session navigator, a terminal session or a modal while a chat session is open
- **THEN** those areas keep the app's existing dark colors

#### Scenario: Light theme is unchanged
- **WHEN** the light theme is active and the user opens a chat session
- **THEN** the chat view uses the app's existing light colors

### Requirement: Chat text uses a readable, adjustable size
The chat view SHALL size its text from a chat font size independent of the
terminal font size and the rest of the app. The chat font size SHALL default
to 15px and be adjustable from Settings between 12px and 20px. Message bodies
SHALL render at the chat font size, and secondary text SHALL render at no less
than 0.8 of it. The setting SHALL persist across reloads.

#### Scenario: Default size is readable
- **WHEN** a user who has never changed the chat font size opens a chat session
- **THEN** user and assistant message bodies render at 15px and role labels, tool calls, notices and the turn footer render at 12px or larger

#### Scenario: User changes the chat font size
- **WHEN** the user sets the chat font size to 18px in Settings and saves
- **THEN** chat message bodies, formatted assistant markdown, approval and question cards, and the composer scale to the new size, and the setting is still 18px after a page reload

#### Scenario: Chat and terminal sizes are independent
- **WHEN** the user changes the chat font size
- **THEN** the terminal font size, terminal rendering and the session log preview are unchanged, and changing the terminal font size leaves chat text unchanged

#### Scenario: Out-of-range values are clamped
- **WHEN** the user tries to go below 12px or above 20px, or the stored value is out of range or not a number
- **THEN** the chat font size is limited to 12–20px, and a non-numeric stored value falls back to 15px

#### Scenario: Composer does not trigger mobile zoom
- **WHEN** the chat font size is below 16px and the user focuses the composer on a touch device
- **THEN** the composer text is at least 16px, so the browser does not zoom the page

### Requirement: Tool-call paths are shown relative to the project
When a tool handle is a file path, the chat view SHALL show it relative
to the chat session's project directory if the path is inside that
directory, and SHALL show it unchanged otherwise. Trailing slashes on either
the path or the project directory SHALL NOT affect the result. Paths that
only share a name prefix with the project directory SHALL count as outside.

#### Scenario: Path inside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo/src/index.ts`
- **THEN** the label reads `Read(src/index.ts)`

#### Scenario: Path outside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/etc/hosts`
- **THEN** the label reads `Read(/etc/hosts)`

#### Scenario: Sibling directory with a shared prefix
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo-other/a.ts`
- **THEN** the label reads `Read(/repo-other/a.ts)`

#### Scenario: Path equal to the project directory
- **WHEN** the project directory is `/repo` or `/repo/` and a path handle is `/repo` or `/repo/`
- **THEN** the handle shows `.` in all four combinations

### Requirement: Chat transcript shows the in-flight turn's activity
While a chat turn is in flight, the chat view SHALL show one activity row as the last entry of the transcript, naming what the agent is doing and how long it has been in that phase. The phases are: waiting for the model, thinking, preparing a tool's input, running a tool, and retrying an API request. The elapsed time SHALL count up live without new server messages.

#### Scenario: Waiting for the first token
- **WHEN** the user sends a message and the model has not yet produced any content
- **THEN** the transcript ends with a row reading "Waiting for model…" and an elapsed time that increases each second

#### Scenario: Model is thinking
- **WHEN** the model starts a thinking block
- **THEN** the activity row reads "Thinking…" and its elapsed time restarts from zero

#### Scenario: Tool input is being written
- **WHEN** the model starts a tool-use block whose input is still streaming
- **THEN** the activity row names that tool as being prepared, for example "Writing Edit input…"

#### Scenario: A tool is running
- **WHEN** a tool call has been shown and its result has not yet arrived
- **THEN** the activity row reads "Running <tool>…" with the time since that phase began

#### Scenario: Several tools are running
- **WHEN** more than one tool call of the turn is awaiting its result
- **THEN** the activity row reads "Running <n> tools…"

#### Scenario: API request is retried
- **WHEN** Claude Code reports an API retry with an attempt number, a maximum, and an error status
- **THEN** the activity row reads "Retrying (<attempt>/<max>, <status>)…"

#### Scenario: Turn ends
- **WHEN** the turn completes, is interrupted, or the agent process dies
- **THEN** no activity row is shown

### Requirement: Activity row yields to other visible progress
The chat view SHALL hide the activity row while assistant text is streaming, while an approval or question card awaits the user, and in archived or otherwise read-only chats. The row SHALL return when the turn enters another activity phase.

#### Scenario: Text is streaming
- **WHEN** the model is streaming assistant text
- **THEN** no activity row is shown below the streaming text

#### Scenario: Approval card pending
- **WHEN** a tool approval or agent question awaits the user
- **THEN** no activity row is shown, and after the user answers the row resumes with the next phase

#### Scenario: Archived chat
- **WHEN** the user opens an archived chat
- **THEN** no activity row is shown

### Requirement: Activity is live-only and restored on reconnect
Activity SHALL be ephemeral: it is not part of the conversation history, is not persisted, and does not change the session-list status. A client attaching or reconnecting during a turn SHALL receive the current activity phase and its start time so the row and elapsed time resume.

#### Scenario: Reconnect while thinking
- **WHEN** a client reconnects to a chat whose turn has been thinking for 10 seconds
- **THEN** the transcript ends with "Thinking…" showing roughly 10 seconds elapsed

#### Scenario: History has no activity rows
- **WHEN** a chat with completed turns is reopened or replayed from history
- **THEN** the transcript contains no activity rows

#### Scenario: Session list is unaffected
- **WHEN** a turn moves between activity phases
- **THEN** the session list still reports the session as working and receives no additional updates for the phase changes

### Requirement: The agent starts when a chat is opened
The system SHALL start a chat session's agent process, without sending a prompt, when a client attaches to the session and no process is running for it. Attaching MUST NOT start a process for an archived chat session or for a session whose project directory no longer exists. A start that fails SHALL be reported to attached clients as a session error and SHALL NOT remove the session or its history.

#### Scenario: Open a chat after a server restart
- **WHEN** a client attaches to an unarchived chat session with no running agent process
- **THEN** the agent process starts and resumes the stored conversation, and no message is sent to the agent

#### Scenario: Open an archived chat
- **WHEN** a client attaches to an archived chat session
- **THEN** no agent process is started

#### Scenario: Project directory is missing
- **WHEN** a client attaches to a chat session whose project directory no longer exists
- **THEN** no agent process is started and sending a message is refused as before

#### Scenario: Several clients attach
- **WHEN** two clients attach to the same chat session at the same time
- **THEN** at most one agent process is started for it

### Requirement: Clients receive the chat's slash commands
The system SHALL provide each attached client with the slash commands the session's agent reports, each with its name, description, argument hint, aliases, and whether it is defined by the project or user. The list SHALL have a loading, ready, or unavailable state, be part of the reconnect snapshot, and be replaced for every attached client when the agent reports a changed list. Commands bound to a terminal and internal commands SHALL NOT be included.

#### Scenario: List is ready after opening
- **WHEN** a client attaches to a chat session and the agent finishes starting
- **THEN** the client receives the session's command list in the ready state

#### Scenario: List changes mid-session
- **WHEN** the agent reports a changed command list
- **THEN** every attached client replaces its list with the new one

#### Scenario: Reconnect restores the list
- **WHEN** a client reconnects to a chat session whose command list is ready
- **THEN** the snapshot it receives includes the list

#### Scenario: Agent could not start
- **WHEN** the agent process for a chat session failed to start or is not running
- **THEN** the command list is in the unavailable state and typed messages, including slash commands, can still be submitted

#### Scenario: Terminal-only commands are hidden
- **WHEN** the agent reports commands that are bound to a terminal or are internal
- **THEN** those commands are not included in the list sent to clients

### Requirement: The composer offers a slash-command menu
The chat composer SHALL open a command menu while the caret is in a word that starts with `/` at the start of the message or after whitespace, filtering the session's commands by that word against names and aliases first and descriptions second. The menu SHALL be operable by keyboard and pointer. Choosing a command SHALL replace that word with `/<name> ` without sending and SHALL show the command's argument hint. The menu SHALL indicate when the list is loading and SHALL NOT block sending.

#### Scenario: Filter and choose by keyboard
- **WHEN** the user types `/re` and presses Enter while a matching command is highlighted
- **THEN** the composer contains `/<chosen name> `, the argument hint is shown, and no message is sent

#### Scenario: Open in the middle of a message
- **WHEN** the composer contains `please run ` and the user types `/re` after it
- **THEN** the menu opens and lists the commands matching `re`

#### Scenario: Open at the start of a later line
- **WHEN** the composer contains a first line and the user types `/` at the start of the second line
- **THEN** the menu opens and lists all commands

#### Scenario: Choose in the middle of a message
- **WHEN** the composer contains `please run /re on this` with the caret just after `/re` and the user chooses a command
- **THEN** the composer contains `please run /<chosen name> on this`, the caret sits just after `/<chosen name> `, the argument hint is shown, and no message is sent

#### Scenario: A slash inside a word or path does not open the menu
- **WHEN** the caret follows `and/or`, `https://example`, or `/usr/bin`
- **THEN** the menu stays closed

#### Scenario: Moving the caret away closes the menu
- **WHEN** the menu is open for a `/` word and the user moves the caret out of that word or selects text
- **THEN** the menu closes, and it opens again when the caret returns into a `/` word

#### Scenario: Dismiss the menu
- **WHEN** the menu is open and the user presses Escape
- **THEN** the menu closes and the composer text is unchanged

#### Scenario: Send while the menu has no match
- **WHEN** the typed command matches no listed command and the user presses Enter
- **THEN** the menu does not intercept Enter and the message is sent as typed

#### Scenario: A command in the middle of a message is sent as typed
- **WHEN** the user sends `please run /clear later`
- **THEN** the message is sent to the agent as typed and no new chat is created

#### Scenario: List still loading
- **WHEN** the user types `/` before the command list is ready
- **THEN** the menu shows that commands are loading

### Requirement: The slash-command menu marks the selected option
The slash-command menu SHALL visually distinguish the currently selected option from the other options, and SHALL visually distinguish a pointer-hovered option from the menu surface. The selection mark SHALL follow keyboard navigation (Up/Down) and pointer hover so the option that Tab or Enter will insert is always the one that looks selected. The mark SHALL be built from theme tokens so it stays visible in the light theme and in the chat palette.

#### Scenario: Selection follows the arrow keys
- **WHEN** the slash-command menu is open with more than one match and the user presses Down then Up
- **THEN** the visual selection mark moves to the next option and then back, and only one option carries the mark at a time

#### Scenario: The first option starts selected
- **WHEN** the menu opens or the composer text changes so the match list is recomputed
- **THEN** the first matching option carries the selection mark

#### Scenario: Hover differs from the menu surface
- **WHEN** the pointer moves over an option that is not the selected one
- **THEN** that option is visually distinguished from the menu background

#### Scenario: Tab inserts the marked option
- **WHEN** the user moves the selection with the arrow keys and presses Tab
- **THEN** the composer contains the marked option's `/<name> ` and the menu closes

### Requirement: Local command output appears in the transcript
The system SHALL show output produced by a local slash command in the transcript of the turn that ran it, and SHALL include it in reconnect snapshots and replayed history.

#### Scenario: Run a local command
- **WHEN** the user sends a local command such as `/context`
- **THEN** its output appears in the transcript and the turn completes

#### Scenario: Reload after a local command
- **WHEN** a client attaches to a chat session after a local command ran in it
- **THEN** the command and its output appear in the replayed conversation

### Requirement: Replayed history shows slash commands as typed
Replayed chat history SHALL show a slash-command turn as the command and arguments the user typed, and SHALL NOT show the markup Claude Code records around commands or the expanded prompt text of a command.

#### Scenario: Reload after a project command
- **WHEN** a client attaches to a chat session in which the user ran `/openspec-explore some idea`
- **THEN** the replayed user turn shows `/openspec-explore some idea` and no command markup

### Requirement: Clearing a chat starts a new chat and archives the old one
Sending `/clear`, `/reset`, or `/new`, optionally followed by a name, SHALL create a new chat session in the same project directory, with the same profile and the same approval policy, named with the given name when present, select it, and then archive the previous chat session. The command SHALL NOT be sent to the agent. If the new session cannot be created, the previous chat session SHALL remain unchanged and the user SHALL receive the creation error.

#### Scenario: Clear a chat
- **WHEN** the user sends `/clear` in a chat session
- **THEN** a new chat session with the same project directory and profile is created and selected, and the previous session is archived with its conversation intact

#### Scenario: The approval policy carries over
- **WHEN** the user sends `/new` in a chat session whose approval policy is auto
- **THEN** the new chat session starts with the auto policy and grants tool uses without approval cards

#### Scenario: New chat with a name
- **WHEN** the user sends `/new release notes`
- **THEN** the new chat session is named `release notes`

#### Scenario: New chat cannot be created
- **WHEN** the user sends `/clear` and the new chat session cannot be created
- **THEN** the previous chat session is not archived and the user sees why creation failed

### Requirement: New-session dialog preselects Claude Code chat
The new-session dialog SHALL preselect the chat kind when it opens, so
creating a Claude Code chat session needs no kind switch. Entry points that
open the dialog for a specifically terminal purpose — the OpenSpec change
section actions that offer the terminal-only first-prompt selector — SHALL
preselect the terminal kind instead. The dialog SHALL recalculate the
preselected kind from the current entry point at every open, regardless of
how any previous open ended.

#### Scenario: Dialog opens with chat preselected
- **WHEN** the user opens the new-session dialog from the header button or the keyboard shortcut
- **THEN** the session-kind selector shows Claude Code chat as the selected value, the profile selector is visible, and no command presets are shown

#### Scenario: Change-section entry point preselects terminal
- **WHEN** the user opens the new-session dialog from an OpenSpec change section action
- **THEN** the session-kind selector shows Terminal as the selected value and the first-prompt selector is visible

#### Scenario: Reopening follows the same rule
- **WHEN** the user closes the dialog, having switched the kind to Terminal, and reopens it outside a change section
- **THEN** the session-kind selector shows Claude Code chat again

#### Scenario: Entry point switches between opens
- **WHEN** the user closes the dialog opened from a generic entry point and reopens it from an OpenSpec change section, or the reverse
- **THEN** each open preselects the kind of its own entry point — Terminal for the change section and Claude Code chat for the generic one

### Requirement: Switching session kind preserves form entries
When the user changes the session kind in the new-session dialog, the
project path, display name, and any entries made for the previously
selected kind SHALL be retained, and the newly selected kind's fields SHALL
appear with their own defaults.

#### Scenario: Kind switch keeps path and name
- **WHEN** the user enters a project path and display name, then switches the session kind
- **THEN** the project path and display name remain as entered and the fields of the newly selected kind are shown

### Requirement: Chat composer drafts are kept per session

The chat view SHALL keep unsubmitted composer input as per-session draft state. A session's draft SHALL be preserved while its chat remains available in the client, and each chat's composer SHALL show only that session's draft. Drafts SHALL be client-side state only: they SHALL survive WebSocket reconnects but SHALL NOT be sent to the server or restored after a page reload.

#### Scenario: Draft survives switching to another chat and back
- **WHEN** the user types text into chat A's composer without submitting, switches to chat B, and switches back to chat A
- **THEN** chat A's composer shows the previously typed text and chat B's composer showed chat B's own draft, not chat A's

#### Scenario: Each chat keeps its own draft
- **WHEN** the user types different unsubmitted text into chats A and B
- **THEN** switching between A and B shows each chat's own text in its composer

#### Scenario: Submitting clears only that chat's draft
- **WHEN** the user submits the message typed in chat A while chat B has an unsubmitted draft
- **THEN** chat A's composer is empty and chat B's draft is unchanged

#### Scenario: Removing a session discards its draft
- **WHEN** a chat session with an unsubmitted draft is killed and removed
- **THEN** its draft is discarded and does not reappear

#### Scenario: Draft survives a WebSocket reconnect
- **WHEN** the connection drops and reconnects while a chat has an unsubmitted draft
- **THEN** the draft remains in that chat's composer after reconnect

#### Scenario: Draft survives archive and restore
- **WHEN** a chat with an unsubmitted draft is archived and later restored
- **THEN** the restored chat's composer shows the pre-archive draft

#### Scenario: Drafts are not restored after a page reload
- **WHEN** the page is reloaded after typing an unsubmitted draft
- **THEN** the chat's composer is empty

### Requirement: Users can rename a chat session
The system SHALL let a user rename a chat session from the navigator and from the chat view header. A rename SHALL update the stored session name and SHALL be visible to every attached client without a reload. Renaming SHALL be refused with an error for an unknown session or for a name that is empty after trimming, and SHALL NOT change the session's conversation or status.

#### Scenario: Rename from the navigator
- **WHEN** the user submits a new name for a chat session from its navigator row
- **THEN** the session list shows the new name and the session's conversation and status are unchanged

#### Scenario: Rename from the chat view header
- **WHEN** the user submits a new name for a chat session from its chat view header
- **THEN** the header and every session list show the new name

#### Scenario: Attached clients see the rename
- **WHEN** a chat session is renamed while another client has it open
- **THEN** that client shows the new name without reloading

#### Scenario: Empty name is refused
- **WHEN** the user submits a name that is empty after trimming
- **THEN** no rename is applied and the client receives an error saying the name cannot be empty

#### Scenario: Unknown session is refused
- **WHEN** a rename is submitted for a session that does not exist
- **THEN** no rename is applied and the client receives an error

### Requirement: Chat session names allow free text
A chat session's name SHALL accept any text that is non-empty after trimming, including spaces and punctuation. Chat names SHALL NOT be restricted to the character set allowed for terminal session names and SHALL NOT be required to be unique among sessions.

#### Scenario: A generated title with spaces and punctuation is accepted
- **WHEN** a chat session is given a name containing spaces and punctuation, such as `Claude Code Chat subscription usage metrics spec`
- **THEN** the name is accepted and stored as given

#### Scenario: Duplicate chat names are allowed
- **WHEN** two chat sessions are given the same name
- **THEN** both retain that name and neither is refused or made unique

### Requirement: A user-set name is never replaced by a generated title
The system SHALL keep a chat session's name once the user has set it, whether it was entered at creation or set by a later rename. A title generated by the agent MUST NOT replace a user-set name, regardless of whether the generated title arrives before or after the user set the name.

#### Scenario: Name entered at creation is kept
- **WHEN** a chat session is created with a user-supplied name and the agent later generates a title for it
- **THEN** the session keeps the user-supplied name

#### Scenario: Rename after adopting a generated title is kept
- **WHEN** a chat session has adopted a generated title, the user renames it, and the agent generates another title afterwards
- **THEN** the session keeps the user's rename

#### Scenario: A name supplied before this feature is kept
- **WHEN** a chat session created before this feature carries a name the system's placeholder generator could not have produced, such as `show-chat-rate-limits`, and the agent generates a title for it
- **THEN** the session keeps its pre-existing name

### Requirement: A generated title replaces a placeholder name
When a chat session's name has not been set by the user, the system SHALL adopt a title generated by the agent as the session's name once one is available, so the session does not keep an initial generated placeholder name.

#### Scenario: Placeholder name is replaced
- **WHEN** a chat session was created without a user-supplied name and the agent generates a title
- **THEN** the session's name becomes that title in every session list

#### Scenario: A placeholder name from before this feature is replaced
- **WHEN** a chat session created before this feature carries a name the system's placeholder generator could have produced, such as `sure-mark`, and its conversation carries a generated title
- **THEN** the session adopts that generated title as its name

### Requirement: A generated title keeps updating a name the user has not set
While a chat session's name has not been set by the user, the system SHALL replace it whenever the agent generates a later title for the same conversation.

#### Scenario: A later generated title is adopted
- **WHEN** a chat session whose name came from a generated title has not been renamed by the user, and the agent generates a new title
- **THEN** the session's name becomes the newer title

#### Scenario: The updated name is visible without opening the chat
- **WHEN** an unclaimed chat session's name changes to a newer generated title
- **THEN** session lists show the newer title even for sessions the user has not opened

### Requirement: A chat session's name and its user-set status persist
A chat session's name and whether the user set it SHALL be kept across server restarts, archive, and restore.

#### Scenario: Name survives a restart
- **WHEN** the server restarts
- **THEN** every chat session is listed with the name it had before the restart, and a later generated title does not replace a name the user had set

#### Scenario: Name survives archive and restore
- **WHEN** a chat session is archived and later restored
- **THEN** it keeps the same name and the same user-set status

### Requirement: Tool activity is one entry per tool use
The chat view SHALL render each tool use as a single transcript entry,
pairing its tool call and tool result by their shared tool-call id. A tool
call SHALL NOT appear as its own entry alongside a separate result entry.
Expanding the entry SHALL show the tool input, and the tool output beneath it
once a result has arrived.

#### Scenario: Call and result share one entry
- **WHEN** the transcript contains a tool call and a later tool result with the same tool-call id
- **THEN** they render as one collapsed entry, and no standalone result entry appears

#### Scenario: Expand shows input then output
- **WHEN** the user expands an entry whose result has arrived
- **THEN** the tool input is shown first and the tool output beneath it

#### Scenario: Pending call shows the input alone
- **WHEN** a tool call has been streamed but its result has not arrived
- **THEN** the entry renders and expands to the input alone

#### Scenario: Result without a matching call still renders
- **WHEN** the transcript contains a tool result whose tool-call id matches no earlier tool call
- **THEN** the chat view still renders one entry for it and the entry expands to the output

### Requirement: Collapsed tool entries show a short handle
The chat view SHALL label each collapsed tool entry `<toolName>(<handle>)`,
where the handle is a one-line value derived from the tool's input. An entry
with no usable handle SHALL show the tool name alone. Long handles SHALL be
truncated visually with an ellipsis, with the full value on hover.

#### Scenario: Label shows the tool name and its handle
- **WHEN** a tool call has a usable handle
- **THEN** the collapsed entry reads `<toolName>(<handle>)`

#### Scenario: No usable handle keeps the bare name
- **WHEN** a call is to an unknown tool, or every part of a known tool's handle is unusable
- **THEN** the collapsed entry reads the tool name with no parentheses

#### Scenario: Multi-line value stays on one line
- **WHEN** a handle value contains line breaks, such as a multi-line Bash command
- **THEN** the collapsed label shows it on a single line, truncated with an ellipsis when too long, and hovering shows the full value

### Requirement: Tool handles come from the tool's input
Each known tool's handle SHALL be the value of its designated input field,
and an entry whose designated value is entirely unusable SHALL show the tool
name alone.

#### Scenario: Known tools show their designated field
- **WHEN** a call is to `Read`, `Write`, `Edit` or `NotebookEdit` (path); `Glob` or `Grep` (pattern); `WebFetch` (url); `WebSearch` or `ToolSearch` (query); `Agent`, `Task` or `Monitor` (description); `Skill` (skill); `TaskCreate` (subject); `TaskStop` or `TaskOutput` (task_id); or `ExitPlanMode` (planFilePath)
- **THEN** the handle is that field's value

#### Scenario: EnterWorktree shows its path or name
- **WHEN** an `EnterWorktree` call has a non-blank `path`, or only a non-blank `name`
- **THEN** the handle is the path, or the name when no path is usable

#### Scenario: TaskUpdate shows the task id and status
- **WHEN** a `TaskUpdate` call has a `taskId` and a `status`
- **THEN** the handle is `Task <taskId> → <status>`

#### Scenario: AskUserQuestion shows the question header
- **WHEN** an `AskUserQuestion` call's first question has a non-blank `header`
- **THEN** the handle is the header, suffixed with ` · <n> questions` when the call has more than one question

#### Scenario: No usable field keeps the bare name
- **WHEN** every part of a known tool's designated value is missing, blank or not a string
- **THEN** the collapsed entry reads the tool name with no parentheses

### Requirement: Bash shows its description with a command fallback
A Bash call's handle SHALL be its `description`, falling back to its
`command` when the description is missing, blank or not a string. The handle
SHALL NOT compose the description and the command.

#### Scenario: Bash shows its description
- **WHEN** a `Bash` call has a non-blank `description`
- **THEN** the handle is the description

#### Scenario: Bash falls back to its command
- **WHEN** a `Bash` call's `description` is missing, blank or not a string, and its `command` is a non-blank string
- **THEN** the handle is the command

#### Scenario: Bash does not compose description and command
- **WHEN** a `Bash` call has both a non-blank `description` and a non-blank `command`
- **THEN** the handle is the description alone, with no part of the command

### Requirement: A failed tool use is marked on its entry
When a tool use's result is an error, the chat view SHALL mark the collapsed
entry with `✗`. A result that is not an error SHALL carry no status mark.

#### Scenario: Error result is marked
- **WHEN** a tool use's result is an error
- **THEN** the collapsed entry shows `✗` alongside the label

#### Scenario: Successful result carries no mark
- **WHEN** a tool use's result is not an error
- **THEN** the collapsed entry shows no status mark

### Requirement: Chat session path follows the agent's working directory
After creation, a chat session's associated project path SHALL track the
agent's working directory: when that directory changes, the session's path
SHALL update to the new directory and every attached client SHALL see the
update. The creation path is only the starting directory; later
working-directory changes replace it for navigator grouping, the project
badge, project filters, workspace discovery, and any later (re)start of the
agent.

#### Scenario: Agent enters a worktree
- **WHEN** a live chat session's agent moves its working directory into a discovered Git worktree
- **THEN** the session's associated project path becomes that worktree directory and the left menu moves the session into the matching worktree or change section

#### Scenario: Agent leaves a worktree
- **WHEN** a live chat session's agent moves its working directory out of a worktree into another directory
- **THEN** the session's associated project path becomes that directory and the left menu moves the session to the section derived from it

#### Scenario: Chat started in a worktree
- **WHEN** a chat session is created with a worktree as its project path
- **THEN** its associated project path is that worktree and the left menu shows the session under that worktree's section

#### Scenario: Update survives restart
- **WHEN** the agent's working directory has changed and the server later restarts and resumes the session
- **THEN** the session's project path is the most recent working directory, not the original creation path

#### Scenario: Archived chat keeps its last path
- **WHEN** a chat session whose agent changed working directory is archived
- **THEN** the archived session keeps the most recent working directory as its project path and still appears in `Archive`

### Requirement: Chat views show distance to auto-compaction
The chat view header SHALL show how much of the session's auto-compaction
budget the conversation has used, as a percentage together with the used and
auto-compaction-threshold token counts. The reading SHALL be absent until the
session has produced a model request, rather than showing a zero reading.

#### Scenario: Meter appears after the first model request
- **WHEN** a chat session completes its first model request
- **THEN** the chat view header shows the used token count, the auto-compaction-threshold token count, and the percentage of that threshold in use

#### Scenario: No meter before any model request
- **WHEN** a chat session has not yet produced a model request
- **THEN** the chat view header shows no context meter

#### Scenario: Conversation reset returns the meter to absent
- **WHEN** a running conversation is reset (plan-mode clear-context, a fresh session, or onboarding) after a context usage has been reported
- **THEN** the chat view header shows no context meter again, and a later server restart does not restore the reading the discarded conversation had

#### Scenario: Meter coexists with header chrome
- **WHEN** a chat view is open for a live session that has produced a model request
- **THEN** the context meter is shown beside the session status and the profile, project path, and session controls remain present

### Requirement: Context usage tracks the conversation as it grows
The reported used-token count SHALL follow the conversation's prompt size as
the turn proceeds, updating when each new model request's usage is observed,
so the reading moves during a long turn and not only at turn completion.

#### Scenario: Reading grows during a multi-step turn
- **WHEN** a turn makes several model requests in sequence, each with a larger prompt than the last
- **THEN** the reported used-token count rises after each request rather than only when the turn completes

#### Scenario: Reading is the current prompt, not cumulative traffic
- **WHEN** a turn has made many model requests so the session's cumulative token counts far exceed the window
- **THEN** the reported used tokens stay within the session's context window and describe the latest request's prompt size

#### Scenario: Usage reported only at the end of a request's stream
- **WHEN** a session's provider reports zero usage when a model request starts and reports the request's real token counts only in that request's final stream update, as GLM profiles do
- **THEN** the reported used-token count comes from those final counts, and a context meter shows for the session once a threshold is known, rather than staying empty

#### Scenario: A partial final update does not lower the reading
- **WHEN** a model request's start already reported its input and cache token counts and its final stream update carries only the output token count
- **THEN** the reported used-token count keeps the start's input and cache counts plus the final output count, and does not drop to the output count alone

#### Scenario: Subagent requests do not move the reading
- **WHEN** a subagent spawned by the session streams its own model requests, including final usage updates
- **THEN** the session's reported used-token count is unchanged by them

### Requirement: Compaction resets the reported context usage
When the agent compacts the conversation and the post-compaction size is
known, the system SHALL report that size at the moment the compaction is
signalled, so the meter drops alongside the compaction notice rather than
waiting for the next model request. When the post-compaction size is not
known, the system SHALL retain the previous reading.

#### Scenario: Meter drops when the conversation auto-compacts
- **WHEN** a running conversation reaches its auto-compaction threshold and auto-compaction summarises it, and the post-compaction size is known
- **THEN** the reported context usage falls to the post-compaction size when the compaction is signalled to the chat view

#### Scenario: Manual compaction drops the meter too
- **WHEN** the conversation is compacted explicitly rather than by auto-compaction, and the post-compaction size is known
- **THEN** the reported context usage falls to the post-compaction size in the same way

#### Scenario: Compaction metadata without a post-compaction size keeps the prior reading
- **WHEN** a compaction is signalled with metadata that carries no usable post-compaction size
- **THEN** the reported context usage retains its previous value, and no zero, undefined, or placeholder reading is published

#### Scenario: Compaction with no metadata keeps the prior reading
- **WHEN** a compaction is signalled with no compaction metadata at all
- **THEN** the reported context usage retains its previous value in the same way

### Requirement: Context usage is measured against the auto-compaction threshold
The percentage and threshold token count SHALL use the session's
auto-compaction threshold — the used-token count at which its conversation
would be compacted — rather than the model's full context window, so a
session nearing compaction reports a high percentage.

#### Scenario: Autocompact reserve is excluded from the threshold
- **WHEN** a session whose context window is 200000 tokens holds a 33000-token autocompact reserve and has 157900 tokens in use
- **THEN** its threshold token count reads 167000 and its percentage reads about 95 rather than the 79 that the full window would give

#### Scenario: Smaller configured window overrides the model window
- **WHEN** a chat session runs under a profile that configures a 100000-token auto-compaction window on a 200000-token model
- **THEN** its threshold token count derives from the configured 100000-token window rather than the model's 200000 tokens, and a used count at that threshold reads about 100 percent rather than 50

#### Scenario: Larger configured window overrides the model window
- **WHEN** a chat session runs under a profile that configures a 1000000-token auto-compaction window on a 200000-token model
- **THEN** its threshold token count derives from the configured 1000000-token window rather than the model's 200000 tokens

#### Scenario: An approximate threshold is labelled as one
- **WHEN** a session's threshold must come from the model's context window, or from a configured window with no observed autocompact reserve, because no context-usage report has shown the real reserve
- **THEN** the reading is marked as approximate and the meter says so, so it is not taken for an observed threshold

#### Scenario: A later report replaces the approximation
- **WHEN** a session that was metered against an approximate threshold later produces a context-usage report that reveals the reserve
- **THEN** the reading is recalculated against the observed auto-compaction threshold and is no longer marked approximate

### Requirement: Context usage survives restarts and archives
The latest context usage SHALL be stored with the chat session and kept
across server restarts, conversation resume, archive, and restore. A restored
session SHALL show its last known reading. An archived session SHALL show its
final reading as history and SHALL NOT refresh it.

#### Scenario: Reading survives server restart
- **WHEN** a chat session has reported a context usage and the server restarts before the next model request
- **THEN** the chat view shows the stored reading rather than an empty meter

#### Scenario: Archived chat keeps its final reading
- **WHEN** a chat session is archived after producing a context usage
- **THEN** opening the archived chat shows that reading and no later update

#### Scenario: Reading survives restore
- **WHEN** an archived chat session is restored
- **THEN** it shows its stored reading and the next model request updates it

### Requirement: Chat views show the session's current model
The chat view header SHALL show the model the agent reports for the session,
as session metadata delivered with the session's turns. The display SHALL be
absent until the agent first reports a model, rather than showing a
placeholder or the profile's configured model.

#### Scenario: Model appears with the first turn
- **WHEN** a chat session that has not yet run a turn receives the agent's session metadata naming its model
- **THEN** the chat view header shows that model

#### Scenario: No model before the agent reports one
- **WHEN** a chat session has not yet received session metadata naming a model
- **THEN** the chat view header shows no model

#### Scenario: Model coexists with header chrome
- **WHEN** a chat view is open for a live session that has reported a model
- **THEN** the model is shown beside the session status and the profile, project path, context meter, and session controls remain present

#### Scenario: Archived chat shows its last model
- **WHEN** an archived chat session had reported a model before archiving
- **THEN** opening the archived chat shows that model and no later update

### Requirement: The displayed model follows mid-session changes
The displayed model SHALL be the latest one the agent reports, so a model
change made during the session (such as a `/model` switch) replaces the
displayed model once the agent reports metadata for a subsequent turn.

#### Scenario: Model switch updates the display
- **WHEN** the user switches the session's model mid-conversation and the next turn's session metadata names the new model
- **THEN** the chat view header shows the new model in place of the previous one

#### Scenario: Reconnect sees the latest model
- **WHEN** a client reconnects to a session whose model changed after the client last saw it
- **THEN** the reconnected client shows the latest model

### Requirement: The current model survives restarts and archives
The latest reported model SHALL be stored with the chat session and kept
across server restarts, conversation resume, archive, and restore. A restored
session SHALL show its last known model until the agent reports one again.

#### Scenario: Model survives server restart
- **WHEN** a chat session has reported a model and the server restarts before the next turn
- **THEN** the chat view shows the stored model rather than no model

#### Scenario: Model survives restore
- **WHEN** an archived chat session is restored
- **THEN** it shows its stored model and the next reported model updates it

### Requirement: Turns the agent starts on its own are shown
When the agent starts a turn without a user message, such as after a
background task ends or a Monitor reports an event, the system SHALL show
that turn in the transcript like any other: streamed output, tool
activity, approvals, and a completion. When the trigger names its cause,
the turn SHALL open with a line naming that trigger instead of a user
message; a trigger without a usable cause SHALL open with no trigger
line. The session SHALL report `working` until the turn ends.

#### Scenario: Background completion wakes the agent
- **WHEN** a background task ends while the chat is idle and the agent starts a turn in response
- **THEN** the transcript shows a trigger line with the task's summary, followed by the agent's streamed output and tool activity

#### Scenario: Agent-started turn reports working
- **WHEN** the agent starts a turn on its own
- **THEN** the session is reported as `working` until that turn completes, then returns to `waiting`

#### Scenario: Agent-started turn can be interrupted
- **WHEN** the user presses Stop during a turn the agent started on its own
- **THEN** the turn is interrupted exactly as a user-started turn would be

#### Scenario: Replayed history shows the trigger, not raw markup
- **WHEN** a client attaches to a chat whose history contains a turn the agent started because a background task ended
- **THEN** the turn opens with the same trigger line, and no user message bubble with notification markup is shown

#### Scenario: Trigger without a known cause
- **WHEN** the agent starts a turn on its own with no usable trigger cause: no task notification preceded it, or the trigger's task list is empty
- **THEN** no trigger line is shown; the turn opens directly with its own output, the turn's boundary and layout stay as before, and the session still reports `working`

### Requirement: Chat messages show authors and local timestamps
Live and archived Chat messages SHALL display an author and local time beside each message, with full date, time, and timezone available on hover and to assistive technology. User, assistant, and peer identities SHALL remain distinguishable; peer authors SHALL retain their existing participant links. Missing or invalid historical times SHALL be omitted rather than replaced with the current time.

#### Scenario: Message metadata
- **WHEN** a user, assistant, or peer message has a valid timestamp
- **THEN** its author and local time are visible and its full date, time, and timezone are available on hover and to assistive technology

#### Scenario: Historical timestamp is unavailable
- **WHEN** a historical message has no valid recorded time
- **THEN** its author remains visible and no fabricated timestamp appears

#### Scenario: Conversation spans multiple days
- **WHEN** consecutive dated messages cross a local calendar-day boundary
- **THEN** a visible date separator distinguishes the days

#### Scenario: Undated message between days
- **WHEN** an undated historical message sits between dated messages on different local days
- **THEN** one date separator appears before the first message of the later day, and the undated message neither adds nor suppresses a separator

#### Scenario: Peer identity remains actionable
- **WHEN** a peer message previously offered navigation to its sender
- **THEN** its author retains that navigation and the message retains its sender group, priority, tags, and origin path

### Requirement: Message time remains stable during streaming and replay
A message's displayed time SHALL represent its recorded start and remain stable as its text streams and finalizes. A reconnect served from the running server SHALL keep the live start; history replay SHALL show the earliest transcript record time of that message, which may trail the live start. Times SHALL NOT be derived from the browser's render or attach time.

#### Scenario: Streaming response
- **WHEN** an assistant response receives more text and its final message
- **THEN** its displayed time remains the time of its first recorded content

#### Scenario: Reconnect to a running server
- **WHEN** a client reconnects while the server that streamed the messages is still running
- **THEN** messages keep the start times shown live, in the client's local timezone

#### Scenario: History replay
- **WHEN** a Chat's history is replayed after a server restart or opened archived
- **THEN** each message shows the earliest recorded transcript time for it in the client's local timezone, never the replay or attach time

### Requirement: Response text keeps its order around tool calls
Text an agent writes before and after a tool call within one response SHALL appear as separate transcript entries in event order, each with its own author and start time, live and after replay.

#### Scenario: Text, tool, text in one response
- **WHEN** one assistant response writes text, calls a tool, then writes more text
- **THEN** the transcript shows the first text, the tool call, then the second text, and neither text replaces the other

#### Scenario: Replayed response keeps its order
- **WHEN** the same Chat's history is replayed
- **THEN** the two texts and the tool call appear in the same order as live

### Requirement: Chat transcript aligns content responsively
Chat transcripts SHALL use an author/time gutter beside aligned message bodies when their container is wide enough. Narrow containers SHALL place author/time metadata above the body. Author changes SHALL have quiet visual separators; related same-author output SHALL use tighter spacing without merging distinct messages or hiding their timestamps.

#### Scenario: Wide transcript
- **WHEN** the transcript has room for a metadata gutter and readable message bodies
- **THEN** user, assistant, and peer bodies share a content alignment, with authors and times in the gutter

#### Scenario: Narrow transcript or larger font
- **WHEN** the transcript container narrows or the chat font grows until the gutter would crowd the body
- **THEN** metadata moves above the body and the transcript requires no horizontal scrolling except within content such as code blocks

#### Scenario: Author changes and continuations
- **WHEN** adjacent messages change author or continue the same author's response
- **THEN** author changes are visually separated and continuations are more closely spaced, while every message's identity and time remain identifiable

### Requirement: Transcript layout preserves rich event information and controls
The redesigned transcript SHALL retain all previously displayed event information and interactions in live and archived Chats. Layout grouping SHALL preserve event order, tool call/result pairing, and access to detailed content. Existing archive restrictions on interactive controls SHALL continue to apply.

#### Scenario: Tools and background activity
- **WHEN** the transcript contains tools, errors, workers, or background tasks
- **THEN** expandable inputs and outputs, failure marks, worker details, task outcomes and output tails, and eligible Stop controls remain available

#### Scenario: Peer context and notices
- **WHEN** peer messages carry task context, revision notices, duplicate warnings, threads, or handoff information
- **THEN** all previously displayed context and disclosures remain available

#### Scenario: Turn and request information
- **WHEN** a Chat contains command output, notices, errors, autonomous-turn triggers, request decisions, interruptions, or completion summaries
- **THEN** their existing information remains visible, including completion subtype, cost, and turn counts when supplied; a generic unknown-cause turn-trigger line is the one exception and stays hidden

#### Scenario: Live interaction
- **WHEN** an active Chat streams text or awaits an approval or answer
- **THEN** streaming, activity indicators, approval and question cards, and composer actions continue to work with their existing visibility rules

#### Scenario: Archived Chat
- **WHEN** the same Chat is archived
- **THEN** the transcript keeps its metadata and detail disclosures, while live request and task Stop actions remain unavailable and Restore remains available

### Requirement: Composer editing stays responsive in long conversations
The chat composer SHALL display edits and respond to caret and slash-command interactions without waiting for unchanged conversation history to be processed again. Growing conversation history SHALL NOT add history-proportional work to an edit when the history has not changed. This SHALL apply while the chat is idle and while new output arrives.

#### Scenario: Type in a long idle conversation
- **WHEN** the user types, deletes, pastes, or moves the caret in a connected chat with hundreds of prior messages and no incoming events
- **THEN** the composer reflects each edit and caret interaction without reprocessing the unchanged history
- **AND** history remains available with its existing formatting and expanded disclosures

#### Scenario: Use slash commands with a long history
- **WHEN** the user opens, filters, navigates, and chooses from the slash-command menu in a chat with hundreds of prior messages
- **THEN** the menu and caret respond without reprocessing unchanged history
- **AND** choosing a command inserts it without sending a message

#### Scenario: Edit while output streams
- **WHEN** new assistant output arrives while the user edits an unsubmitted draft in a long conversation
- **THEN** the draft retains the user's edits, focus, and selection while new output appears in order
- **AND** incoming output does not cause unchanged assistant message bodies to be processed again merely to update a different message

#### Scenario: Submit after editing a long conversation
- **WHEN** the user submits the edited draft in a connected chat with hundreds of prior messages
- **THEN** the submitted text follows the existing message or local-command behavior
- **AND** only the submitting session's draft is cleared

### Requirement: Attaching delivers the recent history window
On attach, the system SHALL deliver only the turns that started within the 24 hours ending at the session's newest dated event, and at least the newest turn. Turns SHALL NOT be split. Pending requests, unfinished output, activity, and rosters SHALL be delivered whatever their age. The snapshot SHALL state whether older history exists. This SHALL apply to live and archived chats.

#### Scenario: Long-running session opens on its last day
- **WHEN** a client attaches to a chat whose conversation spans five days and whose newest event is from now
- **THEN** the transcript shows only the turns that started in the last 24 hours, and the top of the transcript offers to load earlier messages

#### Scenario: Idle session still opens on its last work
- **WHEN** a client attaches to a chat whose newest event is three days old
- **THEN** the transcript shows the turns that started in the 24 hours before that event, not an empty transcript

#### Scenario: A turn that began before the window is kept whole
- **WHEN** a turn started 25 hours before the newest event and its tool results arrived within the last 24 hours
- **THEN** the turn is either delivered whole or left wholly to older history, and no tool entry is shown without its call or result

#### Scenario: Short conversation has no older history
- **WHEN** a client attaches to a chat whose whole conversation lies within the window
- **THEN** the whole conversation is shown and no control to load earlier messages is offered

#### Scenario: Old pending request is still shown
- **WHEN** an approval requested 30 hours ago is still pending at attach
- **THEN** its approval card is shown even though its turn lies before the window

### Requirement: Users load earlier history on request
While older history exists, the top of the transcript SHALL offer a control to load earlier messages. Each use SHALL prepend the 24 hours before the oldest loaded turn, and at least one turn, without moving the entries the user is reading. The control SHALL show progress while loading, SHALL be disabled while disconnected, and SHALL be replaced by a start-of-conversation marker once nothing older remains.

#### Scenario: Load one more day
- **WHEN** the user activates the load-earlier control in a chat with a week of history
- **THEN** the turns of the preceding 24 hours appear above the previously oldest entry, and the entry the user was looking at stays where it was on screen

#### Scenario: Reaching the beginning
- **WHEN** the user loads earlier messages until the first turn of the conversation is shown
- **THEN** the control is replaced by a marker stating that this is the beginning of the conversation

#### Scenario: Gap in activity
- **WHEN** the 24 hours before the oldest loaded turn contain no turns but older turns exist
- **THEN** one use of the control still loads at least the next older turn

#### Scenario: Disconnected
- **WHEN** the connection to the server is lost
- **THEN** the load-earlier control is disabled until the connection returns

### Requirement: The history window moves only when a chat is opened
Entries SHALL NOT be removed from a transcript while it is shown. A reconnect while a chat is shown SHALL keep every entry it showed. Opening a chat (selecting it again or reloading the page) SHALL recompute the recent window at that moment, except that within the same page load a chat where the user loaded earlier history SHALL reopen from the oldest turn the user had loaded. Live events SHALL follow every snapshot without loss or duplication.

#### Scenario: Open chat stays put for days
- **WHEN** a chat stays shown for three days while its agent keeps working
- **THEN** new entries append at the bottom and no entry disappears from the top

#### Scenario: Reconnect while shown
- **WHEN** the connection drops and returns while a chat is shown
- **THEN** the transcript shows every entry it showed before, plus anything that arrived meanwhile, with no duplicated entries

#### Scenario: Reopening slides the window
- **WHEN** the user switches away from a chat that was shown for three days without loading earlier messages and later selects it again
- **THEN** it opens on the turns of the last 24 hours, with the load-earlier control offered

#### Scenario: Reopening keeps history the user loaded
- **WHEN** the user loaded two earlier days of a chat, switched to another chat, and selects it again without reloading the page
- **THEN** it opens from the oldest turn the user had loaded

#### Scenario: Reload starts from the recent window
- **WHEN** the user reloads the page after loading earlier messages
- **THEN** the chat opens on the recent window with the load-earlier control offered

### Requirement: A result marked as an error completes the turn as failed
A turn SHALL count as failed when its result's subtype is not `success` or the result is marked as an error. A failed turn SHALL show an error in the transcript that names the terminal reason when one is given. Every reader of turn success SHALL treat it as failed: mail outcomes, turn-end records, turn usage, and process metrics.

#### Scenario: Success subtype with an error flag
- **WHEN** a result arrives with subtype `success`, `is_error: true`, text `Prompt is too long`, and terminal reason `blocking_limit`
- **THEN** the turn completes as failed, and the transcript shows an error naming `Prompt is too long` and `blocking_limit`

#### Scenario: Turn-end record
- **WHEN** such a turn ends in a task-bound session
- **THEN** its turn-end record marks it not successful

#### Scenario: Older history
- **WHEN** a stored turn completion has no error flag
- **THEN** it reads as before, by its subtype

### Requirement: Turn completion records the terminal reason
A completed turn SHALL carry the agent's terminal reason when the result gives one, so the transcript, the session's records, and recovery can read why it ended.

#### Scenario: Reason recorded
- **WHEN** a turn ends with terminal reason `max_turns`
- **THEN** its completion carries `max_turns`

### Requirement: Replayed history marks API error replies
Replay of a stored conversation SHALL show an assistant reply that the agent recorded as an API error as an error row, not as an ordinary assistant message.

#### Scenario: Reloaded exhausted turn
- **WHEN** a chat whose last reply was a recorded `Prompt is too long` API error is replayed after restart
- **THEN** that reply shows as an error row

### Requirement: Sessions show the context-exhausted flag
A flagged session SHALL carry the flag, with its time and reason, in the session list. The navigator row SHALL show a badge, and the chat header SHALL show a row stating that the context is exhausted and that `/compact` or a new session is needed. Both SHALL disappear when the flag clears.

#### Scenario: Header row
- **WHEN** the human opens a flagged chat
- **THEN** the header states the context is exhausted with its reason, and suggests `/compact` or a new session

#### Scenario: Flag clears
- **WHEN** the session reports a compaction boundary
- **THEN** the badge and the header row disappear

### Requirement: Explicit recommendation wording identifies an option
The system SHALL recognize `recommended`, `I recommend this`,
`I recomend this`, and `my recommendation` in option labels or descriptions
using the marker positions below. Matching SHALL ignore case, collapse
whitespace, and allow surrounding brackets, parentheses, Markdown emphasis,
and punctuation. Negated or incidental mentions SHALL NOT qualify; explicit
negation in either field SHALL exclude the option.

#### Scenario: Supported marker positions
- **WHEN** a supported phrase occupies an entire label or description, starts it followed by punctuation and explanation, or forms a trailing annotation separated from preceding text by brackets or a dash/colon at the field start or after whitespace
- **THEN** it qualifies as a recommendation, including the existing trailing `(Recommended)` convention

#### Scenario: Recommendation in an option description
- **WHEN** option `A` has description `I recommend this. It is easier to maintain.`, every question has a recommended option, and the wait is positive
- **THEN** the request gets a deadline and its automatic answer selects the original label `A`

#### Scenario: Informal markers and the observed typo qualify
- **WHEN** an option label or description is `I recomend this`, `[MY RECOMMENDATION]`, or `  I   recommend this!  `, or the label is `A — My recommendation`
- **THEN** the option qualifies as recommended and can supply its question's automatic answer

#### Scenario: Negated or conflicting recommendations do not qualify
- **WHEN** an option's only signal is `Not recommended`, `Not-recommended`, `Non-recommended`, `I do not recommend this`, `I don't recommend this`, `I never recommend this`, or `This is not my recommendation`, or its label is `A (Recommended)` but its description is `Not-recommended`, or a hyphen ends a word inside a phrase such as `Least-recommended`
- **THEN** that option does not qualify and a question with no other qualifying option prevents a deadline for the entire request

#### Scenario: Incidental mentions and unrelated fields do not qualify
- **WHEN** an option only says `Review my recommendation`, `Uses the recommended settings`, or `A (Recommended) only in a different situation`, or a marker appears only in question text or preview
- **THEN** that option does not qualify and a question with no other qualifying option keeps the entire request waiting for the user

#### Scenario: Mixed markers preserve selection order and labels
- **WHEN** multiple options qualify through different label or description markers, including an option with a marker in both fields
- **THEN** single-select chooses the first matching option in input order, multi-select chooses all matching options once each, and the selected labels are returned verbatim

#### Scenario: Only option labels and descriptions supply a signal
- **WHEN** an option has no matching label and its description is missing or non-string, or a recommendation appears only in option order, question text, preview, or surrounding conversation
- **THEN** no recommendation is inferred for that option

### Requirement: Recommended answers are taken after a configurable wait
When every question in a pending Claude chat request has a recommended
option and the wait is positive, the system SHALL set a deadline at request
time plus the wait. Unless an answer, hold, cancellation, or interruption
settles it first, the server SHALL answer with all recommended options for
multi-select or the first in input order for single-select, using verbatim
labels and selecting each option once.

#### Scenario: Unanswered question takes the recommendation
- **WHEN** the agent asks one single-select question with options `A (Recommended)` and `B`, the wait is 5 minutes, and nobody answers for 5 minutes
- **THEN** the request is answered with `A (Recommended)`, the agent continues, and the session leaves the permission status

#### Scenario: User answers before the deadline
- **WHEN** the user submits `B` before the deadline
- **THEN** the agent receives `B` and no automatic answer is ever sent for that request

#### Scenario: Question without a recommendation keeps waiting
- **WHEN** a request has two questions and only one of them has a recommended option
- **THEN** no deadline is set and the request waits for the user as before

#### Scenario: A Codex chat question waits for the user
- **WHEN** a Codex chat session asks a question whose options include a recommended one
- **THEN** no deadline is set and the question waits for the user as before

#### Scenario: Multi-select takes every recommendation
- **WHEN** a multi-select question marks two options as recommended and its deadline passes
- **THEN** the answer selects both recommended options

#### Scenario: Applies under either approval policy
- **WHEN** a session with the manual policy and one with the auto policy each ask a question with a recommended option
- **THEN** both questions get a deadline

#### Scenario: Cancelled request is never auto-answered
- **WHEN** a request with a deadline is cancelled by an interrupt, the turn ending, archive, kill, or server shutdown before the deadline
- **THEN** no automatic answer is sent and its deadline is discarded

### Requirement: The agent learns an answer was automatic
An automatic answer SHALL be returned to the agent as the chosen option
labels, together with a note stating that the user did not answer within the
wait and the recommended option was selected automatically, so the agent can
treat the choice as unconfirmed.

#### Scenario: Agent sees the automatic note
- **WHEN** a question is answered by its deadline
- **THEN** the tool result the agent receives names the selected option and states that it was chosen automatically after no user answer

### Requirement: Question forms show the auto-answer deadline
A question form with a deadline SHALL show the option(s) that will be chosen
and a countdown to the deadline, and SHALL offer **Wait for me**, which
removes the deadline for that request only; the request then waits for the
user. Selecting an option or typing in the form SHALL hold the deadline the
same way. A hold SHALL reach every attached client, and the deadline or its
removal SHALL be included for clients that attach later.

#### Scenario: Countdown is visible
- **WHEN** a question with a deadline is pending
- **THEN** its form shows the recommended option that will be chosen and the remaining time

#### Scenario: Wait for me removes the deadline
- **WHEN** the user chooses Wait for me on a pending question
- **THEN** every attached client stops showing the countdown and the question is never answered automatically

#### Scenario: Starting an answer holds the deadline
- **WHEN** the user selects an option or types in a question form with a deadline, without submitting
- **THEN** the deadline is removed for every attached client and the user's unsubmitted answer is never replaced by an automatic one

#### Scenario: Late attach sees the deadline
- **WHEN** a client attaches while a question with a deadline is pending
- **THEN** the form shows the same deadline the other clients show

#### Scenario: Hold on a settled request is refused
- **WHEN** a client sends Wait for me for a request that is no longer pending
- **THEN** the client receives an error and nothing changes

### Requirement: Automatic answers are marked in the transcript
The transcript SHALL mark a question answered by its deadline as answered
automatically with the selected option(s), distinct from a user's answer and
from a policy grant, and SHALL record a hold. Reconnecting clients SHALL
receive these entries in the history snapshot.

#### Scenario: Transcript distinguishes automatic answers
- **WHEN** one question is answered by the user and another by its deadline
- **THEN** the transcript marks the second as answered automatically with its recommended option and the first as answered by the user

### Requirement: Users configure the auto-answer wait from Settings
Settings SHALL let the user set the auto-answer wait in whole minutes from 0
to 1440, default 5, where 0 disables automatic answers. The value SHALL be
stored on the server, kept across restarts, and applied to questions asked
after the change; a pending question keeps its deadline. An out-of-range or
non-integer value SHALL be refused with an error and nothing saved.

#### Scenario: Default wait is five minutes
- **WHEN** the wait was never saved and the agent asks a question with a recommended option
- **THEN** its deadline is five minutes after the question

#### Scenario: Zero disables automatic answers
- **WHEN** the user saves a wait of 0 and the agent then asks a question with a recommended option
- **THEN** no deadline is set and the question waits for the user

#### Scenario: Change does not move pending deadlines
- **WHEN** the user changes the wait while a question with a deadline is pending
- **THEN** that question keeps its deadline and the next question uses the new wait

#### Scenario: Invalid wait is refused
- **WHEN** the user saves a wait of 1441 or -1
- **THEN** nothing is saved and Settings shows why

### Requirement: Agent starts load history without blocking the server
When a chat agent starts, whether from a user message, an explicit start, or a mail delivery, the system SHALL load the chat's history without blocking other requests, whatever the history's size. The history shown afterwards SHALL be the same as before this requirement: the conversation up to the start, followed by the live events, with no turn shown twice.

#### Scenario: Mail delivery to a chat with a very large history
- **WHEN** mail is delivered to an idle chat whose history file holds more than a gigabyte
- **THEN** the server keeps answering other requests while the history loads, and the message reaches the agent once the load completes

#### Scenario: A message sent while the history is loading
- **WHEN** the user sends a message to a chat whose history is still loading for another start
- **THEN** the message waits for that same load, the agent starts once, and the transcript shows the earlier conversation once, followed by the new turn

#### Scenario: History is unchanged
- **WHEN** a chat's history is loaded for an agent start
- **THEN** the transcript shows the same rows, in the same order and with the same ids, as a full read of the history file would give
