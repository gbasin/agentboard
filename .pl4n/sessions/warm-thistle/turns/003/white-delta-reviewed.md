## Bacgkground and Context

- The repository only contains `SPEC.md`; no code, configuration, or tooling scaffolds exist yet.
- `SPEC.md` outlines the desired architecture (web dashboard + tmux terminal embed + JSONL status watcher) but the final implementation will use updated tooling for speed (Bun + oxlint) and a different tmux organization model.
- User feedback confirms Claude log directories are **path-escaped** (e.g., `~/.claude/projects/-Users-gary-code-project/`).
- MVP decision: create a **single parent tmux session** named `agentboard` and manage **windows** inside it; multiple windows per project are supported via numeric suffixes (e.g., `myproject`, `myproject-2`).

## Summary

I will scaffold a full-stack TypeScript app using Bun for runtime/PTY and Vite for the frontend, define shared types and a single WebSocket protocol, then deliver a runnable vertical slice: window discovery + terminal attach with scroll and copy/paste. Next, I will add log-driven status detection, kanban UI, create/kill flows, notifications/responsive polish, and finish with documentation and helper scripts.

## Diagrams (optional)

```
Browser (React) <-> WebSocket <-> Bun server <-> tmux (agentboard session) + ~/.claude logs
         |                                 |
         +---- create/attach/kill ---------+
```

## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | Greenfield repo; we will create all scaffolding (package.json, tsconfig, Vite, Tailwind). | Only `SPEC.md` exists. |
| A2 | Use Bun as runtime/test runner and oxlint for linting; Vite remains for frontend HMR/build. | User requested fastest tooling. |
| A3 | Backend uses Bun server (optionally Hono for routing) and Bun native PTY. | Avoids node-pty compilation and simplifies setup. |
| A4 | Default server port is **4040**, configurable via `PORT`. | User approved. |
| A5 | Session creation UI uses a text input for absolute paths. | User approved. |
| A6 | Notification behavior: sound + favicon badge always; browser Notification only when tab hidden. | User approved. |
| A7 | Status machine uses a simple switch-based implementation (XState optional later). | MVP simplicity. |
| A8 | Log discovery uses **path-escaped** project directory names and selects most recent `.jsonl`. | User feedback indicates correct format. |
| A9 | tmux layout is a single `agentboard` session with windows per project (no separate sessions). | Supports multiple windows per project. |
| A10 | UI includes kill action with confirmation for managed windows only. | User approved. |
| A11 | Terminal UX includes scrollback, wheel/touch scrolling, and copy/paste in/out. | User requested explicit support. |
| A12 | tmux install steps are documented; startup preflight checks for `tmux`. | Addresses setup friction. |

_If revised: ~~old~~ -> new_

### Questions

No open questions at this time. If any assumptions above should change, I will update the plan before implementation.

## Notes for Agents

- Window model: `agentboard` tmux session holds windows; each UI "session" maps to a tmux window target `agentboard:<window-name>`.
- Multi-window per project: use numeric suffixes when `myproject` already exists (`myproject-2`, `myproject-3`).
- Terminal UX: enable xterm scrollback, allow mouse wheel/touch drag scroll, and support copy/paste via the clipboard addon or custom key handling.
- Log discovery: ignore `agent-*.jsonl` subagent logs; tail-read only appended bytes to avoid reprocessing large files.
- If Bun PTY proves unreliable, fall back to node-pty or `tmux capture-pane` streaming (reduced interactivity).

## Tasks

Tasks are organized into **milestones**; each milestone produces a runnable slice.

### Milestone 1: Project Skeleton + Tooling (Runnable: “Hello World” full-stack)

- [ ] **Task 1.1**: Initialize project with TypeScript + ESM
  - **Files:** `package.json` (create), `tsconfig.json` (create), `.gitignore` (create)
  - **Rationale:** Foundation for full-stack TS project.
  - **Dependencies:** none

