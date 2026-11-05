# Codex chat autocomplete delta

## ADDED Requirements

### Requirement: Codex skills populate the chat command list
A live Codex chat SHALL offer enabled skills reported by its agent for its current working directory through the existing command list and slash menu. Only skills with a valid name and path and an unambiguous name SHALL be offered. Discovery SHALL use that chat's Codex home. Client-local command names SHALL remain reserved.

#### Scenario: Opening a Codex chat discovers skills
- **WHEN** a client attaches to a Codex chat and its agent reports enabled skills for the chat's working directory
- **THEN** the command list becomes ready with those skills' names, descriptions, and project, user, or builtin source as appropriate, without starting a model turn

#### Scenario: Skills excluded from the list
- **WHEN** discovery reports disabled skills, malformed entries, conflicting paths for one name, or skills named clear, reset, or new
- **THEN** those skills are absent from the command list and cannot be resolved by slash name

#### Scenario: No skills installed
- **WHEN** discovery succeeds for the current working directory with no eligible skills
- **THEN** the list is ready and empty

### Requirement: Codex autocomplete uses the shared composer interactions
The Codex composer SHALL offer the existing caret-aware slash menu, including filtering by name and description, keyboard and pointer selection, visible selection, and Escape dismissal. Choosing a skill SHALL replace the current slash word with `/<name> ` without sending. Unknown commands SHALL remain sendable as plain text.

#### Scenario: Choose a skill in the middle of a message
- **WHEN** the user types `please run /exp on this` with the caret after `/exp` and chooses the explore skill with Tab or Enter
- **THEN** the composer contains `please run /explore on this`, the caret follows the inserted space, and no message is sent

#### Scenario: Pointer selection and dismissal
- **WHEN** the user hovers and clicks a Codex skill in the menu, then opens the menu again and presses Escape
- **THEN** clicking inserts the visibly selected skill without sending and Escape closes the reopened menu without changing the draft

#### Scenario: Paths and unknown names
- **WHEN** the user types `https://example` or `/usr/bin`, or sends an unknown `/missing` command
- **THEN** paths do not open the menu and the unknown command is sent unchanged without a skill attachment

### Requirement: Human slash-skill references invoke explicit Codex skills
On human submission, the system SHALL attach one native Codex skill input per distinct eligible exact slash-skill reference in the message, resolved from the server's current ready catalog. The text SHALL remain unchanged in submission and history. References SHALL be whole whitespace-delimited words anywhere in the message. Peer envelopes SHALL NOT acquire skill attachments from their text.

#### Scenario: Invoke a completed or manually typed skill
- **WHEN** the user sends `please /explore this` and explore is eligible in the current ready catalog
- **THEN** Codex receives the unchanged text and an explicit skill input with explore's reported name and path, whether the user chose the menu or typed the reference

#### Scenario: Repeated and multiple skills
- **WHEN** the user sends `/explore /review /explore` and both names are eligible
- **THEN** Codex receives the unchanged text and exactly one skill input for each name in first-reference order

#### Scenario: A reference no longer resolves
- **WHEN** the user submits a draft containing a skill that is absent from the current ready catalog, or discovery is loading or unavailable
- **THEN** the message is sent unchanged without attaching that skill or waiting for discovery

#### Scenario: Exact reference boundaries
- **WHEN** explore is eligible and the human sends `x/explore /explore/more /explore, /Explore`
- **THEN** none of those words attaches explore

#### Scenario: Peer mail and history
- **WHEN** peer mail contains `/explore`, or a human skill turn is reloaded from history
- **THEN** peer delivery adds no skill input and replay shows the human text as submitted without skill-file content or synthetic user messages

### Requirement: Codex command discovery refreshes without interrupting chat
The catalog SHALL refresh on agent start or resume, a working-directory change, and a skill-change notification. Refresh SHALL clear outdated candidates, show loading, then publish ready or unavailable to every attached client and reconnect snapshot. Failed discovery SHALL NOT fail a turn. Results from an old process, directory, or superseded refresh SHALL NOT replace current state.

#### Scenario: Skills change while attached
- **WHEN** the agent announces changed skills
- **THEN** all attached clients see loading with no old candidates, followed by the refreshed ready list or unavailable on failure

#### Scenario: Working directory changes during a request
- **WHEN** the chat changes from directory A to B before A's discovery completes
- **THEN** the chat discovers B's skills and A's late response cannot restore A's list

#### Scenario: Unsupported or failed discovery
- **WHEN** discovery is unsupported, malformed, times out, or fails
- **THEN** the catalog becomes unavailable and ordinary messages still run without waiting for or failing because of discovery

#### Scenario: Agent ends and restarts
- **WHEN** the agent ends with discovery pending and later restarts or resumes
- **THEN** its list becomes unavailable, late replies are ignored, and the new agent independently discovers the current catalog

#### Scenario: Reconnecting and archived chats
- **WHEN** a client reconnects to a live Codex chat, or opens an archived Codex chat
- **THEN** the live snapshot includes its current command state and the archived chat starts no discovery process
