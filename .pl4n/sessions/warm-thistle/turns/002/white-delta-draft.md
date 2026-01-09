## Bacgkground and Context

- The repository currently contains only `SPEC.md`; there is no code, config, or tooling scaffold yet.
- `SPEC.md` specifies a React + Vite client, Node + Express server, `ws` WebSocket transport, `node-pty` for tmux attachment, and JSONL log watching for status detection.
- User feedback indicates Claude log directories are likely **path-escaped** (e.g., `~/.claude/projects/-Users-gary-code-project/`) rather than hashed, but this has not been validated in this repo.
- There is an open product decision about tmux organization: create sessions per project vs. create windows under a single `agentboard` session and optionally ingest other sessions/windows on the machine.

## Summary

I will scaffold a full-stack TypeScript app, define shared types and a WebSocket protocol, and deliver a working vertical slice: session discovery + terminal attach. Then I will add log-driven status detection, evolve the UI into a kanban dashboard with notifications and responsive polish, and finalize with creation/kill flows and documentation—while incorporating the chosen tmux organization mode.

## Diagrams (optional)

```
Browser (React) <-> WebSocket <-> Node/Express <-> tmux + ~/.claude logs
         |                                 |
         +---- create/attach/kill ---------+
```

## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | This is a greenfield repo; we will create all scaffolding (package.json, tsconfig, Vite, Tailwind). | Only `SPEC.md` exists. |
| A2 | We will use TypeScript + ESM for both client and server. | Aligns with Vite defaults and shared typing. |
| A3 | Default server port is **4040** (configurable via `PORT`). | User confirmed “ok”. |
| A4 | Session creation UI will use a text input for absolute path. | User confirmed “ok”. |
| A5 | Notification behavior: sound + favicon badge always; browser Notification API only when tab is hidden. | User confirmed “ok”. |
| A6 | Status machine will be a simple switch-based implementation (XState optional later). | User feedback favored the simpler approach. |
| A7 | Log discovery will default to **path-escaped** directory names but remain configurable. | User feedback suggests escaping; still needs confirmation. |

_If revised: ~~old~~ -> new_

### Questions

**Q1: Should Agentboard-managed sessions live as windows inside a single tmux session (e.g., `agentboard`), or as separate tmux sessions per project?**
- Context: This affects creation, discovery, attach targets, and kill semantics.
- Agent recommends: Start with **separate tmux sessions per project** for MVP (simpler mapping), then optionally add `agentboard`-session windows as an alternate mode.
- **Answer:**

**Q2: If we support ingesting external sessions/windows, what should be in scope for MVP (only `claude-*`, or any tmux session/window with opt-in rules)?**
- Context: Impacts discovery filters and UI clarity.
- Agent recommends: Default to `claude-*` (or `agentboard-*`) plus an env-controlled prefix list.
- **Answer:**

**Q3: Preferred naming convention for new sessions?**
- Context: You mentioned “maybe agentboard prefix,” which conflicts with the spec’s `claude-` prefix.
- Agent recommends: Use `agentboard-<project>` for sessions created by the app, and still discover `claude-*` as external.
- **Answer:**

**Q4: Do you want a kill action in the UI for **all** sessions, or only for agentboard-managed ones?**
- Context: Killing external sessions could be risky, especially without auth.
- Agent recommends: Allow kill only for agentboard-managed sessions, with a confirm prompt.
- **Answer:**

**Q5: Please confirm the Claude log directory mapping (path-escaped vs hash) from your local `~/.claude/projects/` folder.**
- Context: Status detection depends on locating the correct JSONL file per project.
- Agent recommends: Use path-escaped mapping if that matches your local structure; otherwise switch to the correct hash scheme.
- **Answer:**

## Notes for Agents

- Keep the first milestone shippable: list sessions, open a terminal, and send keystrokes end-to-end.
- Isolate log parsing, discovery, and status transitions so changes in Claude log format don’t destabilize the system.
- If we adopt the single `agentboard` tmux session with windows, treat each window as a “session” in the UI, and use `tmux attach -t agentboard:<window>`.
- External references to consult during implementation (if needed): wetty (PTY ↔ WS patterns), claude-code-ui (JSONL parsing), react-xtermjs (hook wrapper). No browsing is needed for planning.

## Tasks

- [ ] **Task 1**: Scaffold project tooling and base structure
  - **Files:** `package.json` (create), `tsconfig.json` (create), `tsconfig.node.json` (create), `vite.config.ts` (create), `tailwind.config.js` (create), `postcss.config.js` (create), `index.html` (create), `.gitignore` (create), `.nvmrc` (create)
  - **Rationale:** Establish build/run tooling for a full-stack TypeScript app with Vite + Tailwind.
  - **Dependencies:** none

- [ ] **Task 2**: Define shared types and WebSocket protocol
  - **Files:** `src/shared/types.ts` (create)
  - **Rationale:** Single source of truth for Session, SessionStatus, and WS message shapes.
  - **Dependencies:** Task 1

