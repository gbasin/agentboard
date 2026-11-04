## MODIFIED Requirements

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