- [ ] **Task 1.2**: Add Bun + oxlint tooling
  - **Files:** `bunfig.toml` (create), `oxlint.json` (create), `package.json` (modify)
  - **Rationale:** Fast runtime, tests, and linting; add scripts for `dev`, `build`, `lint`, `test`.
  - **Dependencies:** Task 1.1

- [ ] **Task 1.3**: Create shared types module
  - **Files:** `src/shared/types.ts` (create)
  - **Rationale:** Shared Session + WS message types; include `source: 'managed' | 'external'` for future discovery.
  - **Dependencies:** Task 1.1

- [ ] **Task 1.4**: Set up Vite + React + Tailwind
  - **Files:** `vite.config.ts` (create), `tailwind.config.js` (create), `postcss.config.js` (create), `index.html` (create), `src/client/main.tsx` (create), `src/client/App.tsx` (create), `src/client/styles/index.css` (create)
  - **Rationale:** Frontend tooling and baseline UI.
  - **Dependencies:** Task 1.1, Task 1.3

- [ ] **Task 1.5**: Create Bun server + WebSocket handler
  - **Files:** `src/server/index.ts` (create), `src/server/config.ts` (create)
  - **Rationale:** Backend entry point; `PORT` config; WebSocket upgrade route.
  - **Dependencies:** Task 1.1, Task 1.3

- [ ] **Task 1.6**: Configure Vite proxy + dev scripts
  - **Files:** `vite.config.ts` (modify), `package.json` (modify)
  - **Rationale:** Proxy `/ws` to backend during development.
  - **Dependencies:** Task 1.4, Task 1.5

- [ ] **Task 1.7**: Verify hello-world WS communication
  - **Files:** (testing only)
  - **Rationale:** Validate full-stack wiring.
  - **Dependencies:** Task 1.6
  - **Milestone check:** Browser shows “Connected” message from server.

### Milestone 2: Window Discovery (Runnable: list tmux windows)

- [ ] **Task 2.1**: Add prerequisite checks
  - **Files:** `src/server/prerequisites.ts` (create)
  - **Rationale:** Fail fast if `tmux` missing; print install guidance.
  - **Dependencies:** Milestone 1

- [ ] **Task 2.2**: Ensure `agentboard` session exists
  - **Files:** `src/server/SessionManager.ts` (create)
  - **Rationale:** If missing, create detached `agentboard` session.
  - **Dependencies:** Task 2.1

- [ ] **Task 2.3**: List windows + resolve CWD
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** `tmux list-windows -t agentboard`; get CWD via `tmux display-message -p -t agentboard:<window> '#{pane_current_path}'`.
  - **Dependencies:** Task 2.2

- [ ] **Task 2.4**: Create window + name conflict handling
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** `tmux new-window -t agentboard -n <name> -c <path> claude` with suffix on conflicts.
  - **Dependencies:** Task 2.3

- [ ] **Task 2.5**: Kill window (managed only)
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** `tmux kill-window -t agentboard:<window>` for managed windows only.
  - **Dependencies:** Task 2.3

- [ ] **Task 2.6**: Session registry + WS handlers
  - **Files:** `src/server/SessionRegistry.ts` (create), `src/server/index.ts` (modify)
  - **Rationale:** Store windows in-memory; broadcast list; handle create/kill commands.
  - **Dependencies:** Task 2.3

- [ ] **Task 2.7**: Basic session list UI
  - **Files:** `src/client/stores/sessionStore.ts` (create), `src/client/hooks/useWebSocket.ts` (create), `src/client/components/SessionCard.tsx` (create), `src/client/App.tsx` (modify)
  - **Rationale:** Display windows as a simple list (pre-kanban).
  - **Dependencies:** Task 2.6
  - **Milestone check:** Browser lists windows in `agentboard` session.

### Milestone 3: Terminal Embed + UX (Runnable: interactive terminal)

