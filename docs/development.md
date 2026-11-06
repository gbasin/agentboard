# Development

This page covers running Agentboard from a source checkout. For how the code is organised, see [architecture.md](architecture.md). For conventions and the release process, see [AGENTS.md](../AGENTS.md).

## Requirements

- Bun 1.3.14 or later.
- tmux 3.2 or later.
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

Run `bun run lint && bun run typecheck && bun run test` before you commit. The pre-commit hook runs the same three commands.

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
