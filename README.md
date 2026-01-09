# Agentboard

Agentboard is a real-time dashboard for Claude Code sessions. It discovers tmux windows, streams terminal output into the browser, and watches Claude's JSONL logs to surface session status.

## Requirements

- **Bun** 1.3+
- **tmux** (`brew install tmux` on macOS)
- **Claude Code CLI** available as `claude`

## Quick Start

```bash
bun install
bun run dev
```

- Frontend: `http://localhost:5173`
- Backend/WebSocket: `http://localhost:4040`

For a production build:

```bash
bun run build
bun run start
```

## How It Works

- Agentboard uses a single tmux session (default: `agentboard`) with one window per project.
- Claude Code logs are read from `~/.claude/projects/<escaped-path>/*.jsonl`.
- Status changes are derived from JSONL events (tool use, turn end, user prompts).

## Environment Variables

```bash
PORT=4040
TMUX_SESSION=agentboard
REFRESH_INTERVAL_MS=5000
IDLE_TIMEOUT_MS=300000
DISCOVER_PREFIXES=external,work
CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
```

- `DISCOVER_PREFIXES` allows viewing windows from other tmux sessions. These are marked **View Only**.

## Creating Sessions

Use the UI's **+ New Session** button, or run the helper script:

```bash
./scripts/agentboard-window.sh
```

You can also pass a custom window name:

```bash
./scripts/agentboard-window.sh my-project
```

## Notes

- Browser notifications only fire when the tab is hidden. Sound + favicon badge fire always.
- If `tmux` is missing, the server will fail fast with install instructions.
- Claude logs can be large; Agentboard tails only the most recent data for status detection.

## Testing

```bash
bun test
bun run lint
```
