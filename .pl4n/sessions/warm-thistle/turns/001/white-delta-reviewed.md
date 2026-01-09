## Bacgkground and Context

- The repository currently contains only `SPEC.md`; there are no existing source files, configs, or tooling scaffolds.
- `SPEC.md` defines the intended architecture (React + Vite client, Node + Express server, WebSocket, node-pty, tmux discovery, JSONL status watcher) and a target directory layout under `src/client` and `src/server`.
- The spec references Claude Code JSONL logs under `~/.claude/projects/*/*.jsonl`, but the exact directory naming scheme and log schema are not confirmed in this repo.

## Summary

I will scaffold a full-stack TypeScript app that matches the spec, define shared types and a WebSocket protocol, then implement a working vertical slice: session discovery plus terminal attach. After that, I will add log-driven status detection, evolve the UI into a kanban dashboard with notifications, and finish with responsive polish and documentation.

## Diagrams (optional)

```
Browser (React) <-> WebSocket <-> Node/Express <-> tmux + ~/.claude logs
         |                                 |
         +-- REST or WS commands ----------+
```

## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | This is a greenfield repo; we will create the full scaffold (package.json, tsconfig, Vite, Tailwind, etc.). | Only `SPEC.md` exists. |
| A2 | The project will use TypeScript + ESM for both client and server. | Matches Vite defaults and simplifies shared types. |
| A3 | We will introduce a shared types module under `src/shared/` for Session and WebSocket messages. | Avoids client/server drift. |
| A4 | The backend runs on the same machine as tmux, with access to `tmux` and `~/.claude`. | Required for session discovery and log watching. |
| A5 | A single WebSocket connection per client will multiplex session updates and terminal I/O. | Keeps protocol simple and reduces connection overhead. |

_If revised: ~~old~~ -> new_

### Questions

**Q1: What is the correct Claude log directory mapping for a project path (escaped path vs hash or something else)?**
- Context: Status detection depends on mapping a tmux session CWD to a log directory.
- My lean: Agent recommends implementing a configurable strategy and validating against your local `~/.claude/projects` structure before finalizing.
- **Answer:**

**Q2: Should we follow the spec and use XState, or a simpler hand-rolled state machine?**
- Context: XState adds dependency and boilerplate but aligns with `claude-code-ui`.
- My lean: Agent recommends using XState to match the spec unless you want to reduce dependencies.
- **Answer:**

**Q3: Do you want session discovery limited to `claude-*`, or allow a configurable prefix/regex?**
- Context: Existing sessions may use different naming conventions.
- My lean: Agent recommends default `claude-` with an env override for flexibility.
- **Answer:**

**Q4: Should the MVP expose a session kill action in the UI?**
- Context: Useful but risky without authentication when remote access is enabled.
- My lean: Agent recommends omit from the UI in MVP, keep backend capability behind explicit API calls.
- **Answer:**

**Q5: How should the "New Session" flow capture the project path (manual text input, recent paths list, or both)?**
- Context: Browsers cannot easily open native directory pickers.
- My lean: Agent recommends a simple text input with optional recent-path suggestions.
- **Answer:**

**Q6: Preferred default port for the server?**
- Context: Needed for Vite proxy and deployment docs.
- My lean: Agent recommends `4040` with `PORT` env override.
- **Answer:**

## Notes for Agents

Keep the first milestone shippable: list sessions, open a terminal, and send keystrokes. Isolate log parsing and status transitions so the JSONL format can change without affecting the rest of the system. Cleanly handle attach/detach and WebSocket disconnects to avoid orphaned PTYs.

## Tasks

- [ ] **Task 1**: Scaffold project tooling and base structure
  - **Files:** `package.json` (create), `tsconfig.json` (create), `tsconfig.node.json` (create), `vite.config.ts` (create), `tailwind.config.js` (create), `postcss.config.js` (create), `index.html` (create), `.gitignore` (create), `.nvmrc` (create)
  - **Rationale:** Establish build/run tooling for a full-stack TypeScript app with Vite + Tailwind.
  - **Dependencies:** none

- [ ] **Task 2**: Define shared types and WebSocket protocol
  - **Files:** `src/shared/types.ts` (create)
  - **Rationale:** Single source of truth for Session, SessionStatus, and WS message shapes.
  - **Dependencies:** Task 1

- [ ] **Task 3**: Backend skeleton and config
  - **Files:** `src/server/index.ts` (create), `src/server/config.ts` (create), `src/server/prerequisites.ts` (create), `src/server/SessionRegistry.ts` (create)
  - **Rationale:** Start the server, validate tmux availability, and centralize session state.
  - **Dependencies:** Task 2

