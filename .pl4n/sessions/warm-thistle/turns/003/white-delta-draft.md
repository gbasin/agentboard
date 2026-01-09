## Bacgkground and Context

- The repository currently contains only `SPEC.md`; no code, configuration, or tooling scaffold exists yet.
- `SPEC.md` defines a React + Vite client, Node + Express server, `ws` WebSocket transport, `node-pty` for tmux attachment, and JSONL log watching for status detection.
- User feedback confirms Claude log directories are **path-escaped** (e.g., `~/.claude/projects/-Users-gary-code-project/`).
- MVP decision: create **separate tmux sessions** per project with an `agentboard-<project>` prefix; multiple concurrent sessions per project are supported via numeric suffixes.
- MVP does **not** yet ingest external sessions, but a `DISCOVER_PREFIXES` env var is planned for post-MVP discovery.

## Summary

I will scaffold a full-stack TypeScript app (using fast tooling: bun + oxlint), define shared types and a single WebSocket protocol, then ship a runnable vertical slice: session discovery + terminal attach with good UX (scrolling and copy/paste). After that, I will add log-driven status detection, kanban UI, create/kill flows, notifications/responsive polish, and finalize with documentation and helper scripts.

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
| A1 | Greenfield repo; we will create all scaffolding (package.json, tsconfig, Vite, Tailwind). | Only `SPEC.md` exists. |
| A2 | TypeScript + ESM for both client and server. | Aligns with Vite defaults and shared types. |
| A3 | Default server port is **4040**, configurable via `PORT`. | User approved. |
| A4 | Session creation UI uses a text input for absolute paths. | User approved. |
| A5 | Notification behavior: sound + favicon badge always; browser Notification only when tab hidden. | User approved. |
| A6 | Status machine uses a simple switch-based implementation (XState optional later). | Resolved conflict; MVP simplicity. |
| A7 | Log discovery uses **path-escaped** project directory names. | User feedback indicates this is correct. |
| A8 | Agentboard creates separate tmux sessions named `agentboard-<project>`; multiple sessions per project use numeric suffixes. | Simplest attach/kill semantics; still allows multiple concurrent sessions per project. |
| A9 | UI includes kill action with confirmation, only for managed sessions. | User approved. |
| A10 | Single WebSocket connection per client multiplexes session + terminal messages. | Simplest and standard. |
| A11 | Tooling preference: **bun** for scripts and **oxlint** for linting (fast). | User requested “fastest/best in class”; we will document install steps and fallback to npm if needed. |
| A12 | tmux installation is documented in README (e.g., Homebrew) and verified at startup. | Addresses setup friction. |
| A13 | Terminal UX includes wheel/touch scrolling and copy/paste in/out. | User requested explicit support. |

_If revised: ~~old~~ -> new_

### Questions

No open questions at this time. If any assumptions above should change, I will update the plan before implementation.

## Notes for Agents

- Why separate sessions? It keeps attach/kill semantics simple (`tmux attach -t agentboard-foo`), isolates logs per session, and supports multiple concurrent sessions per project via suffixes. A “parent session with windows” can be added later without reworking the core protocol.
- For terminal UX: enable scrollback, mouse wheel/touch scroll, selection/copy out, and paste in (Ctrl/Cmd+V, context menu). Use a small custom key handler if needed.
- Log discovery should pick the most recently modified `.jsonl` and ignore `agent-*.jsonl` subagent logs.
- Tail-read logs by tracking file offsets; never re-parse the whole file.
- Debounce terminal resize (~100ms) to avoid PTY thrash.
- Post-MVP: add `DISCOVER_PREFIXES` to ingest external sessions and mark them as `source: 'external'` (view-only).

## Tasks

Tasks are organized into **milestones**; each milestone produces a runnable slice.

### Milestone 1: Project Skeleton + Tooling (Runnable: “Hello World” full-stack)