- [ ] **Task 3.1**: TerminalProxy with Bun native PTY
  - **Files:** `src/server/TerminalProxy.ts` (create)
  - **Rationale:** Attach to `tmux attach -t agentboard:<window>` using `Bun.spawn({ pty: true })`.
  - **Dependencies:** Milestone 2

- [ ] **Task 3.2**: Wire PTY I/O and resize
  - **Files:** `src/server/TerminalProxy.ts` (modify), `src/server/index.ts` (modify)
  - **Rationale:** Stream output/input; debounce resize events.
  - **Dependencies:** Task 3.1

- [ ] **Task 3.3**: xterm.js integration
  - **Files:** `src/client/components/Terminal.tsx` (create), `src/client/hooks/useTerminal.ts` (create), `package.json` (modify)
  - **Rationale:** Render terminal, connect to WS.
  - **Dependencies:** Milestone 1

- [ ] **Task 3.4**: Scroll + copy/paste support
  - **Files:** `src/client/components/Terminal.tsx` (modify), `src/client/hooks/useTerminal.ts` (modify)
  - **Rationale:** Enable scrollback, wheel/touch scrolling, selection copy-out, and paste-in shortcuts.
  - **Dependencies:** Task 3.3

- [ ] **Task 3.5**: Integrate terminal in UI
  - **Files:** `src/client/App.tsx` (modify), `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** Click a window card to open terminal panel.
  - **Dependencies:** Task 3.2, Task 3.3
  - **Milestone check:** Keystrokes appear in tmux; scroll + copy/paste works.

### Milestone 4: Status Detection (Runnable: sessions show status)

- [ ] **Task 4.1**: Log discovery
  - **Files:** `src/server/logDiscovery.ts` (create)
  - **Rationale:** Map project path -> escaped dir; choose latest `.jsonl`.
  - **Dependencies:** Milestone 2

- [ ] **Task 4.2**: JSONL parser + events
  - **Files:** `src/server/logParser.ts` (create)
  - **Rationale:** Parse lines into events; ignore malformed lines.
  - **Dependencies:** Task 4.1

- [ ] **Task 4.3**: Status state machine
  - **Files:** `src/server/statusMachine.ts` (create)
  - **Rationale:** Switch-based transitions: working/needs_approval/waiting/idle.
  - **Dependencies:** Task 4.2

- [ ] **Task 4.4**: StatusWatcher
  - **Files:** `src/server/StatusWatcher.ts` (create)
  - **Rationale:** Watch logs (Bun.file().watch or fs.watch); tail-read updates; update registry.
  - **Dependencies:** Task 4.3

- [ ] **Task 4.5**: Broadcast status updates
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Push `session-update` to clients.
  - **Dependencies:** Task 4.4
  - **Milestone check:** Cards update when Claude starts/stops working.

### Milestone 5: Kanban UI (Runnable: full dashboard)

- [ ] **Task 5.1**: Kanban dashboard layout
  - **Files:** `src/client/components/Dashboard.tsx` (create)
  - **Rationale:** 4 columns: Working | Needs Approval | Waiting | Idle.
  - **Dependencies:** Milestone 4

- [ ] **Task 5.2**: Style cards and layout
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/SessionCard.tsx` (modify)
  - **Rationale:** Tailwind styling + status colors.
  - **Dependencies:** Task 5.1

- [ ] **Task 5.3**: Responsive behavior
  - **Files:** `src/client/App.tsx` (modify), `src/client/components/Dashboard.tsx` (modify)
  - **Rationale:** Stack columns on mobile; terminal as fullscreen overlay.
  - **Dependencies:** Task 5.2
  - **Milestone check:** Kanban works on desktop + mobile.

### Milestone 6: Session Management UI (Runnable: create/kill)

- [ ] **Task 6.1**: New Session modal
  - **Files:** `src/client/components/NewSessionModal.tsx` (create)
  - **Rationale:** Path input + create/cancel.
  - **Dependencies:** Milestone 5