- [ ] **Task 3**: Backend skeleton, config, and prerequisites
  - **Files:** `src/server/index.ts` (create), `src/server/config.ts` (create), `src/server/prerequisites.ts` (create), `src/server/SessionRegistry.ts` (create)
  - **Rationale:** Start the server, validate tmux availability, and centralize session state.
  - **Dependencies:** Task 2

- [ ] **Task 4**: tmux discovery and management (mode-dependent)
  - **Files:** `src/server/SessionManager.ts` (create)
  - **Rationale:** Implement discovery/creation/kill based on chosen model:
    - **Separate sessions**: list `tmux list-sessions`, create `agentboard-<project>` (or `claude-<project>`), kill session.
    - **Agentboard session + windows**: list `tmux list-windows -t agentboard`, create new window per project, kill window.
  - **Dependencies:** Task 3

- [ ] **Task 5**: WebSocket handlers for session commands and updates
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Broadcast session lists/updates and accept create/attach/resize/kill messages.
  - **Dependencies:** Tasks 3, 4

- [ ] **Task 6**: Terminal proxy (PTY <-> WebSocket)
  - **Files:** `src/server/TerminalProxy.ts` (create)
  - **Rationale:** Attach to tmux targets and stream I/O to the browser; handle detach and cleanup.
  - **Dependencies:** Task 5

- [ ] **Task 7**: Frontend app shell and session list
  - **Files:** `src/client/main.tsx` (create), `src/client/App.tsx` (create), `src/client/hooks/useWebSocket.ts` (create), `src/client/stores/sessionStore.ts` (create), `src/client/components/Dashboard.tsx` (create), `src/client/components/SessionCard.tsx` (create), `src/client/styles/index.css` (create)
  - **Rationale:** Display sessions, select active session, and show connection state.
  - **Dependencies:** Tasks 1, 2, 5

- [ ] **Task 8**: Terminal UI integration
  - **Files:** `src/client/components/Terminal.tsx` (create), `src/client/hooks/useTerminal.ts` (create)
  - **Rationale:** Render xterm.js and wire terminal attach/detach/input/resize.
  - **Dependencies:** Tasks 6, 7

- [ ] **Task 9**: Log discovery and status detection
  - **Files:** `src/server/logDiscovery.ts` (create), `src/server/logParser.ts` (create), `src/server/statusMachine.ts` (create), `src/server/StatusWatcher.ts` (create)
  - **Rationale:** Locate JSONL logs, parse incremental updates, and compute status transitions.
  - **Dependencies:** Tasks 3, 4

- [ ] **Task 10**: Kanban UI and status-driven updates
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/SessionCard.tsx` (modify), `src/client/App.tsx` (modify)
  - **Rationale:** Group sessions by status and reflect live updates in the UI.
  - **Dependencies:** Tasks 7, 9

- [ ] **Task 11**: Notifications, favicon badge, and responsive polish
  - **Files:** `src/client/hooks/useNotifications.ts` (create), `src/client/hooks/useFaviconBadge.ts` (create), `src/client/components/Terminal.tsx` (modify), `public/notification.mp3` (add), `public/favicon.svg` (add)
  - **Rationale:** Alert on needs_approval, add visual badge, and optimize mobile/desktop layout.
  - **Dependencies:** Task 10

- [ ] **Task 12**: Session creation + kill UI
  - **Files:** `src/client/components/NewSessionModal.tsx` (create), `src/client/components/Header.tsx` (create), `src/client/components/SessionCard.tsx` (modify)
  - **Rationale:** Enable creating sessions and killing **managed** sessions with confirmation.
  - **Dependencies:** Tasks 4, 7

- [ ] **Task 13**: Helper script + documentation
  - **Files:** `scripts/claude-session.sh` (create), `README.md` (create)
  - **Rationale:** Provide CLI helper and usage instructions (naming, discovery, ports, prerequisites).
  - **Dependencies:** Tasks 1-12

## Risks

- **Log mapping mismatch** (severity: high)
  - **Mitigation:** Confirm actual `~/.claude/projects` naming; keep discovery strategy configurable; fall back to `unknown`.

- **tmux organization decision churn** (severity: medium)
  - **Mitigation:** Implement a `SESSION_MODE` config early (sessions vs windows) to limit refactors.

- **node-pty build failures** (severity: medium)
  - **Mitigation:** Document prerequisites (Xcode CLI tools) and surface clear startup errors.

- **Unintended session kills** (severity: medium)
  - **Mitigation:** Restrict kill to agentboard-managed sessions and require explicit confirmation.

- **Large JSONL logs** (severity: medium)
  - **Mitigation:** Tail only appended bytes and handle malformed lines gracefully.

- **WebSocket instability** (severity: medium)
  - **Mitigation:** Client reconnect with backoff; server cleanup on disconnect.

## Alternatives Considered

- **Socket.io instead of ws**: Rejected to keep dependencies light.
- **Polling instead of WebSocket**: Rejected because terminal I/O needs low-latency bidirectional streaming.
- **Separate client/server packages**: Rejected in favor of a single repo with shared types.
- **XState in MVP**: Deferred in favor of a smaller switch-based state machine; can swap later.
