## MODIFIED Requirements

### Requirement: Dispatch can be previewed before sending
Before dispatch, the UI SHALL show a preview with the target worktree, the requested role, the effective profile, the approval policy, and whether staffing is available for the target. A group preview's policy SHALL be the one a spawn would get, with its source. For a session target the preview SHALL show that session's resolved worktree, profile, and policy, and SHALL warn, not block, when that worktree differs from the task's. Every constraint SHALL be revalidated at dispatch.

#### Scenario: Group preview shows staffing availability
- **WHEN** the human previews an assignment to a group for a task targeting a worktree with no idle matching member
- **THEN** the preview names the worktree, the group's role, the profile a spawned member would use, the approval policy a spawned member would get, and whether staffing can add a member

#### Scenario: Group preview shows the resolved policy and its source
- **WHEN** the team default is auto and the human previews an assignment to a group with no `approval:` key
- **THEN** the preview shows auto from the team default, the policy a member spawned by that dispatch starts with

#### Scenario: Group preview names a group key over the default
- **WHEN** the team default is auto and the group sets `approval: manual`
- **THEN** the preview shows manual from the group file

#### Scenario: Session preview shows profile and policy
- **WHEN** the human previews an assignment to a specific session
- **THEN** the preview shows that session's resolved worktree, effective profile, and approval policy

#### Scenario: Worktree mismatch is warned, not blocked
- **WHEN** the previewed session's resolved worktree differs from the task's target worktree
- **THEN** the preview shows a warning naming both worktrees, and dispatch remains available
