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
- Parses Claude/Codex JSONL logs from `~/.claude/projects/` and `~/.codex/sessions/` for status
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

## Git

- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Commit early and often — make small, incremental commits as you work rather than one large commit at the end.

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
