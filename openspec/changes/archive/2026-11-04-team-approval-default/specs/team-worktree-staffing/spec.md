## ADDED Requirements

### Requirement: A team has a default approval policy for spawned members
Each team SHALL have an optional default approval policy, manual or auto, stored on the server and unset until the human sets it. Only the human's Team page action SHALL set it; no agent tool SHALL write it. A browser's stored Settings value SHALL NOT set or migrate it. Setting it SHALL change only later spawns: no existing chat's policy SHALL change. One team's default SHALL NOT affect another team.

#### Scenario: A new install has no team default
- **WHEN** a team's default has never been set
- **THEN** the team has no default, whatever the browser's Settings approval policy says

#### Scenario: The default does not change existing chats
- **WHEN** a team has a spawned member on manual and the human sets the team default to auto
- **THEN** that member stays manual, and the next member spawned for a group without an `approval:` key starts on auto

#### Scenario: Defaults are per team
- **WHEN** team A's default is auto and team B has none
- **THEN** a member spawned for team B, for a group without an `approval:` key, starts on manual

#### Scenario: Agents cannot set the default
- **WHEN** an agent lists its `kawai-team` tools
- **THEN** no tool sets or clears a team's default approval policy

## MODIFIED Requirements

### Requirement: A member is spawned when none is available
When a worktree task message has no idle member in its worktree and spawning is allowed, the system SHALL create a new chat session of that group in the worktree and deliver the message as its first turn. The new session SHALL use the group's `profile` (else the default profile) and SHALL be associated with the task. Its approval policy SHALL be the group's `approval:` key if present, else the team default, else manual, resolved on the server at spawn time without any browser connection.

#### Scenario: Spawn for an unstaffed worktree
- **WHEN** a team lead sends a task message to `devs` for worktree `feat-x` and no `devs` member runs there
- **THEN** a new `devs` chat session is created in `feat-x` and receives the message as its first turn

#### Scenario: Group settings applied
- **WHEN** the `devs` group sets `profile: glm` and `approval: auto`
- **THEN** the spawned session uses the `glm` profile and the auto approval policy

#### Scenario: Team default applies to a group without the key
- **WHEN** the team default is auto and the `devs` group has no `approval:` key
- **THEN** the spawned `devs` session starts on auto

#### Scenario: Explicit manual beats an auto default
- **WHEN** the team default is auto and the `devs` group sets `approval: manual`
- **THEN** the spawned `devs` session starts on manual

#### Scenario: Explicit auto beats a manual default
- **WHEN** the team default is manual and the `devs` group sets `approval: auto`
- **THEN** the spawned `devs` session starts on auto

#### Scenario: Neither set keeps manual
- **WHEN** the team has no default and the `devs` group has no `approval:` key
- **THEN** the spawned `devs` session starts on manual

#### Scenario: Auto works with no browser connected
- **WHEN** the team default is auto, no browser is connected to Kawai, and a message spawns a `devs` member whose group has no `approval:` key
- **THEN** the member starts on auto and its tool approvals are granted without cards while no browser is connected
