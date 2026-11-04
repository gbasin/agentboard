# Proposal

## Why

Settings → Chat → Approval Policy says it is the "Default for new chat
sessions", but chats that Kawai spawns for a team group ignore it. The setting
lives only in browser storage, and the only thing that reads it is the New
Session dialog. Spawns run on the server and use the group file's `approval:`
key, which the parser turns into `manual` when the key is absent. On an
unattended team, a spawned member therefore waits on an approval card until
someone notices it. The only workaround is to add `approval: auto` to every
group file (seen on `v1.0.0-3218`).

## What Changes

- Add a **per-team default approval policy for spawned chats** (`manual` or
  `auto`). It is stored on the server, keyed by team (the repository's common
  git directory), and set by the human from the Team page's Members tab. It
  starts unset for every team. There is no migration: the browser's Settings
  value is never uploaded.
- Each spawned chat's policy is resolved in this order:
  1. the group file's `approval:` key, if present
  2. the team default
  3. `manual`

  It is resolved on the server at spawn time, so it works with no browser
  connected (closed, offline, or disconnected). Under `auto`, tool calls are
  granted without cards.
- The group file parser keeps `approval` **unset** when the key is absent, so
  an explicit `approval: manual` still wins over an `auto` team default.
- The dispatch preview and the Members tab show the resolved policy, and say
  where it came from (group file, team default, or built-in), using the same
  resolution the spawn uses.
- Changing the team default affects only later spawns. Existing chats keep
  their policy.
- The Settings → Chat Approval Policy stays a browser preference for chats the
  user creates in the New Session dialog. Its description is reworded to say
  so, and to point spawned chats at the team default and the group key.
- No agent tool writes the team default. Only the human's UI action sets it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-worktree-staffing`: spawned members resolve their approval policy
  from the group key, then the team default, then manual, on the server
  without a browser; the team has a human-set default.
- `task-assignment`: the group dispatch preview shows the resolved policy and
  its source.
- `team-workspace`: the Members tab shows each group's resolved policy and
  source, and offers the one team-level control that sets the default.
- `chat-sessions`: the Settings default approval policy is scoped to chats the
  user creates and no longer claims to cover spawned chats.

## Impact

- Server: `src/server/team/groupFile.ts` (optional `approval`),
  `src/server/team/staffing.ts:230` (resolved policy),
  `src/server/team/groupDispatchPreview.ts:96`,
  `src/server/team/workspaceRead.ts:83`. Adds a new team-scoped store for the
  default (a SQLite table beside the team tables), plus a human WebSocket
  action with its result message (`src/shared/types.ts`,
  `src/server/chat/chatConnectionTypes.ts`).
- Shared: a pure resolver used by every reader. `TeamMemberRow` and
  `TaskDispatchPreview` gain an approval source, and the workspace snapshot
  gains the team default.
- Client: `TeamMembersPanel.tsx` (team default control and source labels),
  `taskAssignFields.tsx` (source label), and `ChatSettings.tsx` (reworded
  hint).
- Docs: the staffing and Team page bullets in `docs/architecture/`.
- Behavior: existing teams are unchanged until the human sets a default.
  Groups that already set `approval:` are unaffected by any default.
