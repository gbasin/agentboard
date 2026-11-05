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

## FAD Parity Fixtures

FAD = [`franken_agent_detection`](https://github.com/Dicklesworthstone/franken_agent_detection)
(published as the `franken-agent-detection` crate) — the connector/parsing
library underneath [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search).
It normalizes ~26 coding-agent transcript formats into `NormalizedConversation`s.

`src/server/__tests__/fadParity.test.ts` asserts our log extraction agrees with
FAD on a shared fixture tree at `tests/fixtures/fad/home/`. Expected outputs in
`tests/fixtures/fad/expected/` are generated, not hand-written — regenerate
with `bun run scripts/regen-fad-fixtures.ts` (requires cargo; builds the
dev-only `tools/fad-dump` shim). The shim is never a runtime dependency.

## How It Works

- Single managed tmux session (default: `agentboard`) with one window per agent session. Windows in all other tmux sessions are discovered as external; set `DISCOVER_PREFIXES` to limit discovery to sessions whose names start with those prefixes. Each browser connection attaches through its own grouped session (`<TMUX_SESSION>-ws-<connection>`).
- Backend discovers windows, streams terminal output via WebSocket
- Parses Claude/Codex/Pi/oh-my-pi JSONL logs from `~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`, `~/.omp/agent/sessions/` (or `$XDG_DATA_HOME/omp/sessions` when that directory exists). `src/server/logDiscovery.ts` owns the roots and their env overrides (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`).
- Devin CLI stores history in SQLite (`~/.local/share/devin/cli/sessions.db`); `src/server/devinSync.ts` mirrors it into `~/.agentboard/devin-sessions/*.jsonl` so the same pipeline applies. `src/server/devinLockMatch.ts` matches devin sessions to windows via `session_locks/<id>.lock` PIDs.
- Grok CLI writes transcripts at `~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl`; sessionId and projectPath are derived from the directory names. Sibling telemetry files (events.jsonl, updates.jsonl) are excluded from matching.
- Status is one of `working`, `waiting`, `permission`, `unknown`. It is inferred from tmux pane content, not from logs: `src/server/statusInference.ts` diffs pane captures (changed output means working) and matches permission-prompt patterns. After Enter is sent to a terminal, `src/server/forceWorkingStatus.ts` holds the status at `working` for a short grace period. Logs drive session-to-window matching, the last user prompt, PR chips, and media.

## Structure

- src/server/     Hono backend, WebSocket, tmux/pty management, log parsing
  - `src/server/index.ts` - boot, Hono routes, WebSocket handling, refresh loop, session lifecycle handlers
  - `src/server/SessionManager.ts` - tmux window discovery, create/kill/rename, window options
  - `src/server/statusInference.ts` - status detection from pane content
  - `src/server/logDiscovery.ts`, `logWatcher.ts`, `logPoller.ts`, `logMatcher.ts` - log roots, change detection, session-to-window matching
  - `src/server/terminal/` - terminal proxies (pty, pipe-pane, ssh)
  - `src/server/persistence/` - session recovery catalog
- src/client/     React frontend, xterm.js terminal, Zustand stores
  - `src/client/App.tsx` - main UI, keyboard shortcuts
  - `src/client/components/Terminal.tsx` - terminal pane, controls, overlays
  - `src/client/hooks/useTerminal.ts` - xterm.js instance, input, paste, links
- src/shared/     Shared types

- Data directory: `~/.agentboard/` (override with `AGENTBOARD_DATA_DIR`) holds `agentboard.db` (session data), `media-index.sqlite`, and `server.lock` (single-instance lock). Depending on configuration it also holds `agentboard.log` (when file logging is on), `tmux-server.pid` (unless `AGENTBOARD_TMUX_PID_FILE` moves it), `devin-sessions/` (when Devin CLI history exists), and `stall-samples/` (macOS, after a stall).

## tmux Safety

- Agent sessions often run *inside* the `agentboard` tmux session. Any `tmux`
  command in such a shell inherits `TMUX`, which overrides `TMUX_TMPDIR` and
  targets the real server — `kill-server`/`kill-session` will destroy live
  windows. Always run probes with `env -u TMUX tmux -L <socket-name>` against a
  dedicated socket, and never `kill-server` without explicit confirmation.
- The same applies to running a second **server** (dev, verify, manual e2e).
  Started from an agentboard pane, it inherits `TMUX`, joins the live tmux
  server, and groups its sessions with the live `agentboard` session — the
  live board then shows duplicate windows, and killing one kills the real
  window. The server now refuses to start from an agentboard-managed pane. Give it a private
  socket and data dir instead:

  ```
  TMUX_TMPDIR=/tmp/ab-dev-mytask AGENTBOARD_DATA_DIR=/tmp/ab-dev-mytask/data \
    PORT=4141 TMUX_SESSION=ab-dev bun run dev
  ```

  Use a literal directory name that is unique to your task. Do not use `$$`:
  every new shell has a different PID, so a later command builds a different
  path. tmux ignores a `TMUX_TMPDIR` that does not exist and falls back to the
  default socket, which is the live server.

  `bun run test:e2e` already isolates itself. Stop what you started by naming
  the socket (`env -u TMUX tmux -S /tmp/ab-dev-mytask/tmux-$(id -u)/default kill-server`)
  and remove the temp dir when done. `-S` fails with an error when the socket
  is missing; it never falls back to the live server.
- Every subprocess the server spawns must pass an explicit `env` —
  `Bun.spawn*`/`spawnSync` without `env` reuse the *process-start* environ,
  so they ignore `delete process.env.TMUX` from isolation setup (and Bun
  Workers never see post-start env mutations at all). Use
  `sanitizedTmuxEnv()` (from `tmuxEnv.ts`, already the default inside
  `timedSpawnSync`/`timedSpawnAsync`) so spawned clients honor the
  `TMUX_TMPDIR` isolation instead of landing on the live tmux server.

## Git

- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Commit early and often — make small, incremental commits as you work rather than one large commit at the end.

## Releases

- Managed by [release-please](.github/workflows/release-please.yml); it scans conventional commits on `master` and maintains a release PR that bumps `package.json` and `CHANGELOG.md`.
- Do NOT bump `package.json` version or add `(vX.Y.Z)` suffixes in change PRs — the release PR owns versioning. `fix:`/`perf:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major.
- Merge the release PR to ship: release-please creates the tag + GitHub release, and `release.yml` builds binaries, publishes the npm packages, uploads release assets, and updates the Homebrew tap formula. The tag push triggers `release.yml` when the release GitHub App token minted the tag; with the `GITHUB_TOKEN` fallback, the Release Please workflow dispatches it instead.
- `release-please` does NOT bump `optionalDependencies` (no `extra-files` in `release-please-config.json`) — the platform packages don't exist on npm until `release.yml` publishes them, so an early bump would leave master failing `bun install --frozen-lockfile`. `release.yml`'s last step syncs `optionalDependencies` + `bun.lock` together on master post-publish.
- Overrides: `Release-As: x.y.z` in a merge commit body pins the next release to that version; a manual `git tag vX.Y.Z && git push` still runs the pipeline, but nothing bumps `package.json`, and the main package publishes the committed version — tag a commit whose `package.json` version already equals the tag; the Release Please workflow can be re-run manually via `workflow_dispatch`.

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
