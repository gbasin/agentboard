# AGENTS.md

- Bun 1.x, TypeScript 5.x, React 18, Hono, xterm.js, Zustand, Tailwind.

## Commands

```
bun run dev        # frontend + backend
bun run build      # production build
bun run lint       # oxlint
bun run typecheck  # tsc --noEmit
bun run test       # unit tests
```

Run `bun run lint && bun run typecheck && bun run test` after changes.

## How It Works

- Single tmux session (default: `agentboard`) with one window per project
- Backend discovers windows, streams terminal output via WebSocket
- Parses Claude/Codex/Pi JSONL logs from `~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`
- Devin CLI stores history in SQLite (`~/.local/share/devin/cli/sessions.db`); `src/server/devinSync.ts` mirrors it into `~/.agentboard/devin-sessions/*.jsonl` so the same pipeline applies. `src/server/devinLockMatch.ts` matches devin sessions to windows via `session_locks/<id>.lock` PIDs.
- Grok CLI writes transcripts at `~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl`; sessionId and projectPath are derived from the directory names. Sibling telemetry files (events.jsonl, updates.jsonl) are excluded from matching.
- Status: unknown -> working -> waiting (derived from log events)

## Structure

- src/server/     Hono backend, WebSocket, tmux/pty management, log parsing
  - `src/server/SessionManager.ts` - tmux window discovery, log parsing, status detection
  - `src/server/index.ts` - Hono routes, WebSocket handling
- src/client/     React frontend, xterm.js terminal, Zustand stores
  - `src/client/App.tsx` - main UI, keyboard shortcuts
  - `src/client/components/Terminal.tsx` - xterm.js wrapper
- src/shared/     Shared types

- Data directory: `~/.agentboard/` contains `agentboard.db` (session data) and `agentboard.log`

## tmux Safety

- Agent sessions often run *inside* the `agentboard` tmux session. Any `tmux`
  command in such a shell inherits `TMUX`, which overrides `TMUX_TMPDIR` and
  targets the real server — `kill-server`/`kill-session` will destroy live
  windows. Always run probes with `env -u TMUX tmux -L <socket-name>` against a
  dedicated socket, and never `kill-server` without explicit confirmation.

## Git

- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Commit early and often — make small, incremental commits as you work rather than one large commit at the end.

## Releases

- Managed by [release-please](.github/workflows/release-please.yml); it scans conventional commits on `master` and maintains a release PR that bumps `package.json` and `CHANGELOG.md`.
- Do NOT bump `package.json` version or add `(vX.Y.Z)` suffixes in change PRs — the release PR owns versioning. `fix:`/`perf:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major.
- Merge the release PR to ship: release-please creates the tag + GitHub release, and `release.yml` (dispatched from the same workflow run) builds binaries and publishes npm packages.
- `release.yml`'s last step regenerates `bun.lock` on master post-publish — release-please bumps `optionalDependencies` but never updates the lockfile, and the new platform packages only resolve once published.
- Overrides: `Release-As: x.y.z` in a merge commit body pins the next release to that version; a manual `git tag vX.Y.Z && git push` still runs the full pipeline (but skips the `package.json` bump); the Release Please workflow can be re-run manually via `workflow_dispatch`.

## Critical Thinking

- Read more code when stuck
- Document unexpected behavior
- Call out conflicts between instructions

## Engineering

- Small files (<500 LOC), descriptive paths, current header comments
- Fix root causes, not symptoms
- Simplicity > cleverness (even if it means bigger refactors)
- Aim for 100% test coverage

## UI Testing

- Use the `dev-browser` skill for testing web UI changes. Headless browser
automation with Playwright. Start server, take screenshots, verify DOM state.
- For changes that impact UI, attach visual evidence (screenshot or short clip)
to the PR: `gh pr comment <n> --attach './shot.png#alt text'`.
