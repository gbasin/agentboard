# team-worktree-staffing Specification

## Purpose

Routes work aimed at a worktree to agents running in that worktree and, within configured limits, starts a group member there when none is free.

## Requirements

### Requirement: Worktree task mail goes to members in that worktree
A group message whose task has a target worktree SHALL be delivered only to an idle group member whose current worktree — the root of the worktree containing the member's current project directory — is that worktree, unless the receiving group's current file sets `worktreeScoped: false`. A member whose agent has moved into a subdirectory of the worktree SHALL still match. Members whose current worktree is another directory of the same repository SHALL NOT receive it.

#### Scenario: Matching member
- **WHEN** a message for `devs` references a task targeting worktree `feat-x` and an idle `devs` member runs in `feat-x`
- **THEN** that member receives it

#### Scenario: Member in a subdirectory still matches
- **WHEN** a task targets worktree `feat-x` and an idle `devs` member's agent has changed into `feat-x/src`
- **THEN** that member receives the message

#### Scenario: Member elsewhere is skipped
- **WHEN** the only idle `devs` member runs in the main checkout and the task targets `feat-x`
- **THEN** that member does not receive the message

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

### Requirement: Spawning is bounded
The system SHALL NOT spawn when the group has `max` live members (default 1, or its profile caps' sum), the team has its maximum live spawned sessions, or the worktree (resolved as for delivery) already has a live spawned member of any group. A message that cannot spawn SHALL wait and be re-evaluated when a member idles or a slot frees. A failed spawn SHALL back off per message and be re-evaluated on its own when the backoff ends; waiting reasons SHALL report that end as the retry time.

#### Scenario: Group cap
- **WHEN** `devs` has `max: 2` and two live members, both busy in other worktrees
- **THEN** no session is spawned and the message waits

#### Scenario: One spawned writer per worktree
- **WHEN** a spawned `devs` member already runs in `feat-x` and is busy
- **THEN** a second task message for `feat-x` waits for it instead of spawning another

#### Scenario: A failed spawn retries on its own
- **WHEN** a spawn fails, its message is queued again under a 30-second backoff, and nothing else changes in the team
- **THEN** the spawn is retried when the backoff ends, and the waiting reason's retry time is the moment the retry runs

### Requirement: Team spawn caps are user-level settings
The system SHALL read team spawn caps from `~/.kawai/teams.json`: a top-level `maxSpawnedSessions` (positive integer, default 5) applying to every team, and an optional `teams` map from repository path to `{ "maxSpawnedSessions": n }` overriding it for that repository. Project files SHALL NOT set team caps. An invalid file SHALL be reported and the defaults used.

#### Scenario: Default cap
- **WHEN** `~/.kawai/teams.json` does not exist
- **THEN** every team may have at most 5 live spawned sessions

#### Scenario: Per-repository override
- **WHEN** the file sets `"maxSpawnedSessions": 5` and `"teams": { "/home/coder/kawai": { "maxSpawnedSessions": 8 } }`
- **THEN** the kawai team may have 8 live spawned sessions and other teams 5

#### Scenario: Override by worktree path
- **WHEN** an override is keyed by a linked worktree path of a repository
- **THEN** it applies to that repository's team

#### Scenario: Invalid file
- **WHEN** `~/.kawai/teams.json` contains malformed JSON
- **THEN** the problem is reported and the default cap of 5 applies

### Requirement: Spawned sessions are visible
A spawned session SHALL appear in the navigator under its worktree, marked as spawned with its task. While it awaits an approval or question from the human, the navigator SHALL flag it as needing attention and the UI SHALL notify the user.

#### Scenario: Spawned session waits for approval
- **WHEN** a spawned session with manual approval requests a tool approval
- **THEN** its navigator row is flagged as needing attention and a notification is shown

### Requirement: No worktree is created implicitly
The system SHALL NOT create a git worktree to satisfy a message. A task whose target worktree no longer exists SHALL cause its waiting messages to be dead-lettered with that reason.

#### Scenario: Worktree removed
- **WHEN** a task's target worktree is removed while messages for it wait
- **THEN** those messages are dead-lettered stating the worktree is missing

### Requirement: Groups can opt out of worktree scoping
A group file SHALL accept `worktreeScoped: true|false` (default `true`). Task mail to a group whose current file sets `false` SHALL go to any idle member of the group wherever it runs, and SHALL NOT cause a member to be spawned. Any other value SHALL be reported and the file skipped, as for other invalid settings.

#### Scenario: Dev report reaches the lead in the main checkout
- **WHEN** the `lead` group sets `worktreeScoped: false`, its only member runs in the main checkout, and a dev sends the `lead` group a message referencing a task targeting `feat-x`
- **THEN** the lead receives it

#### Scenario: Killed lead's thread reaches the new lead
- **WHEN** the `lead` group sets `worktreeScoped: false` and a dev replies, with its task, to a message from a lead that was killed
- **THEN** the reply falls back to the `lead` group and the current lead in the main checkout receives it with the thread

#### Scenario: No spawn for an unscoped group
- **WHEN** the `reviewers` group sets `worktreeScoped: false`, has no idle member, and receives task mail targeting `feat-x`
- **THEN** no session is spawned and the message waits for a reviewer to become idle

#### Scenario: Default keeps worktree routing
- **WHEN** the `devs` group file does not set `worktreeScoped`
- **THEN** task mail to `devs` is delivered and staffed per worktree as before

### Requirement: Spawns honor the worker choice
A spawn for group mail with a worker choice SHALL start on a chosen worker. The worker's cap, the group's `max`, the team spawn cap, and worktree occupancy SHALL apply unchanged. When no chosen worker has a free slot, the message SHALL wait rather than spawn on another worker.

#### Scenario: Spawn on the chosen provider
- **WHEN** worktree task mail chose provider `claude` and no member can take it
- **THEN** the spawned member starts on a `claude` worker of the group

#### Scenario: Chosen worker at its cap
- **WHEN** the only chosen worker is at its cap while another worker has room
- **THEN** no member is spawned on the other worker, and the message waits

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
