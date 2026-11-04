# Spec Delta

## ADDED Requirements

### Requirement: Transcript messages can be copied as their original text
Each user, assistant, and peer message row in a chat transcript SHALL offer a copy control. The control SHALL place that row's original text on the clipboard exactly as received: an assistant row's Markdown source, a user row's literal text, a peer row's message body. It SHALL NOT copy rendered text or row metadata. The control SHALL be available in live and archived chats and in nested worker transcripts.

#### Scenario: Assistant Markdown is copied as source
- **WHEN** an assistant row shows a heading, a bulleted list, a fenced code block, a pipe table, and a link, and the user activates its copy control
- **THEN** the clipboard holds the row's Markdown source character for character, including `#`, list markers, code fences, `|` table syntax, and `[text](url)` link syntax

#### Scenario: User message is copied literally
- **WHEN** the user activates the copy control on their own message
- **THEN** the clipboard holds that message's text exactly as sent, without the author label, the time, or any workspace-context line

#### Scenario: Peer message copies its body only
- **WHEN** the user activates the copy control on a peer message that carries tags, an origin path, task context, and an earlier thread
- **THEN** the clipboard holds only the peer message body

#### Scenario: Each assistant row copies its own text
- **WHEN** one assistant reply appears as two rows separated by a tool call, and the user copies the second row
- **THEN** the clipboard holds only the second row's text

#### Scenario: Streaming message
- **WHEN** an assistant row is still streaming and the user activates its copy control
- **THEN** the clipboard holds the text that row shows at that moment

#### Scenario: Archived chat
- **WHEN** the user opens an archived chat
- **THEN** its message rows offer the same copy control and it copies the same text as in a live chat

#### Scenario: Aside rows have no copy control
- **WHEN** the transcript shows tool calls, notices, errors, turn lines, and command output
- **THEN** those rows show no message copy control

### Requirement: Message copy control is accessible and unobtrusive
The copy control SHALL be a keyboard-reachable button whose accessible name says it copies the message. On devices that can hover, it SHALL be visible while its row is hovered or holds focus. On touch devices it SHALL always be visible. Showing it SHALL NOT shift the row's layout.

#### Scenario: Keyboard user
- **WHEN** a keyboard user tabs through the transcript
- **THEN** each message row's copy control receives focus, becomes visible, and is named as a copy-message action

#### Scenario: Pointer hover
- **WHEN** a mouse user hovers a message row and then moves away
- **THEN** that row's copy control appears while hovered and hides again, and the row's text does not move

#### Scenario: Touch device
- **WHEN** the transcript is shown on a device without hover
- **THEN** every message row's copy control is visible without a hover

### Requirement: Message copy reports its outcome
After a copy attempt, the control SHALL confirm success for about two seconds and SHALL report a failure when the browser refuses clipboard access. Both outcomes SHALL be announced to assistive technology. Copying SHALL work when Kawai is served over plain HTTP, where the asynchronous clipboard API is unavailable.

#### Scenario: Successful copy
- **WHEN** the clipboard write succeeds
- **THEN** the control shows and announces "Copied", then returns to its normal state after about two seconds

#### Scenario: Clipboard refused
- **WHEN** both the asynchronous clipboard API and the fallback copy fail
- **THEN** the control shows and announces "Copy failed", the clipboard is left unchanged, and the transcript keeps working

#### Scenario: Insecure context
- **WHEN** Kawai is opened over plain HTTP on a non-localhost address and the user copies a message
- **THEN** the message text still reaches the clipboard and the control shows "Copied"