- [ ] **Task 1.1**: Initialize project with TypeScript + ESM
  - **Files:** `package.json` (create), `tsconfig.json` (create), `tsconfig.node.json` (create), `.gitignore` (create), `.nvmrc` (create)
  - **Rationale:** Foundation for a full-stack TS project.
  - **Dependencies:** none

- [ ] **Task 1.2**: Create shared types module
  - **Files:** `src/shared/types.ts` (create)
  - **Rationale:** Shared Session + WS message types; include `source: 'managed' | 'external'` for future discovery.
  - **Dependencies:** Task 1.1

- [ ] **Task 1.3**: Set up Vite + React + Tailwind
  - **Files:** `vite.config.ts` (create), `tailwind.config.js` (create), `postcss.config.js` (create), `index.html` (create), `src/client/main.tsx` (create), `src/client/App.tsx` (create), `src/client/styles/index.css` (create)
  - **Rationale:** Frontend tooling and baseline UI.
  - **Dependencies:** Task 1.1, Task 1.2

- [ ] **Task 1.4**: Create Express server with WebSocket support
  - **Files:** `src/server/index.ts` (create), `src/server/config.ts` (create)
  - **Rationale:** Backend entry point; `PORT` config.
  - **Dependencies:** Task 1.1, Task 1.2

- [ ] **Task 1.5**: Configure Vite proxy + dev scripts
  - **Files:** `vite.config.ts` (modify), `package.json` (modify)
  - **Rationale:** Proxy `/ws` to backend during development.
  - **Dependencies:** Task 1.3, Task 1.4

- [ ] **Task 1.6**: Add fast tooling (bun + oxlint)
  - **Files:** `package.json` (modify), `.oxlintrc.json` (create, if needed)
  - **Rationale:** Faster linting and script execution; document bun install and npm fallback.
  - **Dependencies:** Task 1.1

- [ ] **Task 1.7**: Verify hello-world WS communication
  - **Files:** (testing only)
  - **Rationale:** Validate full-stack wiring.
  - **Dependencies:** Task 1.5
  - **Milestone check:** Browser shows “Connected” message from server.

### Milestone 2: Session Discovery (Runnable: list tmux sessions)

- [ ] **Task 2.1**: Add prerequisite checks
  - **Files:** `src/server/prerequisites.ts` (create)
  - **Rationale:** Fail fast if `tmux` missing.
  - **Dependencies:** Milestone 1

- [ ] **Task 2.2**: Implement SessionManager discovery
  - **Files:** `src/server/SessionManager.ts` (create)
  - **Rationale:** List `agentboard-*` sessions; resolve CWD via `tmux display-message`.
  - **Dependencies:** Task 2.1

- [ ] **Task 2.3**: Implement session creation + name conflict handling
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** Create detached tmux sessions running `claude` in project dir; suffix on conflicts.
  - **Dependencies:** Task 2.2

- [ ] **Task 2.4**: Implement session termination
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** Kill `agentboard-*` sessions; used by UI kill action.
  - **Dependencies:** Task 2.2

- [ ] **Task 2.5**: Session registry + WS handlers
  - **Files:** `src/server/SessionRegistry.ts` (create), `src/server/index.ts` (modify)
  - **Rationale:** Store sessions in-memory; broadcast list; handle create/kill commands.
  - **Dependencies:** Task 2.2

- [ ] **Task 2.6**: Session list UI
  - **Files:** `src/client/stores/sessionStore.ts` (create), `src/client/hooks/useWebSocket.ts` (create), `src/client/components/SessionCard.tsx` (create), `src/client/App.tsx` (modify)
  - **Rationale:** Display discovered sessions as a list (pre-kanban).
  - **Dependencies:** Task 2.5
  - **Milestone check:** Browser lists `agentboard-*` tmux sessions.

### Milestone 3: Terminal Embed (Runnable: interactive terminal)

- [ ] **Task 3.1**: TerminalProxy PTY bridge
  - **Files:** `src/server/TerminalProxy.ts` (create)
  - **Rationale:** Attach to tmux session via node-pty.
  - **Dependencies:** Milestone 2

