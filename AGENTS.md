# AGENTS.md

- Bun 1.3 (pinned in `.bun-version`), TypeScript 5, React 18, Hono 4, xterm.js 6 (`@xterm/xterm`), Zustand 5, Tailwind CSS 3. Vite 8 builds the client; the server runs from source with Bun, and release binaries come from `bun build --compile`.

## Commands

```
bun run dev            # backend (port 4040) + Vite dev server (port 5173)
bun run build          # production client build into dist/client
bun run lint           # oxlint
bun run typecheck      # tsc --noEmit
bun run test           # unit and integration tests (scripts/test-runner.ts)
bun run test:e2e       # Playwright end-to-end tests, isolated tmux socket and data dir
bun run test:coverage  # lcov coverage; skips the isolated/ and real-tmux suites
bun run deps:risk      # dependency security and maintenance scanner
```

Run `bun run lint && bun run typecheck && bun run test` after changes. The
pre-commit hook (`.githooks/pre-commit`) runs the same three commands.

`bun run test` is not the same as bare `bun test`. `scripts/test-runner.ts`
points the Claude and Codex roots, the database, the data dir, and the log file
at a temp directory. It also allocates a private tmux socket directory and
removes `TMUX`/`TMUX_PANE` before launching any child process or Worker.
Test-server startup rejects inherited tmux identity or a missing private socket
directory; mocks are not an isolation boundary. It sets `NODE_ENV=test` when `NODE_ENV` is unset or
`production`, and keeps any other value. It runs each file named on its
isolation lists (`ISOLATED_FILES`, `ISOLATED_REAL_TMUX_FILES`,
`ISOLATED_CLIENT_FILES`) and each file in `src/server/__tests__/isolated/` in
its own process. Bare `bun test` runs everything in one process against your
real environment. A new test that mocks modules or globals, or that starts real
tmux, must be registered there; see
[docs/architecture.md](docs/architecture.md#when-you-add-x-also-change-y).

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

Read [docs/architecture.md](docs/architecture.md) before changing the server. The essentials:

- One managed tmux session (default `agentboard`) holds one window per agent session. Windows in other tmux sessions are discovered as external (`DISCOVER_PREFIXES` narrows that). In `pty` terminal mode (the default), each browser terminal attaches to a local window through its own grouped session (`<TMUX_SESSION>-ws-<id>`).
- With the terminal relay (the default), a relay Worker owns the public port and terminal I/O; the main thread serves HTTP on loopback and owns the database. Never call `worker.terminate()`: it segfaults compiled Bun.
- Status (`working`, `waiting`, `permission`, `unknown`) is inferred from tmux pane content in `src/server/statusInference.ts`, not from logs.
- Agent transcripts (Claude, Codex, Pi, oh-my-pi, Grok, and a mirror of Devin's SQLite history) are matched to windows in `src/server/logMatcher.ts` and `src/server/ownership/`. They drive the last prompt, PR chips, and media. `src/server/logDiscovery.ts` owns the roots.
- Data lives in `~/.agentboard/` (`AGENTBOARD_DATA_DIR`): `agentboard.db` holds conversations and the session-recovery catalog.

## Structure

- `src/server/`: Bun backend. `index.ts` is the entry point.
- `src/client/`: React app. `App.tsx` is the root.
- `src/shared/`: types and protocol constants used by both.
- `docs/architecture.md` maps processes, tmux, terminal I/O, the log pipeline, storage, and the API.

## Documentation

- `docs/` describes current behaviour only.
- Investigation evidence, measurements, rollout records, and design proposals belong in the pull request (description or attachments), not in the tree.
- When a rule in `docs/` rests on a measurement or an experiment, state the rule in the present tense and link the pull request that holds the evidence.
- When a change makes a statement in a doc false, fix the doc in the same pull request.

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
