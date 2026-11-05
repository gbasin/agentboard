# Spec Delta

## MODIFIED Requirements

### Requirement: Team views open from one Team button
The header SHALL offer one **Team** button that switches to Team mode for the chat's team, on the area last used for that team, or on Today the first time. The header SHALL NOT offer Tasks, Mailbox, Messages, or Strategy panels, and those views SHALL NOT open in the chat's side slot. The button SHALL be present for archived chats and for chats whose team is a plain directory. When the chat was opened from Team mode, the header SHALL also show **Back to Team**.

#### Scenario: Team opens the team's page
- **WHEN** the user chooses Team in a chat of repository `kawai` after last leaving that team on Conversations
- **THEN** Team mode for `kawai`'s team opens on Conversations and the chat stays the selected chat

#### Scenario: First open lands on Today
- **WHEN** the user chooses Team for a team not yet opened in this browser tab
- **THEN** Team mode opens on Today

#### Scenario: No team panels in the side slot
- **WHEN** a chat view is open
- **THEN** the header shows no Tasks, Mailbox, Messages, or Strategy entry, and only the debug panel can occupy the side slot

#### Scenario: Plain-directory team
- **WHEN** the chat runs in a directory that is not a git repository
- **THEN** the Team button opens Team mode for that directory's team

#### Scenario: Back to Team after opening a chat from Team
- **WHEN** the user opened this chat from an agent row in Team mode
- **THEN** the header shows **Back to Team**, which returns to that Team location
