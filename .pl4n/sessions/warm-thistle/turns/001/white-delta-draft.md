## Bacgkground and Context

- The repository currently contains only `SPEC.md`, which defines the product vision, requirements, architecture, UX, and a proposed directory structure for Agentboard. No code or tooling files are present yet.
- `SPEC.md` outlines a Node.js + Express backend, WebSocket transport, tmux discovery via shell commands, status detection via JSONL log watching and XState, and a React + Vite + Tailwind client with xterm.js integration.
- The spec assumes Claude Code logs live under `~/.claude/projects/*/*.jsonl` and that tmux sessions follow a `claude-<project>` naming convention for discovery.

## Summary

I will scaffold the repo to match the spec, then implement backend session discovery + terminal proxy and a frontend that lists sessions and embeds xterm.js, followed by status detection and the kanban UI. The plan sequences work to keep a runnable slice working end-to-end early, then expands into status tracking, notifications, and responsive polish.

## Diagrams (optional)

```
Browser UI (React) ── WebSocket ── Node/Express ── tmux + ~/.claude logs
       │                                   │
       └─ REST (session list/create/kill) ─┘
```

## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | The project is a new greenfield repo and we are expected to create the full scaffold (Vite, tsconfig, package.json, etc.). | Only `SPEC.md` exists in the repo. |
| A2 | Target runtime is Node 18+ and npm (or pnpm/yarn) is acceptable for dependency management. | Spec names Node.js and standard packages; no tooling constraints stated. |
| A3 | The environment is macOS (paths in spec, tmux usage), and tmux + Claude Code CLI are installed locally. | Spec uses macOS-style paths and tmux naming. |
| A4 | We can follow the spec’s suggested directory structure without needing to integrate into an existing monorepo. | No other repo structure is present. |
| A5 | Browser access is intended within the same LAN/VPN; authentication can be deferred to post-MVP. | Spec lists auth/HTTPS as post-MVP. |

_If revised: ~~old~~ → new_

### Questions

**Q1: Should session discovery be limited strictly to `claude-*` tmux names, or allow a configurable prefix/regex?**
- Context: This affects discoverability for users who already have different naming conventions.
- My lean: Agent recommends starting with `claude-*` plus a configurable env var for prefix later.
- **Answer:**

**Q2: How should we map a tmux session to a Claude log file when multiple projects share the same basename?**
- Context: Project basename collisions could map two sessions to one log folder if we only use name matching.
- My lean: Agent recommends resolving project path from tmux session CWD and hashing to find the log folder (as in the spec).
- **Answer:**

**Q3: Do you want multi-instance support per project in MVP (e.g., `claude-myproject-2`), or can we treat it as a future edge case?**
- Context: Impacts session naming, discovery, and UI disambiguation.
- My lean: Agent recommends allow numeric suffix on create but keep discovery simple for MVP.
- **Answer:**

**Q4: Should the UI expose a “Kill session” action in MVP, or keep it read-only + open/attach?**
- Context: A kill action is useful but risky without auth.
- My lean: Agent recommends omit kill in MVP UI and keep it backend-only until auth is added.
- **Answer:**

**Q5: What notification behavior do you want when the dashboard tab is focused—sound only, visual badge only, or both?**
- Context: This influences user experience and avoids noisy alerts during active use.
- My lean: Agent recommends sound + favicon badge, browser Notification only when tab is hidden.
- **Answer:**

## Notes for Agents

Ensure the implementation stays aligned with `SPEC.md` (session statuses, XState transitions, and tmux naming). Keep the first milestone shippable with a minimal UI + terminal attach before adding status detection.

## Tasks

- [ ] **Task 1**: Scaffold the project structure and tooling
  - **Files:** `package.json` (create), `tsconfig.json` (create), `vite.config.ts` (create), `tailwind.config.js` (create), `postcss.config.js` (create), `index.html` (create), `src/client/main.tsx` (create), `src/client/App.tsx` (create), `src/client/styles/index.css` (create)
  - **Rationale:** Establish a working React + Vite + Tailwind frontend foundation aligned with the spec.
  - **Dependencies:** none

- [ ] **Task 2**: Create backend server skeleton with HTTP + WebSocket
  - **Files:** `src/server/index.ts` (create), `src/server/types.ts` (create)
  - **Rationale:** Provide an API surface and WebSocket channel for session list/update + terminal I/O.
  - **Dependencies:** Task 1

- [ ] **Task 3**: Implement tmux session discovery and creation
  - **Files:** `src/server/SessionManager.ts` (create)
  - **Rationale:** Core MVP requirement to list and create sessions.
  - **Dependencies:** Task 2

- [ ] **Task 4**: Implement terminal proxy (PTY ↔ WebSocket)
  - **Files:** `src/server/TerminalProxy.ts` (create)
  - **Rationale:** Enables the embedded xterm.js terminal to interact with tmux.
  - **Dependencies:** Task 2

- [ ] **Task 5**: Build frontend session list + terminal embed
  - **Files:** `src/client/components/Dashboard.tsx` (create), `src/client/components/SessionCard.tsx` (create), `src/client/components/Terminal.tsx` (create), `src/client/hooks/useWebSocket.ts` (create), `src/client/stores/sessionStore.ts` (create)
  - **Rationale:** Visible MVP UI and core interaction flow.
  - **Dependencies:** Tasks 1, 2, 3, 4

- [ ] **Task 6**: Implement status detection with JSONL watcher + XState
  - **Files:** `src/server/StatusWatcher.ts` (create), `src/server/statusMachine.ts` (create)
  - **Rationale:** Drives kanban status columns and notifications.
  - **Dependencies:** Tasks 2, 3

- [ ] **Task 7**: Kanban UI + notifications + responsive polish
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/SessionCard.tsx` (modify), `src/client/styles/index.css` (modify), `public/notification.mp3` (add), `public/icon.png` (add)
  - **Rationale:** Complete the MVP user experience with status columns and alerts.
  - **Dependencies:** Tasks 5, 6

- [ ] **Task 8**: Add helper script for launching sessions
  - **Files:** `scripts/claude-session.sh` (create)
  - **Rationale:** Mirrors the spec’s tmux naming convention and simplifies user onboarding.
  - **Dependencies:** Task 3

- [ ] **Task 9**: Documentation and run instructions
  - **Files:** `README.md` (create)
  - **Rationale:** Ensure usage steps are clear (start server/client, session naming, discovery).
  - **Dependencies:** Tasks 1–8

## Risks

- **Log mapping mismatch** (severity: high)
  - **Mitigation:** Derive project path from tmux CWD, compute the same hash Claude uses, and fall back to “unknown” status when no log is found.

- **PTY session stability** (severity: medium)
  - **Mitigation:** Handle WebSocket reconnects and tmux attach errors gracefully; surface errors in UI.

- **Notification noise** (severity: low)
  - **Mitigation:** Gate Notification API to hidden tabs only and debounce repeated status changes.

## Alternatives Considered

- **Use webmux for terminal + add status overlay**: Rejected because it lacks status awareness and would require deep forking.
- **SSE for terminal streaming**: Rejected because terminal input requires bidirectional low-latency messaging.
- **Skip XState and use ad-hoc status flags**: Rejected because the spec already defines a robust state machine that aligns with claude-code-ui.
