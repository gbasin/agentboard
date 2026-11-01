# Proposal

## Why

Claude chats offer a discoverable slash-command menu, while Codex chats always report commands as unavailable. Codex users must remember skill names even though the checked-in app-server protocol supports listing and explicitly invoking skills.

## What Changes

- Populate the existing caret-aware `/` autocomplete menu with enabled, unambiguous Codex skills discovered for the chat's working directory and Codex home.
- Keep Claude's menu interactions: name/description filtering, keyboard and pointer selection, insertion of `/<name> ` anywhere in a message, and no send on selection.
- On human submission, resolve exact slash-skill references against the server's current catalog and attach native Codex skill inputs while preserving the submitted text. Manually typed references work too.
- Refresh discovery on agent start/resume, working-directory changes, and Codex skill-change notifications; publish loading/ready/unavailable through existing snapshots and pushes without blocking chat sends.
- Preserve client-local `/clear`, `/reset`, and `/new`, Claude commands, and peer-mail delivery.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `codex-chat-sessions`: discover available skills for autocomplete, refresh the catalog safely, and explicitly invoke referenced skills on human turns.

## Impact

- Server: `src/server/chat/codex/CodexSessionDriver.ts`, a small Codex-specific catalog/parser helper, command-state callbacks, and existing manager snapshot/push integration.
- Client: reuse `ChatView`, `SlashCommandMenu`, and `slashCommandFilter` through the current `ChatCommandState` contract; no new completion service or dependency.
- Tests: Codex driver fake-protocol scripts, manager command-state integration, composer tests, and Playwright coverage with a fake Codex server.
- Documentation: update the Codex and slash-command bullets in `docs/architecture/chat.md`. The original Codex design's exclusion of skill autocomplete is superseded by this delta; terminal-only Codex commands and general text/file completion remain outside scope.
