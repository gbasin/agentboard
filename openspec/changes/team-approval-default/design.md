# Design

## Context

See proposal.md for the motivation. Here is the current state:

- `parseGroupFile` sets `approval: 'manual'` as a base value and overwrites it
  only when the key is present (`src/server/team/groupFile.ts:154`, `:219`).
  `GroupDefinition.approval` is therefore always set, and "absent" cannot be
  told from "manual".
- The policy reaches three readers, and each copies `group.approval`:
  - the spawn itself (`staffing.ts:230`, `approvalPolicy: group.approval`)
  - the group dispatch preview (`groupDispatchPreview.ts:96`)
  - the Members tab row (`workspaceRead.ts:83`, `TeamMemberRow.approval`)
- Group files layer wholesale: a project `.kawai/groups/<id>.md` replaces the
  user-level file of the same id (`groupCatalog.ts` header). So "the key is
  present" means present in the file that is in effect.
- Per-team values exist today only in the user-level `~/.kawai/teams.json`
  (`teamCaps.ts`), which is read-only to the server. The question auto-answer
  wait is a server-wide UI setting in `app_settings`
  (`src/server/routes/settings.ts`). Neither is a per-team value that the UI
  can write.
- Team identity is `resolveTeam(projectPath).teamId`, the canonical common git
  directory (`teamIdentity.ts`).
- Team page views address a team by `teamPath` over the chat WebSocket, and
  human actions go over that same connection
  (`team-workspace-open` and push, the `strategy-*` actions).
- A chat's policy is fixed at creation and stored with the session. The
  `auto` policy is enforced in the server-side driver, so a running chat never
  needs a browser to auto-approve.

## Goals / Non-Goals

**Goals:**

- One resolution function, so the spawn, the preview, and the Members row can
  never disagree.
- The team default is read at spawn time from server storage. A spawn needs no
  browser at all.

**Non-Goals:**

- The New Session dialog does not read the team default. Chats the user
  creates keep the browser Settings default and the dialog checkbox.
- No migration of the browser's value (the human's decision).
- No per-group override from the UI. Groups are still edited only as files.
- No change to `~/.kawai/teams.json`.
- No change to existing sessions, or to `/clear`/`/new` carry-over.

## Decisions

### D1 — `approval` is optional in the parsed group

`GroupDefinition.approval` becomes `ChatApprovalPolicy | undefined`. The parser
no longer seeds `'manual'`. An invalid value is still refused, as today.

Alternative considered: keep the field and add `approvalExplicit: boolean`.
Rejected, because two fields that can contradict each other invite readers to
keep using the old one.

### D2 — One pure resolver in `src/shared/`

`resolveSpawnApproval(groupApproval, teamDefault)` returns
`{ policy, source: 'group' | 'team' | 'built-in' }`. The rule is: group key,
else team default, else `manual` with source `built-in`.

The spawn, `previewGroupDispatch`, and `WorkspaceRead` all call it, and no
caller re-derives the policy. This guards against the hazard of several readers
disagreeing on derived state. It lives in `shared/` so the client can label the
source without reimplementing the rule, but the client only ever renders values
the server resolved.

### D3 — Storage: a `team_approval_defaults` table

The table is `(team_id TEXT PRIMARY KEY, policy TEXT NOT NULL CHECK (policy IN
('manual','auto')), updated_at TEXT NOT NULL)`. It is created idempotently
beside the team tables, and no row means "not set".

A small store, `TeamApprovalDefaults`, offers `get(teamId)` and
`set(teamId, policy)` (an upsert). Every read goes to SQLite, with no cache,
so a spawn always sees the committed value.

Alternatives considered:

- An `app_settings` key `team_default_approval:<teamId>`. It works, but it hides
  a team-keyed record in a global key-value table.
- `teams.json`. The server never writes it, and the human chose a UI setting.

There is no "clear" action. Once set, a team moves between `manual` and
`auto`, and `manual` behaves the same as unset. That keeps the control to two
options.

### D4 — Write path: one human WebSocket action

The client sends `team-approval-default-set { teamPath, policy }`. The server
answers with `team-approval-default-result { teamPath, ok, policy?, error? }`.
Both types are added to `CHAT_CONNECTION_TYPES`.

The server resolves `teamPath` the way workspace open does, refuses an unknown
team or an invalid policy, upserts, and then publishes the team's workspace.
The snapshot gains `approvalDefault: 'manual' | 'auto' | null`, and the rows
carry the resolved policies, so every open view of that team follows.

No `kawai-team` MCP tool touches the table. The guarantee matches the strategy
and plan human actions: no agent tool surface can write it.

The action is idempotent by value (an upsert of the same policy), so it needs
no command id.

### D5 — Spawn reads the default inside `spawnFor`

`StaffingCoordinator` gets a `teamApprovalDefault(teamId)` dependency. In
`spawnFor` it calls `resolveSpawnApproval(group.approval,
teamApprovalDefault(message.teamId)).policy` and passes the result as
`approvalPolicy`. This runs inside the dispatcher's server-side pass, which a
browser connection never gates, so it covers the user's "auto-approval works
with the browser offline" requirement.

