# AGENTS.md

## Environment

Bun 1.x, TypeScript 5.x

## Commands

bun run dev        # frontend + backend
bun run build      # production build
bun run lint       # oxlint
bun run typecheck  # tsc --noEmit
bun run test       # bun test

Run `bun run lint && bun run typecheck && bun run test` after changes.

## Git

- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`

## Critical Thinking

- Read more code when stuck
- Document unexpected behavior
- Call out conflicts between instructions

## Engineering

- Small files (<500 LOC), descriptive paths, current header comments
- Fix root causes, not symptoms
- Simplicity > cleverness (even if it means bigger refactors)

## UI Testing

Use the `dev-browser` skill for testing web UI changes. Headless browser
automation with Playwright. Start server, take screenshots, verify DOM state.

## Project

Real-time dashboard for Claude Code sessions. Streams tmux terminal output via WebSocket, parses Claude JSONL logs for status.

## Architecture

- `src/server/` — Hono backend (tmux management, log parsing, WebSocket)
- `src/client/` — React frontend (xterm.js, Zustand)
- `src/shared/` — Shared types

## Key Concepts

- tmux session `agentboard` holds all windows
- Claude logs: `~/.claude/projects/<path>/*.jsonl`
- Status machine: idle → working → waiting

## Ports

Dev: `localhost:5173` (frontend), `localhost:4040` (backend)
