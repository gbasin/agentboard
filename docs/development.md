# Development

This page covers running Agentboard from a source checkout. For how the code is organised, see [architecture.md](architecture.md). For conventions and the release process, see [AGENTS.md](../AGENTS.md).

## Requirements

- Bun 1.3.14 or later.
- tmux 3.2 or later.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`). The server uses it to match agent transcripts to tmux windows.
- Node.js, for the tests. `bun run test` runs part of the suite with `node --test`.

## Run from source

```bash
bun install
bun run dev
```

Open `http://<your-machine>:5173`. `bun run dev` starts the backend on port 4040 and the Vite dev server on port 5173. The Vite server proxies API and WebSocket requests to the backend.

To reach the dev server by hostname from another device, set `VITE_ALLOWED_HOSTS`. See [configuration.md](configuration.md#development).

For a production build, the backend serves the UI on its own port (default 4040):

```bash
bun run build
bun run start
```

To run a source checkout as a service, see [launchd/README.md](../launchd/README.md) (macOS) or [systemd/README.md](../systemd/README.md) (Linux).

### Run a second instance

Agentboard allows one server per data directory. It also refuses to start from a tmux pane that belongs to a running Agentboard, because the new server would act on the live tmux sessions. Give a second instance its own tmux socket, data directory, and port. [AGENTS.md](../AGENTS.md#tmux-safety) has the commands and the cleanup steps.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Backend and Vite dev server. |
| `bun run build` | Production build of the frontend into `dist/client`. |
| `bun run start` | Backend only. Serves the built frontend. |
| `bun run lint` | oxlint. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run test` | Unit and integration tests. |
| `bun run test:e2e` | Playwright end-to-end tests. They run on a private tmux socket and data directory. |
| `bun run test:coverage` | Tests with coverage output. Skips the isolated and real-tmux suites. |
| `bun run deps:risk` | Dependency risk report. |
| `bun run readme:shots` | Regenerates the README images in `assets/readme/`. |

Run `bun run lint && bun run typecheck && bun run test` before you commit. The pre-commit hook runs the same three commands.

## README images

`bun run readme:shots` rebuilds the client, boots a private Agentboard (own tmux sockets, data directory, HOME and port 4199 under `/private/tmp/ab-shots`), seeds invented sessions from `scripts/readme-shots/scenes.ts`, captures the UI with Playwright, and writes the composited images to `assets/readme/`.
It needs the Playwright Chromium and WebKit browsers, `tmux`, `ffmpeg`, and `cwebp`, and takes about 1.5 minutes.

One run at a time: the script holds loopback port 4198 as a lock from start to exit, and a second run (or `--composite-only`) refuses while it is held. The lock cannot go stale, because the port is free again as soon as the process ends. On success, Ctrl+C, or SIGTERM the script stops what it started and removes its temp directory. A run that was killed outright (SIGKILL) leaves its processes and directory behind; the next run removes them before it starts. If compositing fails, the script keeps the raw captures in `/private/tmp/ab-shots-raw` for `--composite-only`.

What the script stages:

- Session ages in the sidebar are set in the session frames during capture, because a fresh server dates every session "now".
- CSS animations are frozen for the stills.
- The terminal uses the DOM renderer instead of WebGL.
- The window frame and the phone bezel are drawn in the compositing step.

## Dependency risk scanner

The scanner reports security and maintenance risk for direct dependencies:

```bash
bun run deps:risk
```

For machine-readable output:

```bash
bun run deps:risk:json
```

Policy:

- Security risk comes from `bun audit --json` findings and is aggregated by severity (`low`, `moderate`, `high`, `critical`).
- Maintenance risk comes from `bun outdated` and classifies version lag as `major`, `minor`, or `patch` behind latest.
- The local default threshold is `high`: `high` and `critical` findings fail.
- CI fails on `critical` only (`bun run deps:risk:ci`). Maintenance findings are warnings.

Override the security threshold with `--threshold` or `DEPENDENCY_RISK_FAIL_ON`:

```bash
bun run deps:risk -- --threshold moderate
```

## Troubleshooting

### "open terminal failed: not a terminal"

If the server logs `open terminal failed: not a terminal` repeatedly, upgrade Bun:

```bash
bun upgrade
```

Bun versions before 1.3.6 had a bug in `Bun.spawn()`: the `terminal` option set stdin to `/dev/null` instead of the PTY. `tmux attach` needs a terminal on stdin, so it failed immediately.