- [ ] **Task 6.2**: Header + buttons
  - **Files:** `src/client/components/Header.tsx` (create), `src/client/App.tsx` (modify)
  - **Rationale:** Title, +New Session, refresh, connection indicator.
  - **Dependencies:** Task 6.1

- [ ] **Task 6.3**: Create + kill wiring
  - **Files:** `src/client/hooks/useWebSocket.ts` (modify), `src/client/components/SessionCard.tsx` (modify)
  - **Rationale:** Send create/kill messages; confirm before kill.
  - **Dependencies:** Task 6.1, Task 2.5
  - **Milestone check:** Can create and kill managed windows from browser.

### Milestone 7: Notifications + Polish (Runnable: MVP complete)

- [ ] **Task 7.1**: Notifications + favicon badge
  - **Files:** `src/client/hooks/useNotifications.ts` (create), `src/client/hooks/useFaviconBadge.ts` (create), `public/notification.mp3` (add), `public/favicon.svg` (add)
  - **Rationale:** Sound + badge always; browser Notification only when hidden.
  - **Dependencies:** Milestone 5

- [ ] **Task 7.2**: Error + loading states
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** Show disconnects and graceful errors.
  - **Dependencies:** Milestone 5, Milestone 3

- [ ] **Task 7.3**: WebSocket reconnect with backoff
  - **Files:** `src/client/hooks/useWebSocket.ts` (modify)
  - **Rationale:** Retry 1s, 2s, 4s, 8s… max 30s.
  - **Dependencies:** Task 2.7

- [ ] **Task 7.4**: Terminal resize handling
  - **Files:** `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** ResizeObserver + debounce.
  - **Dependencies:** Milestone 3
  - **Milestone check:** Notifications fire; reconnects work; terminal resizes correctly.

### Milestone 8: Documentation + helper script

- [ ] **Task 8.1**: Helper script
  - **Files:** `scripts/agentboard-window.sh` (create)
  - **Rationale:** Manual window creation: `tmux new-window -t agentboard -n "$(basename $PWD)" -c "$PWD" "claude"`.
  - **Dependencies:** none

- [ ] **Task 8.2**: README
  - **Files:** `README.md` (create)
  - **Rationale:** Setup, prerequisites (Bun, tmux install), usage, ports, naming, troubleshooting.
  - **Dependencies:** All previous milestones
  - **Milestone check:** New user can run the app from README alone.

## Risks

- **Log mapping mismatch** (severity: high)
  - **Mitigation:** Validate `~/.claude/projects` path-escape mapping; fall back to `unknown` if logs missing.

- **Bun PTY limitations** (severity: medium)
  - **Mitigation:** If Bun PTY is unstable, fall back to node-pty or `tmux capture-pane` streaming.

- **tmux not installed or inaccessible** (severity: high)
  - **Mitigation:** Preflight checks in `prerequisites.ts` and README install steps (e.g., `brew install tmux`).

- **Large JSONL logs** (severity: medium)
  - **Mitigation:** Tail-reading only appended bytes; ignore malformed lines.

- **WebSocket instability** (severity: medium)
  - **Mitigation:** Client reconnect backoff; server cleanup on disconnect.

- **Security without authentication** (severity: medium)
  - **Mitigation:** Document LAN/VPN-only usage and require kill confirmation.

## Alternatives Considered

- **Separate tmux sessions per project**: Rejected in favor of a single `agentboard` session with windows to support multiple windows per project.
- **node-pty for PTY**: Rejected for MVP due to native compilation; kept as fallback if Bun PTY fails.
- **Node/Express runtime**: Rejected for MVP in favor of Bun for speed and built-in PTY support.
- **XState in MVP**: Deferred; simple switch-based state machine is sufficient and swappable later.
- **Socket.io instead of ws**: Rejected to keep dependencies light.
