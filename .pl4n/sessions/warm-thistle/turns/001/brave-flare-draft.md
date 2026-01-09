# Agentboard Implementation Plan

## Background and Context

### Project State
This is a **greenfield project** with only `SPEC.md` containing the complete specification. No code exists yet.

### What We're Building
A web dashboard that combines:
- **Kanban board** - Sessions grouped by status (Working, Needs Approval, Waiting, Idle)
- **Terminal embed** - Interactive xterm.js connected to actual tmux sessions via WebSocket
- **Status detection** - Real-time parsing of Claude Code JSONL logs
- **Notifications** - Browser alerts when sessions need approval

### Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Browser (React + Vite)                          │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  Kanban Dashboard                Terminal Panel (xterm.js)       │  │
│  │  [Working] [Approval] [Waiting] [Idle]    ┌─────────────────┐   │  │
│  │   [card]    [card]                        │ $ claude        │   │  │
│  │   [card]                                  │ Reading file... │   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                              │ WebSocket
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│                      Node.js + Express Backend                         │
│                                                                        │
│  SessionManager         StatusWatcher           TerminalProxy          │
│  - tmux list-sessions   - chokidar watch       - node-pty spawn        │
│  - tmux new-session     - JSONL parsing        - attach to tmux        │
│  - tmux kill-session    - State machine        - bidirectional I/O     │
│                                                                        │
│                    Session Registry (in-memory Map)                    │
└───────────────────────────────────────────────────────────────────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐      ┌─────────────────────┐
│  tmux sessions  │      │  ~/.claude/projects │
│  claude-*       │      │  {escaped-path}/*.jsonl │
└─────────────────┘      └─────────────────────┘
```

### Tech Stack (per SPEC)
| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite + TypeScript |
| Styling | Tailwind CSS |
| Terminal | xterm.js + xterm-addon-fit + xterm-addon-webgl |
| Client state | Zustand |
| Backend | Node.js + Express (ESM) |
| WebSocket | ws library |
| PTY | node-pty |
| File watching | chokidar |
| State machine | XState v5 |

### Key Data Structures

```typescript
// src/shared/types.ts - Shared between client and server

export interface Session {
  id: string              // UUID
  name: string            // Display name (folder basename)
  tmuxSession: string     // e.g., "claude-myproject"
  projectPath: string     // /Users/gary/code/myproject
  status: SessionStatus
  lastActivity: Date
  logFile?: string        // Path to JSONL being watched
}

export type SessionStatus =
  | 'working'         // Claude actively processing
  | 'needs_approval'  // Waiting for tool approval
  | 'waiting'         // Claude done, waiting for user
  | 'idle'            // No activity for 5+ minutes
  | 'unknown'         // Can't determine status

// WebSocket message types (discriminated union)
export type ServerMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session-update'; session: Session }
  | { type: 'terminal-output'; sessionId: string; data: string }
  | { type: 'error'; message: string }

export type ClientMessage =
  | { type: 'terminal-attach'; sessionId: string }
  | { type: 'terminal-detach'; sessionId: string }
  | { type: 'terminal-input'; sessionId: string; data: string }
  | { type: 'terminal-resize'; sessionId: string; cols: number; rows: number }
  | { type: 'session-create'; projectPath: string; name?: string }
  | { type: 'session-kill'; sessionId: string }
```

### Claude Code JSONL Log Format (Discovered)

Project directories use **path escaping** (not SHA256 hashing):
- `/Users/gary/code/project` → `~/.claude/projects/-Users-gary-code-project/`

Log entries are JSON objects with key fields:
```typescript
interface LogEntry {
  type: 'user' | 'assistant' | 'system'
  message?: {
    role: 'user' | 'assistant'
    content: string | ContentBlock[]
  }
  // For assistant messages with tool use:
  // - stop_reason: "tool_use" means waiting for approval
  // - stop_reason: "end_turn" means turn complete
}

// Content blocks in assistant messages:
type ContentBlock =
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
```

Status detection from log events:
- `type: "user"` with regular content → USER_PROMPT → working
- `type: "assistant"` with `stop_reason: "tool_use"` → ASSISTANT_TOOL_USE → needs_approval
- `type: "user"` with `tool_result` in content → TOOL_RESULT → working
- `type: "assistant"` with `stop_reason: "end_turn"` → TURN_END → waiting

---

## Summary

Build a full-stack TypeScript application from scratch using Vite+React frontend and Express+node-pty backend with **shared types** for type safety. The implementation follows an incremental approach: (1) project scaffolding with shared types and working dev server, (2) session discovery via tmux commands, (3) terminal proxy using node-pty to attach to tmux sessions, (4) status detection by parsing Claude Code JSONL logs with a state machine, (5) responsive kanban UI with Tailwind, and (6) browser notifications.

---

## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | Monorepo structure with `src/client`, `src/server`, and `src/shared` | Shared types between client/server eliminates drift; SPEC directory structure supports this |
| A2 | Vite dev proxy forwards API/WebSocket to Express on port 4040 | Standard pattern; avoids CORS during development |
| A3 | Production bundles frontend into `dist/client/`, served by Express | Single-process deployment; Express serves static files |
| A4 | Session naming uses `claude-{basename}` convention | SPEC defines this; dashboard filters to `claude-*` prefix |
| A5 | tmux CWD obtainable via `tmux display-message -p -t {session} '#{pane_current_path}'` | Standard tmux command for getting pane working directory |
| A6 | Claude Code log directories use path escaping: `/a/b/c` → `-a-b-c` | Verified by examining `~/.claude/projects/` structure |
| A7 | Single WebSocket connection per client, multiplexed by message type | Cleaner than multiple connections; differentiated by `type` field |
| A8 | node-pty compiles successfully on macOS with Xcode CLI tools | Standard setup; will document prerequisites |
| A9 | Use ESM (`"type": "module"`) for both client and server | Modern standard; Vite requires ESM |
| A10 | Large log files handled by reading only recent lines (tail-like behavior) | JSONL logs can grow large; don't want to parse entire history |

### Questions

**Q1: Should we use XState v5 or a simpler state machine implementation?**
- Context: XState adds complexity but provides robust state management
- Agent recommends: Start with a simple hand-rolled state machine (switch statement). XState is overkill for 5 states with simple transitions. Can upgrade later if needed.
- **Answer:** _(pending)_

**Q2: Default port number?**
- Context: Need a port for the web server
- Agent recommends: Port 4040 (avoids common dev ports like 3000, 5173, 8080). Configurable via `PORT` env var.
- **Answer:** _(pending)_

**Q3: Session creation UI - directory picker approach?**
- Context: Web browsers can't do native directory pickers easily
- Agent recommends: Text input for absolute path. Simple and works. Users are developers who know their paths.
- **Answer:** _(pending)_

**Q4: Should we support manual refresh of sessions in addition to auto-polling?**
- Context: User might want to force-refresh the session list
- Agent recommends: Yes, add a small refresh button in the header. Low effort, useful for debugging.
- **Answer:** _(pending)_

---

## Diagrams

### Status State Machine

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
┌─────────┐    LOG_FOUND    ┌─────────┐    USER_PROMPT    ┌───┴─────┐
│ unknown │ ───────────────►│  idle   │ ─────────────────►│ working │
└─────────┘                 └─────────┘                   └────┬────┘
     │                           ▲                             │
     │                           │                             │
     │         after 5 min       │                             │
     │      ┌────────────────────┘        ASSISTANT_TOOL_USE   │
     │      │                                                  ▼
     │      │                                        ┌─────────────────┐
     │      │                                        │ needs_approval  │
     │      │                                        └────────┬────────┘
     │      │                                                 │
     │      │                              TOOL_RESULT        │
     │      │                       ┌─────────────────────────┘
     │      │                       │
     │      │                       ▼
     │      │  USER_PROMPT    ┌─────────┐
     └──────┼────────────────►│ waiting │
            │                 └─────────┘
            │                       │
            └───────────────────────┘
                 after 5 min
```

### WebSocket Message Flow

```
┌────────────┐                              ┌────────────┐
│   Client   │                              │   Server   │
└─────┬──────┘                              └─────┬──────┘
      │                                           │
      │  ──────── connect ────────────────────►   │
      │                                           │
      │  ◄─────── {type: 'sessions', [...]} ───   │
      │                                           │
      │  ◄─────── {type: 'session-update', s} ─   │  (on status change)
      │                                           │
      │  ──────── {type: 'session-create', p} ──► │
      │                                           │
      │  ◄─────── {type: 'sessions', [...]} ───   │  (updated list)
      │                                           │
      │  ──────── {type: 'terminal-attach', id} ► │
      │                                           │
      │  ◄─────── {type: 'terminal-output', d} ─  │  (PTY output stream)
      │                                           │
      │  ──────── {type: 'terminal-input', d} ──► │  (user keystrokes)
      │                                           │
      │  ──────── {type: 'terminal-resize', c,r}► │  (debounced)
      │                                           │
      │  ──────── {type: 'terminal-detach', id} ► │
      │                                           │
      │  ◄─────── {type: 'error', msg} ─────────  │  (on any error)
      │                                           │
```

### Directory Structure

```
agentboard/
├── SPEC.md
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── .gitignore
├── .nvmrc
│
├── src/
│   ├── shared/                 # Shared between client & server
│   │   └── types.ts            # Session, SessionStatus, WSMessage types
│   │
│   ├── client/                 # Frontend
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Header.tsx
│   │   │   ├── Dashboard.tsx
│   │   │   ├── SessionCard.tsx
│   │   │   ├── Terminal.tsx
│   │   │   └── NewSessionModal.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   ├── useTerminal.ts
│   │   │   ├── useNotifications.ts
│   │   │   └── useFaviconBadge.ts
│   │   ├── stores/
│   │   │   └── sessionStore.ts
│   │   └── styles/
│   │       └── index.css
│   │
│   └── server/                 # Backend
│       ├── index.ts            # Entry point, WebSocket handler
│       ├── config.ts           # Environment variables
│       ├── prerequisites.ts    # Check tmux/claude installed
│       ├── SessionManager.ts   # tmux discovery/creation
│       ├── SessionRegistry.ts  # In-memory session store
│       ├── StatusWatcher.ts    # Log file watching orchestration
│       ├── logDiscovery.ts     # Find log files from project path
│       ├── logParser.ts        # Parse JSONL log lines
│       ├── statusMachine.ts    # Simple state machine
│       └── TerminalProxy.ts    # WebSocket ↔ PTY bridge
│
├── public/
│   ├── favicon.svg
│   ├── favicon-badge.svg
│   └── notification.mp3
│
└── scripts/
    └── claude-session.sh       # Helper script for manual session creation
```

---

## Notes for Agents

### Reference Code in SPEC.md
- Status machine: SPEC lines 138-170 has XState-style configuration (adapt to simple switch)
- Terminal proxy: SPEC lines 185-216 has node-pty spawn arguments for tmux attach
- Session manager: SPEC lines 223-250 has tmux command examples
- Notifications: SPEC lines 366-388 has browser notification code

### Key Implementation Details

1. **Log directory discovery**: Convert project path to escaped format by replacing `/` with `-` (leading slash becomes leading dash)

2. **Log file selection**: Use most recently modified `.jsonl` file in the project's log directory (exclude `agent-*.jsonl` files which are subagent logs)

3. **Log tail reading**: Track file size, on 'change' event read only bytes after previous position

4. **Resize debouncing**: 100ms debounce prevents PTY thrashing during window resize drag

5. **Session refresh interval**: 5000ms poll catches external session changes

6. **State machine timeouts**: 5min idle transition (300000ms)

7. **WebSocket reconnect backoff**: 1s, 2s, 4s, 8s... max 30s

### Mobile Layout Guidance
- Use Tailwind responsive classes (`md:grid-cols-4`, below that stack vertically)
- "Needs Approval" column: Use amber/red background (`bg-amber-50 border-amber-200`)
- Terminal sizing: CSS `height: 300px` on desktop, `100vh` minus header on mobile
- Terminal view is fullscreen overlay on mobile with back button

---

## Tasks

### Phase 1: Project Skeleton

- [ ] **Task 1.1**: Initialize npm project with TypeScript and ESM configuration
  - **Files:** `package.json` (create), `tsconfig.json` (create), `tsconfig.node.json` (create), `.gitignore` (create), `.nvmrc` (create)
  - **Rationale:** Foundation for TypeScript ESM project; .nvmrc ensures Node 20+
  - **Dependencies:** none

- [ ] **Task 1.2**: Create shared types module
  - **Files:** `src/shared/types.ts` (create)
  - **Rationale:** Single source of truth for Session, SessionStatus, and WebSocket message types
  - **Dependencies:** Task 1.1

- [ ] **Task 1.3**: Set up Vite with React and Tailwind CSS
  - **Files:** `vite.config.ts` (create), `tailwind.config.js` (create), `postcss.config.js` (create), `index.html` (create), `src/client/main.tsx` (create), `src/client/App.tsx` (create), `src/client/styles/index.css` (create)
  - **Rationale:** Frontend tooling with hot reload; Tailwind for responsive utility-first styling
  - **Dependencies:** Task 1.1, Task 1.2

- [ ] **Task 1.4**: Create Express server with WebSocket support
  - **Files:** `src/server/index.ts` (create), `src/server/config.ts` (create)
  - **Rationale:** Backend entry point; ws library for WebSocket; config.ts for PORT and env vars
  - **Dependencies:** Task 1.1, Task 1.2

- [ ] **Task 1.5**: Configure Vite proxy to forward /ws to Express
  - **Files:** `vite.config.ts` (modify), `package.json` (modify - add concurrently, dev scripts)
  - **Rationale:** WebSocket proxy enables frontend-backend communication during development
  - **Dependencies:** Task 1.3, Task 1.4

- [ ] **Task 1.6**: Verify hello-world WebSocket communication
  - **Files:** (testing only)
  - **Rationale:** Confirm full-stack setup works before building features
  - **Dependencies:** Task 1.5

### Phase 2: Session Management Backend

- [ ] **Task 2.1**: Add prerequisite check utility
  - **Files:** `src/server/prerequisites.ts` (create)
  - **Rationale:** Check that tmux is installed; fail fast with helpful error
  - **Dependencies:** Phase 1

- [ ] **Task 2.2**: Create SessionManager class with tmux discovery
  - **Files:** `src/server/SessionManager.ts` (create)
  - **Rationale:** List tmux sessions matching `claude-*` prefix; extract CWD via `tmux display-message`
  - **Dependencies:** Task 2.1

- [ ] **Task 2.3**: Implement session creation (tmux new-session)
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** Create detached tmux session running `claude` in specified directory
  - **Dependencies:** Task 2.2

- [ ] **Task 2.4**: Implement session termination (tmux kill-session)
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** Allow dashboard to close sessions
  - **Dependencies:** Task 2.2

- [ ] **Task 2.5**: Create Session Registry with EventEmitter
  - **Files:** `src/server/SessionRegistry.ts` (create)
  - **Rationale:** In-memory Map of sessions; emits events on changes
  - **Dependencies:** Task 2.2

- [ ] **Task 2.6**: Add WebSocket message handlers for session operations
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Handle `session-create`, `session-kill` messages; broadcast session list
  - **Dependencies:** Task 2.5

- [ ] **Task 2.7**: Periodic session refresh (poll tmux every 5s)
  - **Files:** `src/server/SessionManager.ts` (modify), `src/server/index.ts` (modify)
  - **Rationale:** Detect sessions created/killed outside dashboard
  - **Dependencies:** Task 2.5

### Phase 3: Terminal Proxy

- [ ] **Task 3.1**: Create TerminalProxy class with node-pty
  - **Files:** `src/server/TerminalProxy.ts` (create)
  - **Rationale:** Spawn PTY that attaches to tmux session
  - **Dependencies:** Phase 2

- [ ] **Task 3.2**: Implement attach/detach lifecycle
  - **Files:** `src/server/TerminalProxy.ts` (modify)
  - **Rationale:** Create PTY on attach, kill on detach; handle WebSocket close cleanup
  - **Dependencies:** Task 3.1

- [ ] **Task 3.3**: Implement resize handler with debouncing
  - **Files:** `src/server/TerminalProxy.ts` (modify)
  - **Rationale:** Debounce resize events (100ms) to avoid PTY thrashing
  - **Dependencies:** Task 3.2

- [ ] **Task 3.4**: Wire PTY I/O to WebSocket messages
  - **Files:** `src/server/TerminalProxy.ts` (modify), `src/server/index.ts` (modify)
  - **Rationale:** Forward PTY output to client, client input to PTY
  - **Dependencies:** Task 3.3

- [ ] **Task 3.5**: Add xterm.js with addons to frontend
  - **Files:** `src/client/components/Terminal.tsx` (create), `package.json` (modify)
  - **Rationale:** Web terminal emulator; fit addon for auto-resize
  - **Dependencies:** Phase 1

- [ ] **Task 3.6**: Create useTerminal hook for WebSocket terminal I/O
  - **Files:** `src/client/hooks/useTerminal.ts` (create)
  - **Rationale:** Encapsulate terminal attach/detach/input/resize logic
  - **Dependencies:** Task 3.5

- [ ] **Task 3.7**: Wire Terminal component to useTerminal hook
  - **Files:** `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** Connect xterm.js instance to hook
  - **Dependencies:** Task 3.5, Task 3.6

- [ ] **Task 3.8**: Test interactive terminal
  - **Files:** (testing only)
  - **Rationale:** Verify bidirectional I/O: keystrokes reach tmux, output renders in browser
  - **Dependencies:** Task 3.7, Task 3.4

### Phase 4: Status Detection

- [ ] **Task 4.1**: Implement log file discovery with path escaping
  - **Files:** `src/server/logDiscovery.ts` (create)
  - **Rationale:** Convert project path to escaped directory name, find most recent JSONL
  - **Dependencies:** Phase 2

- [ ] **Task 4.2**: Create JSONL log parser
  - **Files:** `src/server/logParser.ts` (create)
  - **Rationale:** Parse log lines into typed events; handle malformed lines gracefully
  - **Dependencies:** Task 4.1

- [ ] **Task 4.3**: Implement simple status state machine
  - **Files:** `src/server/statusMachine.ts` (create)
  - **Rationale:** State machine with transitions per the diagram; simple switch-based implementation
  - **Dependencies:** Task 4.2

- [ ] **Task 4.4**: Set up chokidar file watching for log changes
  - **Files:** `src/server/StatusWatcher.ts` (create)
  - **Rationale:** Watch log files for appended lines
  - **Dependencies:** Task 4.3

- [ ] **Task 4.5**: Process log appends through state machine
  - **Files:** `src/server/StatusWatcher.ts` (modify)
  - **Rationale:** On file change, read only new lines, parse events, update state
  - **Dependencies:** Task 4.4

- [ ] **Task 4.6**: Connect StatusWatcher to Session Registry
  - **Files:** `src/server/StatusWatcher.ts` (modify), `src/server/SessionRegistry.ts` (modify)
  - **Rationale:** Update session.status when state changes; emit 'session-updated' event
  - **Dependencies:** Task 4.5

- [ ] **Task 4.7**: Broadcast status updates via WebSocket
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Listen to registry events; broadcast `session-update` to all clients
  - **Dependencies:** Task 4.6

### Phase 5: Kanban Dashboard UI

- [ ] **Task 5.1**: Create Zustand store for sessions
  - **Files:** `src/client/stores/sessionStore.ts` (create)
  - **Rationale:** Client-side state: sessions list, selected session ID, connection status
  - **Dependencies:** Phase 1

- [ ] **Task 5.2**: Create useWebSocket hook for session updates
  - **Files:** `src/client/hooks/useWebSocket.ts` (create)
  - **Rationale:** Connect to backend WebSocket; update Zustand store on messages
  - **Dependencies:** Task 5.1

- [ ] **Task 5.3**: Create SessionCard component
  - **Files:** `src/client/components/SessionCard.tsx` (create)
  - **Rationale:** Display session name, status badge, last activity, open button
  - **Dependencies:** Task 5.1

- [ ] **Task 5.4**: Create Dashboard component with 4 kanban columns
  - **Files:** `src/client/components/Dashboard.tsx` (create)
  - **Rationale:** Working | Needs Approval | Waiting | Idle columns
  - **Dependencies:** Task 5.3

- [ ] **Task 5.5**: Style kanban with Tailwind (desktop layout)
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/SessionCard.tsx` (modify)
  - **Rationale:** CSS Grid 4-column layout; status-based colors
  - **Dependencies:** Task 5.4

- [ ] **Task 5.6**: Integrate Terminal panel in App layout
  - **Files:** `src/client/App.tsx` (modify)
  - **Rationale:** Dashboard top, Terminal bottom (collapsible); click card opens terminal
  - **Dependencies:** Task 5.4, Task 3.7

- [ ] **Task 5.7**: Implement mobile responsive layout
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/App.tsx` (modify)
  - **Rationale:** Stack columns vertically on mobile; terminal as fullscreen overlay
  - **Dependencies:** Task 5.5, Task 5.6

### Phase 6: Session Creation UI

- [ ] **Task 6.1**: Create NewSessionModal component
  - **Files:** `src/client/components/NewSessionModal.tsx` (create)
  - **Rationale:** Modal with project path input, create/cancel buttons
  - **Dependencies:** Phase 5

- [ ] **Task 6.2**: Add Header component with "+ New Session" button
  - **Files:** `src/client/components/Header.tsx` (create), `src/client/App.tsx` (modify)
  - **Rationale:** Header with title and new session button
  - **Dependencies:** Task 6.1

- [ ] **Task 6.3**: Wire up session creation via WebSocket
  - **Files:** `src/client/components/NewSessionModal.tsx` (modify), `src/client/hooks/useWebSocket.ts` (modify)
  - **Rationale:** Send `session-create` message; handle success/error
  - **Dependencies:** Task 6.1, Task 2.6

- [ ] **Task 6.4**: Add session delete button on cards
  - **Files:** `src/client/components/SessionCard.tsx` (modify)
  - **Rationale:** Small delete button; confirm dialog before `session-kill`
  - **Dependencies:** Task 5.3, Task 2.6

### Phase 7: Notifications & Polish

- [ ] **Task 7.1**: Create useNotifications hook
  - **Files:** `src/client/hooks/useNotifications.ts` (create)
  - **Rationale:** Request notification permission; provide notify() function
  - **Dependencies:** Phase 5

- [ ] **Task 7.2**: Show browser notification when session needs approval
  - **Files:** `src/client/hooks/useNotifications.ts` (modify), `src/client/App.tsx` (modify)
  - **Rationale:** Watch for status changes to 'needs_approval'; show notification if tab hidden
  - **Dependencies:** Task 7.1

- [ ] **Task 7.3**: Add notification sound
  - **Files:** `public/notification.mp3` (create), `src/client/hooks/useNotifications.ts` (modify)
  - **Rationale:** Play audio when needs_approval triggered
  - **Dependencies:** Task 7.2

- [ ] **Task 7.4**: Implement favicon badge for attention state
  - **Files:** `src/client/hooks/useFaviconBadge.ts` (create), `public/favicon.svg` (create), `public/favicon-badge.svg` (create)
  - **Rationale:** Swap favicon when any session is needs_approval
  - **Dependencies:** Task 7.1

- [ ] **Task 7.5**: Add loading states and error handling
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** Show skeleton during load; error banner on disconnect
  - **Dependencies:** Phase 5, Phase 3

- [ ] **Task 7.6**: Handle terminal resize on window change
  - **Files:** `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** ResizeObserver on container; debounce and send resize message
  - **Dependencies:** Task 3.7

- [ ] **Task 7.7**: Add WebSocket reconnection with exponential backoff
  - **Files:** `src/client/hooks/useWebSocket.ts` (modify)
  - **Rationale:** On disconnect, retry with delays: 1s, 2s, 4s, 8s, max 30s
  - **Dependencies:** Task 5.2

- [ ] **Task 7.8**: Connection status indicator in header
  - **Files:** `src/client/components/Header.tsx` (modify)
  - **Rationale:** Small dot showing connection state (green/yellow/red)
  - **Dependencies:** Task 7.7, Task 6.2

---

## Risks

- **node-pty compilation issues** (severity: medium)
  - Requires native compilation; may fail without proper build tools
  - **Mitigation:** Document prerequisites (Xcode CLI tools on macOS). Add check in prerequisites.ts.

- **Claude Code JSONL format instability** (severity: medium)
  - Log format is not a public API; could change between versions
  - **Mitigation:** Isolate parsing in `logParser.ts`. Gracefully fall back to 'unknown' on parse errors.

- **tmux not installed** (severity: high)
  - Server will fail to start or produce confusing errors
  - **Mitigation:** `prerequisites.ts` checks for `tmux` binary on startup. Fail fast with clear error.

- **Large log files cause performance issues** (severity: medium)
  - JSONL logs can grow to many MB; parsing entire file is slow
  - **Mitigation:** Implement tail-reading: track file position, only read appended content.

- **WebSocket connection instability** (severity: medium)
  - Network interruptions disconnect dashboard
  - **Mitigation:** Exponential backoff reconnection. Show connection status clearly.

- **Project path escaping edge cases** (severity: low)
  - Paths with unusual characters might not escape correctly
  - **Mitigation:** Test with common path patterns. Fall back to 'unknown' status if log not found.

---

## Alternatives Considered

- **Separate frontend/backend npm packages**: Rejected - monorepo simpler; shared types in `src/shared/` eliminates type drift

- **Socket.io instead of ws**: Rejected - ws is lighter; we don't need Socket.io's room/namespace features

- **Redux instead of Zustand**: Rejected - Zustand has less boilerplate for small app

- **XState for status machine**: Deferred - simple switch statement is sufficient for 5 states; can upgrade if complexity grows

- **Using ttyd as subprocess**: Rejected - ttyd is binary, not library; would need one process per terminal

- **Polling instead of WebSocket**: Rejected - real-time updates essential for terminal I/O

- **Separate WebSocket for terminal vs status**: Rejected - single multiplexed connection simpler

---

## Testing Checklist

- [ ] Can discover existing `claude-*` tmux sessions
- [ ] Can create new session and see it appear
- [ ] Terminal shows real tmux output
- [ ] Keystrokes in browser reach tmux
- [ ] Status changes when Claude starts/stops working
- [ ] Notification fires when session needs approval
- [ ] Mobile layout works on narrow viewport
- [ ] Reconnects after simulated network drop
