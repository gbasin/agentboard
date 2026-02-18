# Setup and Run UX Proposal (MVP)

## Overview

Make first-run setup feel obvious and fast for a solo developer. The app should check prerequisites, explain missing pieces, and offer one-click fixes. Defaults should just work (including tmux), with clear opt-outs. Production use should be explicit and separate from dev.

## Goals

- First successful run in under 5 minutes on macOS/Linux.
- No blank UI states; always show "what to do next."
- Safe automation with transparency (show exact commands, require consent for config edits).
- Optional remote access (Tailscale) without blocking local use.

## Inspiration

Clawd's onboarding works because the Quick Start is highly visible, paths are tabbed, and a single command gets you running. We can mirror the UX patterns without copying implementation.

## Proposed MVP UX

### 1) Quick Start (Docs + UI)

- Add a "Quick Start" block to README and a matching "Setup" panel in the UI.
- Tabs or toggles:
  - Just Works (one-liner bootstrap)
  - Hackable (clone + `bun install` + `bun run dev`)
  - Prod (build + `bun run start`)
- OS toggle (macOS/Linux) and copy button for commands.

### 2) Preflight Checks (on start)

Run on both `dev` and `start` commands:

- Bun installed and version range.
- tmux installed and accessible.
- Log directories exist and are readable:
  - `~/.claude/projects`
  - `~/.codex/sessions`
- WebSocket port available.
- Optional: tailscale binary detected and status.

If any fail, show a Setup panel with:

- Short reason (e.g., "tmux missing")
- Fix action (copyable command or "Run fix" button)
- "Continue anyway" for non-critical items

### 3) tmux Auto-Setup (default on first run)

- If session missing, create it and attach or keep detached based on a flag:
  - Default: create session and manage windows automatically.
  - Opt-out: `AGENTBOARD_MANAGE_TMUX=0` or `--no-tmux`.
- Show the exact tmux commands executed.
- Avoid editing `~/.tmux.conf` unless explicitly approved in the UI.

### 4) No-Logs Fallback

If no sessions/logs are detected:

- Explain why (missing dirs, no recent Claude/Codex logs).
- Offer links to setup instructions.
- Optional "demo data" toggle so the UI isn't empty.

### 5) Optional Tailscale (non-blocking)

- If installed: show status and tailnet IP in the UI (copy button).
- If not installed: show install instructions, but do not auto-install.
- Do not run `tailscale up` without explicit user consent.

### 6) Dev vs Prod Split

- Add `bun run start` for production (no HMR).
- Keep `bun run dev` for local development only.
- UI and docs should clearly distinguish these paths.

## Implementation Sketch (lightweight)

- Server
  - Add a preflight module (e.g., `src/server/setup/preflight.ts`) that runs checks and returns structured results.
  - Add routes:
    - `GET /api/setup/status` -> preflight results
    - `POST /api/setup/fix` -> run a safe, explicit fix action
  - Add tmux helper to create/attach session and report the commands used.
- Client
  - New `SetupPanel` component (rendered when preflight fails).
  - Use CTA buttons to copy or trigger fix commands.
  - Store "do not show again" in local settings.
- Scripts
  - Add `bun run setup` or `bun run bootstrap` to run preflight and apply safe fixes in the CLI.
  - Optional: `install.sh` one-liner that installs Bun/tmux and runs setup (opt-in).

## Future Enhancements

- First-run wizard (step-by-step) in the UI.
- Guided tmux layout configuration (window per project).
- Remote session management view (multiple hosts via Tailscale).
- Diagnostics export ("download setup report").

## Open Questions

- Should tmux auto-create without a prompt, or prompt on first run and remember?
- Should we include a one-liner install script in v1, or wait until setup is stable?
- Is "prod server" a real target now, or later?
- Do we want a CLI wizard, web wizard, or both for MVP?