- [ ] **Task 4**: tmux session discovery and management
  - **Files:** `src/server/SessionManager.ts` (create)
  - **Rationale:** Discover `claude-*` sessions, resolve CWD, and support session creation (and optional kill).
  - **Dependencies:** Task 3

- [ ] **Task 5**: WebSocket handlers for sessions and commands
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Broadcast session lists/updates and accept create/attach/resize messages.
  - **Dependencies:** Tasks 3, 4

- [ ] **Task 6**: Terminal proxy (PTY <-> WebSocket)
  - **Files:** `src/server/TerminalProxy.ts` (create)
  - **Rationale:** Attach to tmux sessions via node-pty and stream I/O to the browser.
  - **Dependencies:** Task 5

- [ ] **Task 7**: Frontend app shell and session list
  - **Files:** `src/client/main.tsx` (create), `src/client/App.tsx` (create), `src/client/hooks/useWebSocket.ts` (create), `src/client/stores/sessionStore.ts` (create), `src/client/components/Dashboard.tsx` (create), `src/client/components/SessionCard.tsx` (create), `src/client/styles/index.css` (create)
  - **Rationale:** Display sessions and provide selection and connection state.
  - **Dependencies:** Tasks 1, 2, 5

- [ ] **Task 8**: Terminal UI integration
  - **Files:** `src/client/components/Terminal.tsx` (create), `src/client/hooks/useTerminal.ts` (create)
  - **Rationale:** Render xterm.js and wire terminal attach/detach/input/resize.
  - **Dependencies:** Tasks 6, 7

- [ ] **Task 9**: Log discovery and status detection
  - **Files:** `src/server/logDiscovery.ts` (create), `src/server/logParser.ts` (create), `src/server/statusMachine.ts` (create), `src/server/StatusWatcher.ts` (create)
  - **Rationale:** Map sessions to logs, parse JSONL incrementally, and compute status transitions.
  - **Dependencies:** Tasks 3, 4

- [ ] **Task 10**: Kanban UI and status-driven updates
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/SessionCard.tsx` (modify), `src/client/App.tsx` (modify)
  - **Rationale:** Group sessions by status and reflect live updates in the UI.
  - **Dependencies:** Tasks 7, 9

- [ ] **Task 11**: Notifications and responsive polish
  - **Files:** `src/client/hooks/useNotifications.ts` (create), `src/client/hooks/useFaviconBadge.ts` (create), `src/client/components/Terminal.tsx` (modify), `public/notification.mp3` (add), `public/favicon.svg` (add)
  - **Rationale:** Alert on needs_approval, add favicon badge, and tune mobile/desktop layouts.
  - **Dependencies:** Task 10

- [ ] **Task 12**: Session creation UI and helper script
  - **Files:** `src/client/components/NewSessionModal.tsx` (create), `src/client/components/Header.tsx` (create), `scripts/claude-session.sh` (create)
  - **Rationale:** Enable creating new sessions via UI and provide CLI helper for manual starts.
  - **Dependencies:** Tasks 4, 7

- [ ] **Task 13**: Documentation
  - **Files:** `README.md` (create)
  - **Rationale:** Provide setup, run, and usage instructions (including tmux naming and log expectations).
  - **Dependencies:** Tasks 1-12

## Risks

- **Log mapping mismatch** (severity: high)
  - **Mitigation:** Confirm actual `~/.claude/projects` naming and keep log discovery pluggable; fall back to `unknown`.

- **node-pty build failures** (severity: medium)
  - **Mitigation:** Document prerequisites (Xcode CLI tools) and provide a clear startup error.

- **tmux not installed or inaccessible** (severity: high)
  - **Mitigation:** Preflight checks on startup and actionable error messages.

- **Large JSONL logs** (severity: medium)
  - **Mitigation:** Tail only appended bytes and guard against malformed lines.

- **WebSocket instability** (severity: medium)
  - **Mitigation:** Client reconnect with backoff and server-side cleanup on disconnect.

## Alternatives Considered

- **Socket.io instead of ws**: Rejected to keep the dependency surface small.
- **Polling instead of WebSocket**: Rejected because terminal I/O needs low-latency bidirectional streaming.
- **Separate client/server packages**: Rejected in favor of a single repo with shared types.
- **Hand-rolled status flags**: Rejected unless you prefer fewer dependencies; spec already outlines a state machine approach.
