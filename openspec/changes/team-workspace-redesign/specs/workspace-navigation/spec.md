# Spec Delta

## MODIFIED Requirements

### Requirement: A Team entry opens the team workspace at repository level
The navigator SHALL show one **Team** entry at repository level for each discovered repository. Opening it SHALL switch to Team mode for that repository's team, on the team's last area or on Today the first time. The entry SHALL NOT be a session row, SHALL NOT be affected by session filters, and SHALL NOT change which chat is selected.

#### Scenario: One entry per repository
- **WHEN** a repository has sessions across several worktrees
- **THEN** the navigator shows one **Team** entry for that repository, not one per worktree

#### Scenario: The entry opens the workspace
- **WHEN** the human opens the **Team** entry
- **THEN** Team mode opens for that repository's team and the selected chat is unchanged

#### Scenario: Session filters do not hide the entry (E14)
- **WHEN** a project or host filter leaves no visible session rows
- **THEN** the **Team** entry for a repository that still has a team remains available
