# Agentboard Implementation Plan (Unified Synthesis)

## Background and Context

### Project State

This is a **greenfield project** with only `SPEC.md` containing the complete specification. No code, configs, or tooling exists yet.

### What We're Building

A web dashboard that combines:

- **Kanban board** - Sessions grouped by status (Working, Needs Approval, Waiting, Idle)
- **Terminal embed** - Interactive xterm.js connected to actual tmux windows via WebSocket
- **Status detection** - Real-time parsing of Claude Code JSONL logs
- **Notifications** - Browser alerts when sessions need approval
- **Mobile-friendly** - Responsive design that works on phone/tablet

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
                              │ WebSocket (ws://)
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        Bun + Hono Backend                              │
│                                                                        │
│  SessionManager         StatusWatcher           TerminalProxy          │
│  - tmux list-windows    - Bun file watch       - Bun.spawn({ pty })    │
│  - tmux new-window      - JSONL parsing        - attach to window      │
│  - tmux kill-window     - State machine        - bidirectional I/O     │
│                                                                        │
│                    Session Registry (in-memory Map)                    │
└───────────────────────────────────────────────────────────────────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐      ┌─────────────────────┐
│  tmux session:  │      │  ~/.claude/projects │
│  agentboard     │      │  {escaped-path}/*.jsonl │
│  └─ windows     │      └─────────────────────┘
└─────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Bun (fast, built-in PTY, TypeScript native) |
| **Frontend** | React 18 + Vite + TypeScript |
| **Styling** | Tailwind CSS |
| **Terminal** | xterm.js + xterm-addon-fit + xterm-addon-webgl |
| **Client state** | Zustand |
| **Backend** | Bun + Hono |
| **WebSocket** | Bun native WebSocket |
| **PTY** | Bun native `Bun.spawn({ pty: true })` |
| **File watching** | Bun native or chokidar |
| **State machine** | Simple switch-based |
| **Linting** | oxlint (fast Rust-based) |
| **Testing** | Bun test (built-in) |

### Key Data Structures

```typescript
// src/shared/types.ts - Shared between client and server

export interface Session {
  id: string              // UUID
  name: string            // Display name (folder basename)
  tmuxWindow: string      // e.g., "agentboard:myproject"
  projectPath: string     // /Users/gary/code/myproject
  status: SessionStatus
  lastActivity: Date
  logFile?: string        // Path to JSONL being watched
  source: 'managed' | 'external'  // Whether created by agentboard or discovered
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

### Claude Code JSONL Log Format

**Critical finding:** Project directories use **path escaping** (not SHA256 hashing):

- `/Users/gary/code/project` → `~/.claude/projects/-Users-gary-code-project/`

Log entries are JSON objects with key fields:

```typescript
interface LogEntry {
  type: 'user' | 'assistant' | 'system'
  message?: {
    role: 'user' | 'assistant'
    content: string | ContentBlock[]
  }
  // For assistant messages:
  // - stop_reason: "tool_use" means waiting for approval
  // - stop_reason: "end_turn" means turn complete
}
```

Status detection from log events:

- `type: "user"` with regular content → USER_PROMPT → working
- `type: "assistant"` with `stop_reason: "tool_use"` → ASSISTANT_TOOL_USE → needs_approval
- `type: "user"` with `tool_result` in content → TOOL_RESULT → working
- `type: "assistant"` with `stop_reason: "end_turn"` → TURN_END → waiting

---

## Summary

Build a full-stack TypeScript application using **Bun** runtime with **Vite+React** frontend and **Hono** backend. Agentboard uses a **single parent tmux session** (`agentboard`) with **windows for each project**, supporting multiple windows per project. Key tooling: **Bun** (runtime + PTY + tests), **oxlint** (fast linting), **Tailwind**. Terminal UX includes scroll (mouse wheel, touch drag) and copy-paste support. The implementation follows **runnable milestones**: (1) project scaffolding, (2) window discovery, (3) terminal proxy with scroll/copy-paste, (4) status detection, (5) kanban UI, (6) session management UI, (7) notifications + polish, and (8) documentation.

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

### tmux Window Organization

```
tmux session: agentboard
├── window 0: myproject      (agentboard:myproject)
├── window 1: api-work       (agentboard:api-work)
├── window 2: myproject-2    (agentboard:myproject-2)  ← multiple windows per project OK
└── window 3: frontend       (agentboard:frontend)
```

### Directory Structure

```
agentboard/
├── SPEC.md
├── README.md
├── package.json
├── bunfig.toml             # Bun configuration
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── oxlint.json             # oxlint configuration
├── index.html
├── .gitignore
│
├── src/
│   ├── shared/
│   │   └── types.ts
│   │
│   ├── client/
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
│   └── server/
│       ├── index.ts
│       ├── config.ts
│       ├── prerequisites.ts
│       ├── SessionManager.ts
│       ├── SessionRegistry.ts
│       ├── StatusWatcher.ts
│       ├── logDiscovery.ts
│       ├── logParser.ts
│       ├── statusMachine.ts
│       └── TerminalProxy.ts
│
├── public/
│   ├── favicon.svg
│   ├── favicon-badge.svg
│   └── notification.mp3
│
└── scripts/
    └── agentboard-window.sh
```

---

## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | Monorepo structure with `src/client`, `src/server`, and `src/shared` | Shared types between client/server eliminates drift |
| A2 | Vite dev proxy forwards API/WebSocket to Bun server on port 4040 | Standard pattern; avoids CORS during development |
| A3 | Production bundles frontend into `dist/client/`, served by Bun | Single-process deployment |
| A4 | Single `agentboard` tmux session with windows per project | Supports multiple windows per project; cleaner organization |
| A5 | tmux CWD obtainable via `tmux display-message -p -t agentboard:{window} '#{pane_current_path}'` | Standard tmux command |
| A6 | Claude Code log directories use path escaping: `/a/b/c` → `-a-b-c` | Standard format per SPEC |
| A7 | Single WebSocket connection per client, multiplexed by message type | Cleaner than multiple connections |
| A8 | Use ESM (`"type": "module"`) for both client and server | Modern standard; Vite requires ESM |
| A9 | Large log files handled by reading only recent lines (tail-like behavior) | JSONL logs can grow large |
| A10 | Target environment is macOS with tmux + Claude Code CLI installed | Spec uses macOS paths |
| A11 | Browser access within LAN/VPN; authentication deferred to post-MVP | Spec lists auth/HTTPS as post-MVP |

### Questions

**Q1: Default port number?**

- Context: Need a port for the web server
- Agent recommends: Port 4040 (avoids common dev ports). Configurable via `PORT` env var.
- **Answer:** Approved.

**Q2: Session creation UI - directory picker approach?**

- Context: Web browsers can't do native directory pickers easily
- Agent recommends: Text input for absolute path.
- **Answer:** Approved.

**Q3: Should session discovery use `agentboard` prefix?**

- Context: Need to identify managed windows
- Agent recommends: Windows in the `agentboard` tmux session are managed.
- **Answer:** Approved.

**Q4: Should the MVP expose a "Kill session" action in the UI?**

- Context: Kill is useful but risky without authentication.
- Agent recommends: ~~Omit kill button~~ → Include kill functionality with confirmation dialog.
- **Answer:** Approved.

**Q5: Notification behavior when dashboard tab is focused?**

- Context: Avoid noisy alerts during active use
- Agent recommends: Sound + favicon badge always; browser Notification only when tab is hidden.
- **Answer:** Approved.

**Q6: Should Agentboard use separate tmux sessions or a parent session with windows?**

- Context: User asked "why bother with separate sessions, does that buy us anything? note we may want multiple active windows per project anyway"
- Options:
  - **A) Separate sessions**: Each project gets its own tmux session.
  - **B) Parent session with windows**: One `agentboard` tmux session with windows for each project.
- Agent recommends: **Option B (parent session with windows)**. Benefits:
  - Supports multiple windows per project (myproject, myproject-2, etc.)
  - Cleaner organization: `tmux attach -t agentboard` shows all windows
  - Easy to add windows for same project
- **Answer:** Use Option B. Single `agentboard` session with windows.

**Q7: PTY library choice - node-pty vs alternatives?**

- Context: User asked "do we want to be using node-pty? what are the alts"
- Options evaluated:
  - **node-pty**: Most mature, Microsoft-maintained - but requires native compilation (Xcode CLI tools)
  - **Bun native PTY**: Built-in `Bun.spawn({ pty: true })` - no native compilation needed
  - **xterm-pty**: WASM-based, no native modules - but limited platform support
  - **tmux capture-pane**: No PTY needed, poll output - simpler but less responsive
- Agent recommends: **Bun's native PTY** (`Bun.spawn({ pty: true })`). No native compilation needed, simplifies setup significantly.
- **Answer:** Use Bun native PTY. Eliminates node-pty compilation issues.

**Q8: Should tmux be auto-installed during setup?**

- Context: User asked "should install as part of the setup or something"
- Agent recommends: Provide clear install instructions in README. `prerequisites.ts` checks for tmux and shows install command (`brew install tmux` on macOS). Don't auto-install without user consent.
- **Answer:** Document installation steps; preflight checks with helpful error messages.

---

## Notes for Agents

### Window Architecture

Agentboard uses a **single parent tmux session** named `agentboard` with **windows for each project**:

**Attach to full session:** `tmux attach -t agentboard`
**Attach to specific window:** `tmux attach -t agentboard:myproject`

### Window Discovery Rules

| Window Type | Location | Source | Kill Allowed | Created By |
|-------------|----------|--------|--------------|------------|
| Managed | `agentboard:{window}` | `'managed'` | Yes | Dashboard |
| External | Other tmux sessions | `'external'` | No | User/CLI |

**Discovery logic:**

1. Check if `agentboard` tmux session exists; create if needed
2. List all windows in `agentboard` session via `tmux list-windows -t agentboard`
3. If `DISCOVER_PREFIXES` env var is set, also discover windows from other sessions as external
4. Mark discovered windows appropriately: managed windows show kill button, external show "View only"

### Environment Variables (config.ts)

```typescript
export const config = {
  port: Number(process.env.PORT) || 4040,
  discoverPrefixes: (process.env.DISCOVER_PREFIXES || '').split(',').filter(Boolean),
  claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ||
    path.join(process.env.HOME || '', '.claude', 'projects'),
}
```

### Key Implementation Details

1. **Log directory discovery**: Convert project path to escaped format by replacing `/` with `-`
2. **Log file selection**: Use most recently modified `.jsonl` file (exclude `agent-*.jsonl`)
3. **Log tail reading**: Track file size, on 'change' event read only bytes after previous position
4. **Resize debouncing**: 100ms debounce prevents PTY thrashing
5. **Window refresh interval**: 5000ms poll catches external changes
6. **State machine timeouts**: 5min idle transition (300000ms)
7. **WebSocket reconnect backoff**: 1s, 2s, 4s, 8s... max 30s
8. **Window naming conflicts**: If `myproject` exists, create `myproject-2`, etc.
9. **Terminal scroll**: Enable tmux scrollback buffer access via mouse wheel + touch drag
10. **Clipboard integration**: Use xterm.js clipboard addon for copy/paste support

### Mobile Layout Guidance

- Use Tailwind responsive classes (`md:grid-cols-4`, below that stack vertically)
- "Needs Approval" column: Use amber background (`bg-amber-50 border-amber-200`)
- Terminal sizing: CSS `height: 300px` on desktop, `100vh` minus header on mobile
- Terminal view is fullscreen overlay on mobile with back button

---

## Projects to Borrow From

### Terminal Proxy / PTY

| Project | What to borrow | Notes |
|---------|----------------|-------|
| [wetty](https://github.com/butlerx/wetty) | PTY ↔ WebSocket patterns | TypeScript, mature, MIT license |
| [webmux](https://github.com/nooesc/webmux) | tmux attachment patterns | Good architecture reference |
| [ttyd](https://github.com/tsl0922/ttyd) | C implementation reference | Shows PTY edge cases |
| [node-pty](https://github.com/microsoft/node-pty) | Fallback PTY library | If Bun PTY has issues |

### React xterm.js Integration

| Project | What to borrow | Notes |
|---------|----------------|-------|
| [react-xtermjs](https://github.com/Qovery/react-xtermjs) | Hook-based xterm wrapper | Actively maintained, clean API |

### Kanban UI

| Project | What to borrow | Notes |
|---------|----------------|-------|
| [react-dnd-kit-tailwind-shadcn-ui](https://github.com/Georgegriff/react-dnd-kit-tailwind-shadcn-ui) | Kanban with drag-drop | TypeScript, Tailwind, @dnd-kit |

### Status Detection

| Project | What to borrow | Notes |
|---------|----------------|-------|
| [claude-code-ui](https://github.com/KyleAMathews/claude-code-ui) | JSONL parsing patterns | Look at daemon code for log watching |

### Notification Sounds

Free notification sounds: [freesound.org](https://freesound.org/) (CC0 licensed)

---

## References

- [Bun docs](https://bun.sh/docs) - Runtime, PTY, testing
- [Hono docs](https://hono.dev/) - Web framework for Bun
- [xterm.js docs](https://xtermjs.org/) - Terminal emulator API
- [oxlint docs](https://oxc.rs/docs/guide/usage/linter.html) - Fast Rust-based linter
- [@dnd-kit docs](https://docs.dndkit.com/) - Drag and drop
- [Tailwind docs](https://tailwindcss.com/docs) - CSS framework
- [shadcn/ui](https://ui.shadcn.com/) - Component library

---

## Tasks

Tasks are organized into **milestones** - each milestone produces a runnable, testable slice.

### Tooling Philosophy

Use the fastest, best-in-class tools for TypeScript development:
- **Bun** for runtime, package management, and testing
- **oxlint** for linting (100x faster than ESLint)
- **Vite** for frontend builds (fastest HMR)
- **TypeScript** with strict mode

### Milestone 1: Project Skeleton (Runnable: "Hello World" full-stack)

- [ ] **Task 1.1**: Initialize Bun project with TypeScript
  - **Files:** `package.json` (create), `tsconfig.json` (create), `bunfig.toml` (create), `.gitignore` (create), `oxlint.json` (create)
  - **Rationale:** Bun for fast runtime + built-in PTY + native TypeScript; oxlint for fast linting
  - **Dependencies:** none

- [ ] **Task 1.2**: Create shared types module
  - **Files:** `src/shared/types.ts` (create)
  - **Rationale:** Single source of truth for Session, SessionStatus, and WebSocket message types
  - **Dependencies:** Task 1.1

- [ ] **Task 1.3**: Set up Vite with React and Tailwind CSS
  - **Files:** `vite.config.ts` (create), `tailwind.config.js` (create), `postcss.config.js` (create), `index.html` (create), `src/client/main.tsx` (create), `src/client/App.tsx` (create), `src/client/styles/index.css` (create)
  - **Rationale:** Frontend tooling with hot reload; Tailwind for responsive styling
  - **Dependencies:** Task 1.1, Task 1.2

- [ ] **Task 1.4**: Create Bun server with Hono and native WebSocket
  - **Files:** `src/server/index.ts` (create), `src/server/config.ts` (create)
  - **Rationale:** Bun native server + Hono for routing; built-in WebSocket support
  - **Dependencies:** Task 1.1, Task 1.2

- [ ] **Task 1.5**: Configure Vite proxy and dev scripts
  - **Files:** `vite.config.ts` (modify), `package.json` (modify)
  - **Rationale:** WebSocket proxy enables frontend-backend communication during development
  - **Dependencies:** Task 1.3, Task 1.4

- [ ] **Task 1.6**: Verify hello-world WebSocket communication
  - **Files:** (testing only)
  - **Rationale:** Confirm full-stack setup works before building features
  - **Dependencies:** Task 1.5
  - **Milestone check:** Browser shows "Connected" message from server

### Milestone 2: Window Discovery (Runnable: List tmux windows in browser)

- [ ] **Task 2.1**: Add prerequisite check utility
  - **Files:** `src/server/prerequisites.ts` (create)
  - **Rationale:** Check that tmux is installed; show install guidance if missing
  - **Dependencies:** Milestone 1

- [ ] **Task 2.2**: Create SessionManager with tmux window discovery
  - **Files:** `src/server/SessionManager.ts` (create)
  - **Rationale:** Ensure `agentboard` session exists; list windows via `tmux list-windows -t agentboard`
  - **Dependencies:** Task 2.1

- [ ] **Task 2.3**: Implement window creation with name conflict handling
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** Create new window via `tmux new-window -t agentboard -n {name} -c {path} claude`; suffix on conflicts
  - **Dependencies:** Task 2.2

- [ ] **Task 2.4**: Implement window termination
  - **Files:** `src/server/SessionManager.ts` (modify)
  - **Rationale:** Allow dashboard to terminate managed windows only via `tmux kill-window`
  - **Dependencies:** Task 2.2

- [ ] **Task 2.5**: Create Session Registry with EventEmitter
  - **Files:** `src/server/SessionRegistry.ts` (create)
  - **Rationale:** In-memory Map of sessions; emits events on changes
  - **Dependencies:** Task 2.2

- [ ] **Task 2.6**: Add WebSocket message handlers for session operations
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Handle `session-create`, `session-kill` messages; broadcast session list on connect
  - **Dependencies:** Task 2.5

- [ ] **Task 2.7**: Periodic window refresh (poll tmux every 5s)
  - **Files:** `src/server/SessionManager.ts` (modify), `src/server/index.ts` (modify)
  - **Rationale:** Detect windows created/killed outside dashboard
  - **Dependencies:** Task 2.5

- [ ] **Task 2.8**: Create basic window list UI
  - **Files:** `src/client/stores/sessionStore.ts` (create), `src/client/hooks/useWebSocket.ts` (create), `src/client/components/SessionCard.tsx` (create), `src/client/App.tsx` (modify)
  - **Rationale:** Display discovered windows as simple list; foundation for kanban
  - **Dependencies:** Task 2.6
  - **Milestone check:** Browser shows list of windows from `agentboard` tmux session

### Milestone 3: Terminal Embed (Runnable: Interactive terminal in browser)

- [ ] **Task 3.1**: Create TerminalProxy class with Bun native PTY
  - **Files:** `src/server/TerminalProxy.ts` (create)
  - **Rationale:** Use `Bun.spawn({ pty: true })` to attach to tmux windows - no native compilation needed
  - **Dependencies:** Milestone 2

- [ ] **Task 3.2**: Implement resize handler with debouncing
  - **Files:** `src/server/TerminalProxy.ts` (modify)
  - **Rationale:** Debounce resize events (100ms) to avoid PTY thrashing
  - **Dependencies:** Task 3.1

- [ ] **Task 3.3**: Wire PTY I/O to WebSocket messages
  - **Files:** `src/server/TerminalProxy.ts` (modify), `src/server/index.ts` (modify)
  - **Rationale:** Forward PTY output to client, client input to PTY
  - **Dependencies:** Task 3.2

- [ ] **Task 3.4**: Add xterm.js with addons to frontend
  - **Files:** `src/client/components/Terminal.tsx` (create), `src/client/hooks/useTerminal.ts` (create), `package.json` (modify)
  - **Rationale:** Web terminal emulator; fit addon for auto-resize
  - **Dependencies:** Milestone 1

- [ ] **Task 3.5**: Integrate Terminal component in App
  - **Files:** `src/client/App.tsx` (modify), `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** Click session card to open terminal panel
  - **Dependencies:** Task 3.3, Task 3.4

- [ ] **Task 3.6**: Terminal scroll and copy-paste support
  - **Files:** `src/client/components/Terminal.tsx` (modify), `src/client/hooks/useTerminal.ts` (modify)
  - **Rationale:** Enable mouse wheel scrolling through tmux scrollback; touch drag scroll on mobile; clipboard copy/paste via xterm.js clipboard addon
  - **Dependencies:** Task 3.4
  - **Milestone check:** Can type in browser, keystrokes appear in tmux; scroll + copy-paste works

### Milestone 4: Status Detection (Runnable: Sessions show real-time status)

- [ ] **Task 4.1**: Implement log file discovery with path escaping
  - **Files:** `src/server/logDiscovery.ts` (create)
  - **Rationale:** Convert project path to escaped directory name, find most recent JSONL
  - **Dependencies:** Milestone 2

- [ ] **Task 4.2**: Create JSONL log parser
  - **Files:** `src/server/logParser.ts` (create)
  - **Rationale:** Parse log lines into typed events; handle malformed lines gracefully
  - **Dependencies:** Task 4.1

- [ ] **Task 4.3**: Implement simple status state machine
  - **Files:** `src/server/statusMachine.ts` (create)
  - **Rationale:** State machine with transitions per the diagram; simple switch-based
  - **Dependencies:** Task 4.2

- [ ] **Task 4.4**: Set up file watching
  - **Files:** `src/server/StatusWatcher.ts` (create)
  - **Rationale:** Watch log files for appended lines; read only new content
  - **Dependencies:** Task 4.3

- [ ] **Task 4.5**: Connect StatusWatcher to Session Registry
  - **Files:** `src/server/StatusWatcher.ts` (modify), `src/server/SessionRegistry.ts` (modify)
  - **Rationale:** Update session.status when state changes; emit events
  - **Dependencies:** Task 4.4

- [ ] **Task 4.6**: Broadcast status updates via WebSocket
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Listen to registry events; broadcast `session-update` to all clients
  - **Dependencies:** Task 4.5
  - **Milestone check:** Session card updates when Claude starts/stops working

### Milestone 5: Kanban UI (Runnable: Full kanban dashboard)

- [ ] **Task 5.1**: Create Dashboard with 4 kanban columns
  - **Files:** `src/client/components/Dashboard.tsx` (create)
  - **Rationale:** Working | Needs Approval | Waiting | Idle columns
  - **Dependencies:** Milestone 4

- [ ] **Task 5.2**: Style kanban with Tailwind (desktop)
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/SessionCard.tsx` (modify)
  - **Rationale:** CSS Grid 4-column layout; status-based colors
  - **Dependencies:** Task 5.1

- [ ] **Task 5.3**: Integrate Terminal panel in layout
  - **Files:** `src/client/App.tsx` (modify)
  - **Rationale:** Dashboard top, Terminal bottom (collapsible); click card opens terminal
  - **Dependencies:** Task 5.1, Milestone 3

- [ ] **Task 5.4**: Implement mobile responsive layout
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/App.tsx` (modify)
  - **Rationale:** Stack columns vertically on mobile; terminal as fullscreen overlay
  - **Dependencies:** Task 5.2, Task 5.3
  - **Milestone check:** Kanban works on desktop and mobile viewports

### Milestone 6: Session Management UI (Runnable: Create/kill sessions from browser)

- [ ] **Task 6.1**: Create NewSessionModal component
  - **Files:** `src/client/components/NewSessionModal.tsx` (create)
  - **Rationale:** Modal with project path input, create/cancel buttons
  - **Dependencies:** Milestone 5

- [ ] **Task 6.2**: Add Header component with "+ New Session" button
  - **Files:** `src/client/components/Header.tsx` (create), `src/client/App.tsx` (modify)
  - **Rationale:** Header with title, new session button, refresh button
  - **Dependencies:** Task 6.1

- [ ] **Task 6.3**: Wire up session creation via WebSocket
  - **Files:** `src/client/components/NewSessionModal.tsx` (modify), `src/client/hooks/useWebSocket.ts` (modify)
  - **Rationale:** Send `session-create` message; handle success/error
  - **Dependencies:** Task 6.1, Task 2.6

- [ ] **Task 6.4**: Add session kill button with confirmation dialog
  - **Files:** `src/client/components/SessionCard.tsx` (modify)
  - **Rationale:** Kill button for managed sessions only; confirmation dialog; external sessions show "View only"
  - **Dependencies:** Task 2.4, Task 2.6
  - **Milestone check:** Can create and kill managed sessions from browser

### Milestone 7: Notifications & Polish (Runnable: Production-ready MVP)

- [ ] **Task 7.1**: Create useNotifications hook
  - **Files:** `src/client/hooks/useNotifications.ts` (create)
  - **Rationale:** Request notification permission; provide notify() function
  - **Dependencies:** Milestone 5

- [ ] **Task 7.2**: Show notifications when session needs approval
  - **Files:** `src/client/hooks/useNotifications.ts` (modify), `src/client/App.tsx` (modify)
  - **Rationale:** Sound + favicon badge always; browser Notification only when tab hidden
  - **Dependencies:** Task 7.1

- [ ] **Task 7.3**: Add notification sound and favicon badge
  - **Files:** `public/notification.mp3` (create), `public/favicon.svg` (create), `public/favicon-badge.svg` (create), `src/client/hooks/useFaviconBadge.ts` (create)
  - **Rationale:** Audio alert + visual indicator. Source from freesound.org (CC0).
  - **Dependencies:** Task 7.2

- [ ] **Task 7.4**: Add loading states and error handling
  - **Files:** `src/client/components/Dashboard.tsx` (modify), `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** Show skeleton during load; error banner on disconnect
  - **Dependencies:** Milestone 5, Milestone 3

- [ ] **Task 7.5**: Add WebSocket reconnection with exponential backoff
  - **Files:** `src/client/hooks/useWebSocket.ts` (modify)
  - **Rationale:** On disconnect, retry with delays: 1s, 2s, 4s, 8s, max 30s
  - **Dependencies:** Task 2.8

- [ ] **Task 7.6**: Connection status indicator in header
  - **Files:** `src/client/components/Header.tsx` (modify)
  - **Rationale:** Small dot showing connection state (green/yellow/red)
  - **Dependencies:** Task 7.5, Task 6.2

- [ ] **Task 7.7**: Terminal resize handling
  - **Files:** `src/client/components/Terminal.tsx` (modify)
  - **Rationale:** ResizeObserver on container; debounce and send resize message
  - **Dependencies:** Milestone 3
  - **Milestone check:** Notifications fire; reconnects work; responsive terminal

### Milestone 8: Documentation

- [ ] **Task 8.1**: Create README with setup instructions
  - **Files:** `README.md` (create)
  - **Rationale:** Document prerequisites (Bun, tmux with install steps), setup, usage
  - **Dependencies:** All previous milestones

- [ ] **Task 8.2**: Create helper script for launching windows
  - **Files:** `scripts/agentboard-window.sh` (create)
  - **Rationale:** Convenience script for `tmux new-window -t agentboard -n "$(basename $PWD)" -c "$PWD" "claude"`
  - **Dependencies:** none
  - **Milestone check:** New user can set up and run from README

---

## Risks

- **Log mapping mismatch** (severity: **high**)
  - If our path escaping doesn't match Claude Code's, we can't find log files
  - **Mitigation:** Verify escaping format by examining `~/.claude/projects/`. Fall back to 'unknown' status gracefully.

- **Bun PTY limitations** (severity: medium)
  - Bun's PTY support may have edge cases not covered
  - **Mitigation:** Fallback options if needed:
    - node-pty (requires Xcode CLI tools)
    - `tmux capture-pane` polling (simpler but less responsive)

- **tmux not installed** (severity: high → **medium with guidance**)
  - Server will fail without tmux
  - **Mitigation:**
    1. `prerequisites.ts` checks for `tmux` on startup
    2. Show install command: `brew install tmux` on macOS
    3. README includes installation instructions
    4. Fail fast with clear error message

- **Large log files** (severity: medium)
  - JSONL logs can grow to many MB
  - **Mitigation:** Tail-reading: track file position, only read appended content.

- **WebSocket instability** (severity: medium)
  - Network interruptions disconnect dashboard
  - **Mitigation:** Exponential backoff reconnection. Show connection status clearly.

- **Security without authentication** (severity: medium)
  - Anyone on network can view/create/kill sessions
  - **Mitigation:** Document LAN-only usage. Add confirmation dialog for kill. Auth planned for post-MVP.

- **Claude Code JSONL format instability** (severity: medium)
  - Log format could change between versions
  - **Mitigation:** Isolate parsing in `logParser.ts`. Fall back to 'unknown' on parse errors.

---

## Alternatives Considered

- **node-pty for PTY**: Rejected in favor of Bun native PTY - no compilation needed
- **Node.js + npm**: Rejected in favor of Bun - faster runtime, built-in PTY, native TypeScript
- **ESLint for linting**: Rejected in favor of oxlint - 100x faster
- **Separate tmux sessions per project**: Rejected - parent session with windows better supports multiple windows per project
- **XState instead of simple state machine**: Deferred - simple switch sufficient for 5 states
- **Socket.io instead of ws**: Rejected - ws is lighter
- **Redux instead of Zustand**: Rejected - Zustand has less boilerplate
- **react-beautiful-dnd for kanban**: Rejected - deprecated. Use @dnd-kit instead.

---

## Testing Checklist

- [ ] Can discover windows in `agentboard` tmux session (marked as managed)
- [ ] Can create new window and see it appear (marked as managed)
- [ ] Can create multiple windows for same project (myproject, myproject-2)
- [ ] Can kill managed window with confirmation dialog
- [ ] External sessions show "View only" badge, no kill button
- [ ] Terminal shows real tmux output
- [ ] Keystrokes in browser reach tmux
- [ ] Mouse wheel scrolls through tmux scrollback buffer
- [ ] Touch drag scrolls on mobile
- [ ] Copy selection works (Ctrl/Cmd+C or right-click)
- [ ] Paste works (Ctrl/Cmd+V or right-click)
- [ ] Status changes when Claude starts/stops working
- [ ] Status shows "needs_approval" when Claude wants to use a tool
- [ ] Notification fires when session needs approval (tab hidden)
- [ ] Sound plays when session needs approval
- [ ] Favicon shows badge when session needs approval
- [ ] Mobile layout works on narrow viewport
- [ ] Terminal goes fullscreen on mobile
- [ ] Reconnects automatically after network drop
- [ ] Connection indicator shows correct state
- [ ] Error shown gracefully when tmux window disappears