- [ ] **Task 3.2**: Wire PTY I/O and resize
  - **Files:** `src/server/TerminalProxy.ts` (modify), `src/server/index.ts` (modify)
  - **Rationale:** Stream output/input; debounce resize events.
  - **Dependencies:** Task 3.1

- [ ] **Task 3.3**: Add xterm.js integration
  - **Files:** `src/client/components/Terminal.tsx` (create), `src/client/hooks/useTerminal.ts` (create), `package.json` (modify)
  - **Rationale:** Render terminal and connect to WS.
  - **Dependencies:** Milestone 1

- [ ] **Task 3.4**: Terminal UX (scroll + copy/paste)
  - **Files:** `src/client/components/Terminal.tsx` (modify), `src/client/hooks/useTerminal.ts` (modify)
  - **Rationale:** Enable scrollback, wheel/touch scroll, selection copy-out, and paste-in shortcuts.
  - **Dependencies:** Task 3.3

- [ ] **Task 3.5**: Integrate terminal in UI
  - **Files:** `src/client/App.tsx` (modify), `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** Click a session card to open terminal panel.
  - **Dependencies:** Task 3.2, Task 3.3
  - **Milestone check:** Keystrokes in browser appear in tmux session; scroll + copy/paste works.

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
  - **Rationale:** Watch logs with chokidar; process tail updates; update registry.
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
  - **Milestone check:** Kanban works on desktop + mobile viewports.

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
  - **Dependencies:** Task 6.1, Task 2.4
  - **Milestone check:** Can create and kill sessions from browser.

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
  - **Dependencies:** Task 2.6

- [ ] **Task 7.4**: Terminal resize handling
  - **Files:** `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** ResizeObserver + debounce.
  - **Dependencies:** Milestone 3
  - **Milestone check:** Notifications fire; reconnects work; terminal resizes correctly.

### Milestone 8: Documentation + helper script

- [ ] **Task 8.1**: Helper script
  - **Files:** `scripts/agentboard-session.sh` (create)
  - **Rationale:** Easy manual session creation with correct naming.
  - **Dependencies:** none

- [ ] **Task 8.2**: README
  - **Files:** `README.md` (create)
  - **Rationale:** Setup, prerequisites (tmux install), usage, ports, naming, troubleshooting, bun/oxlint notes.
  - **Dependencies:** All previous milestones
  - **Milestone check:** New user can run the app from README alone.

## Risks

- **Log mapping mismatch** (severity: high)
  - **Mitigation:** Validate `~/.claude/projects` path-escape mapping; fall back to `unknown` if logs missing.

- **node-pty compilation issues** (severity: medium)
  - **Mitigation:** Document prerequisites (Xcode CLI tools). If needed, consider fallback approaches (e.g., `tmux pipe-pane` + `send-keys` or an external `ttyd` subprocess) with reduced interactivity.

- **tmux not installed or inaccessible** (severity: high)
  - **Mitigation:** Preflight checks in `prerequisites.ts` plus README install steps (`brew install tmux`).

- **Bun not installed** (severity: low)
  - **Mitigation:** Document bun install; allow npm scripts as fallback.

- **Large JSONL logs** (severity: medium)
  - **Mitigation:** Tail-reading only appended bytes; ignore malformed lines.

- **WebSocket instability** (severity: medium)
  - **Mitigation:** Client reconnect backoff; server cleanup on disconnect.

- **Security without authentication** (severity: medium)
  - **Mitigation:** Document LAN/VPN-only usage and require kill confirmation.

## Alternatives Considered

- **Socket.io instead of ws**: Rejected to keep dependencies light.
- **Polling instead of WebSocket**: Rejected because terminal I/O needs low-latency bidirectional streaming.
- **Separate client/server packages**: Rejected in favor of a single repo with shared types.
- **XState in MVP**: Deferred; simple switch-based state machine is sufficient and swappable later.
- **node-pty alternatives**: `ttyd` or `tmux pipe-pane` + `send-keys` would reduce integration quality; kept as fallbacks only.