The preview's input gains `teamDefault`, and the same function resolves it.
Because the preview is informational, a default changed between the preview
and the dispatch takes effect at dispatch, as every other constraint does.

### D6 — Wire shapes

`TeamMemberRow` gets `approval: ChatApprovalPolicy` (now resolved) and
`approvalSource`. `TaskDispatchPreview` gets `approvalSource` for group
targets. Session-target previews keep the session's stored policy and have no
source.

The client shows the policy with a source label: "auto · team default",
"manual · group file", or "manual · built-in".

### D7 — UI placement

The control is a two-option segmented control at the head of the Members tab,
labelled "Default approval for spawned members". Under it is a hint: it applies
to groups without an `approval:` key, it changes only later spawns, and tools
then run without asking in this team's spawned chats.

This keeps the Members requirement's rule that no control edits a group or a
running agent: the control writes only the team record.

The Settings → Chat hint changes to: "Default for chats you create. Spawned
team members use their group's `approval:` key, then the team default on the
Team page."

## Acceptance oracles

**Resolution table.** This is O1–O9, the contract of `resolveSpawnApproval`.
It is also asserted end to end through `spawnFor`, through
`previewGroupDispatch`, and through the `WorkspaceRead` member row.

| id | group key | team default | policy | source   |
|----|-----------|--------------|--------|----------|
| O1 | absent    | none         | manual | built-in |
| O2 | absent    | manual       | manual | team     |
| O3 | absent    | auto         | auto   | team     |
| O4 | manual    | none         | manual | group    |
| O5 | manual    | manual       | manual | group    |
| O6 | manual    | auto         | manual | group    |
| O7 | auto      | none         | auto   | group    |
| O8 | auto      | manual       | auto   | group    |
| O9 | auto      | auto         | auto   | group    |

No row is unreachable. An invalid group value refuses the file before
resolution, which `teamGroupFile.test.ts` already covers.

**Parser table.**

| id  | frontmatter        | parsed `approval`       |
|-----|--------------------|-------------------------|
| P1  | no `approval:` key | `undefined`             |
| P2  | `approval: manual` | `'manual'`              |
| P3  | `approval: auto`   | `'auto'`                |
| P4  | `approval: yes`    | file refused, as today  |

**Write action table.** Every row answers `team-approval-default-result`
carrying `teamPath`, which is the hazard of refusals missing the success
envelope.

| id | caller / input                      | result               | stored  | publish |
|----|-------------------------------------|----------------------|---------|---------|
| W1 | known team, `auto`                  | ok, policy `auto`    | `auto`  | yes     |
| W2 | known team, same value again        | ok, policy unchanged | same    | yes     |
| W3 | unknown `teamPath`                  | error names the path | none    | no      |
| W4 | policy not `manual`/`auto`          | error names value    | unchanged | no    |
| W5 | a worktree path of the team         | ok, keyed by team id | `auto`  | yes     |

Row W5 resolves a worktree to its common git directory, so a set from a
worktree and a read from the main checkout see the same row.

**Lifecycle oracles.**

- **L1:** an existing chat's stored policy is unchanged by any W1–W5 action.
- **L2:** a spawn for team B is unaffected by team A's row.
- **L3:** a spawn with zero WebSocket connections uses the table value, and
  under `auto` its first tool approval is granted with no card.
- **A1:** the `kawai-team` tool list has no tool whose handler writes
  `team_approval_defaults`.

**Agreement property (G1).**

- Property: for every generated pair (group key from {absent, manual, auto},
  team default from {none, manual, auto}), the policy that `spawnFor` passes,
  `previewGroupDispatch().approval`, and the `WorkspaceRead` row's `approval`
  are all equal to `resolveSpawnApproval(...).policy`, with equal sources
  where shown.
- Generator: a mulberry32 with seed `0x7a11` picks the pairs, over 200 cases.
- Seams: an in-memory DB, a fake `spawn` option that records `approvalPolicy`,
  and the group catalog stubbed per case.
- No new dependency.

## Risks / Trade-offs

- **Auto becomes a one-click switch for a whole team.** Tools then run without
  asking in every spawned chat of that team.
  → Mitigation: the setting is per team (the human's choice), starts unset,
  can be changed only by the human from the UI, and its hint says what it
  does. Groups with an explicit `approval: manual` stay manual.
- **Two settings named "default approval".**
  → Mitigation: the Settings hint and the Members hint each name the other's
  scope.
- **Groups that set `approval: manual` explicitly cannot follow the default.**
  The repository's own `.kawai/groups/*.md` files, and several user-level
  ones, set the key today, so the default affects only groups without it.
  → Mitigation: this is intended, and the Members tab shows "group file" as
  the source.

## Migration Plan

Additive. On startup the table is created if missing, and with no rows every
spawn resolves as O1 or O4–O9, which is identical to today. For a rollback,
older builds ignore the table, and its rows are harmless.
