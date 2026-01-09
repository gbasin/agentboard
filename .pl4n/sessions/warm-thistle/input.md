# Agentboard

A web dashboard for monitoring and interacting with Claude Code sessions running in tmux.

## Background & Motivation

### The Problem

When running multiple Claude Code sessions in parallel (across different projects or features), there's no good way to:

1. **See status at a glance** - Which sessions are working, waiting for approval, or idle?
2. **Get notified** - Know when a session needs your attention without watching terminals
3. **Access from anywhere** - Check on sessions from phone or another device
4. **Jump into the terminal** - Quickly interact when needed

### Existing Solutions & Why They Fall Short

| Tool | What it does | Limitation |
|------|--------------|------------|
| [claude-code-ui](https://github.com/KyleAMathews/claude-code-ui) | Kanban dashboard with status detection | No terminal view - monitoring only, can't interact |
| [webmux](https://github.com/nooesc/webmux) | Web-based tmux viewer with xterm.js | No status awareness - just raw terminal, no kanban |
| [Claude-Code-Board](https://github.com/cablate/Claude-Code-Board) | Kanban with multi-session | Spawns own processes - not tmux, no terminal embed |
| [ttyd](https://github.com/tsl0922/ttyd) | Share terminal over web | Single session, no dashboard, no status |

**The gap**: Nothing combines kanban status view + tmux terminal embedding + mobile-friendly UI.

### The Vision

A simple web UI that:
- Shows all your Claude Code tmux sessions organized by status (Working / Needs Approval / Waiting / Idle)
- Lets you click into any session to see and interact with the actual terminal
- Works on desktop and mobile (phone/tablet)
- Notifies you in-browser when sessions need attention
- Accessible remotely (via Tailscale, SSH tunnel, etc.)

---

## Requirements

### Must Have (MVP)

- [ ] **Kanban status view** - Sessions organized in columns by status
- [ ] **Terminal embed** - Click to open xterm.js view of actual tmux session
- [ ] **Session discovery** - Find existing tmux sessions running Claude Code
- [ ] **Session creation** - "New Session" button to spawn tmux + claude
- [ ] **Browser notifications** - Sound/visual alert when session needs approval
- [ ] **Responsive design** - Works well on desktop and mobile


### Non-Goals

- Not replacing Claude Code CLI itself
- Not a full tmux replacement (just viewer/interactor)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Browser (Desktop/Mobile)                     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Kanban Dashboard                         │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │ │
│  │  │ Working  │ │  Needs   │ │ Waiting  │ │   Idle   │       │ │
│  │  │          │ │ Approval │ │          │ │          │       │ │
│  │  │ [card]   │ │ [card]   │ │          │ │ [card]   │       │ │
│  │  │ [card]   │ │          │ │          │ │          │       │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Terminal Panel (xterm.js)                      │ │
│  │  Click any card to open terminal here                       │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ WebSocket (wss://)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Backend Server (Node.js)                    │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Status Watcher  │  │  Terminal Proxy  │  │ Session Mgmt  │  │
│  │                  │  │                  │  │               │  │
│  │ - Watch JSONL    │  │ - node-pty       │  │ - List tmux   │  │
│  │ - XState machine │  │ - Attach to tmux │  │ - Create new  │  │
│  │ - Emit updates   │  │ - Pipe I/O       │  │ - Kill        │  │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬───────┘  │
│           │                     │                     │          │
│           └─────────────────────┼─────────────────────┘          │
│                                 ▼                                │
│                    ┌─────────────────────┐                       │
│                    │   Session Registry  │                       │
│                    │   (in-memory Map)   │                       │
│                    └─────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
           │                                    │
           ▼                                    ▼
┌─────────────────────┐              ┌─────────────────────┐
│   ~/.claude/        │              │       tmux          │
│   projects/*/       │              │                     │
│   *.jsonl           │              │ claude-project-a    │
│                     │              │ claude-project-b    │
└─────────────────────┘              └─────────────────────┘
```

### Component Details

#### 1. Session Registry

Central data structure tracking all known sessions:

```typescript
interface Session {
  id: string                    // UUID
  name: string                  // Display name (project folder name)
  tmuxSession: string           // tmux session name, e.g., "claude-myproject"
  projectPath: string           // /Users/gary/code/myproject
  status: SessionStatus
  lastActivity: Date
  logFile?: string              // Path to JSONL log being watched
}

type SessionStatus =
  | 'working'         // Claude actively processing
  | 'needs_approval'  // Waiting for tool approval
  | 'waiting'         // Claude done, waiting for user input
  | 'idle'            // No activity for 5+ minutes
  | 'unknown'         // Can't determine (no log file found)
```

#### 2. Status Watcher

Monitors Claude Code's JSONL logs to determine session state:

```typescript
// Uses XState for state machine (same approach as claude-code-ui)
const statusMachine = createMachine({
  initial: 'unknown',
  states: {
    unknown: {
      on: { LOG_FOUND: 'idle', USER_PROMPT: 'working' }
    },
    idle: {
      on: { USER_PROMPT: 'working' }
    },
    working: {
      on: {
        ASSISTANT_TOOL_USE: 'needs_approval',
        TURN_END: 'waiting'
      }
    },
    needs_approval: {
      on: {
        TOOL_RESULT: 'working',
        // Fallback if we miss the approval
        after: { 5000: 'working' }
      }
    },
    waiting: {
      on: {
        USER_PROMPT: 'working',
        // Transition to idle after 5 min of no activity
        after: { 300000: 'idle' }
      }
    }
  }
})

// Log events detected by parsing JSONL:
// - USER_PROMPT: user sent a message
// - ASSISTANT_TOOL_USE: Claude wants to use a tool
// - TOOL_RESULT: tool was approved/executed
// - TURN_END: Claude finished responding
```

Log files are in `~/.claude/projects/{project-hash}/` as JSONL.

#### 3. Terminal Proxy

Bridges WebSocket connections to tmux sessions:

```typescript
import pty from 'node-pty'

class TerminalProxy {
  attach(tmuxSession: string, ws: WebSocket) {
    // Spawn PTY that attaches to existing tmux
    const ptyProcess = pty.spawn('tmux', ['attach', '-t', tmuxSession], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
    })

    // tmux → WebSocket → browser
    ptyProcess.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }))
      }
    })

    // browser → WebSocket → tmux
    ws.on('message', (msg) => {
      const { type, data } = JSON.parse(msg)
      if (type === 'input') {
        ptyProcess.write(data)
      } else if (type === 'resize') {
        ptyProcess.resize(data.cols, data.rows)
      }
    })

    ws.on('close', () => ptyProcess.kill())
  }
}
```

#### 4. Session Management

Discovers and creates tmux sessions:

```typescript
class SessionManager {
  // Find all tmux sessions that look like Claude Code
  async discover(): Promise<Session[]> {
    const { stdout } = await exec('tmux list-sessions -F "#{session_name}"')
    const sessions = stdout.trim().split('\n')

    // Filter to claude-* sessions (naming convention)
    return sessions
      .filter(name => name.startsWith('claude-'))
      .map(name => this.buildSession(name))
  }

  // Create new session
  async create(projectPath: string): Promise<Session> {
    const name = `claude-${path.basename(projectPath)}`

    // Create detached tmux session running claude in the project dir
    await exec(`tmux new-session -d -s "${name}" -c "${projectPath}" "claude"`)

    return this.buildSession(name)
  }

  // Kill session
  async kill(tmuxSession: string): Promise<void> {
    await exec(`tmux kill-session -t "${tmuxSession}"`)
  }
}
```

**tmux naming convention**: Sessions should be named `claude-{project-name}` so the dashboard can discover them. Users can start sessions manually with:

```bash
# In project directory:
tmux new-session -d -s "claude-$(basename $PWD)" "claude"
```

---

## UX Design

### Desktop Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agentboard                                    [+ New Session]      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Working (2)        Needs Approval (1)    Waiting       Idle (1)   │
│  ┌───────────┐      ┌───────────┐                      ┌─────────┐ │
│  │ myproject │      │ api-work  │                      │ old-fix │ │
│  │           │      │           │                      │         │ │
│  │ Refactor- │      │ Wants to  │                      │ Done 2h │ │
│  │ ing auth  │      │ edit db.ts│                      │ ago     │ │
│  │           │      │           │                      │         │ │
│  │   [Open]  │      │   [Open]  │                      │ [Open]  │ │
│  └───────────┘      └───────────┘                      └─────────┘ │
│  ┌───────────┐                                                      │
│  │ frontend  │                                                      │
│  │           │                                                      │
│  │ Building  │                                                      │
│  │ components│                                                      │
│  │   [Open]  │                                                      │
│  └───────────┘                                                      │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ Terminal: myproject                                          [×]    │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ $ claude                                                        │ │
│ │ ╭─────────────────────────────────────────────────────────────╮ │ │
│ │ │ I'll refactor the authentication module. Let me start by    │ │ │
│ │ │ reading the current implementation...                       │ │ │
│ │ ╰─────────────────────────────────────────────────────────────╯ │ │
│ │                                                                 │ │
│ │ Reading src/auth/index.ts...                                    │ │
│ │ █                                                               │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Mobile Layout

```
┌─────────────────────────┐
│ Agentboard        [+]   │
├─────────────────────────┤
│ ┌─ Working (2) ───────┐ │
│ │ ┌─────────────────┐ │ │
│ │ │ myproject       │ │ │
│ │ │ Refactoring... [→]│ │
│ │ └─────────────────┘ │ │
│ │ ┌─────────────────┐ │ │
│ │ │ frontend        │ │ │
│ │ │ Building...  [→]│ │ │
│ │ └─────────────────┘ │ │
│ └─────────────────────┘ │
│                         │
│ ┌─ Needs Approval (1) ─┐│
│ │ ┌─────────────────┐ │ │
│ │ │ api-work    ⚠️  │ │ │
│ │ │ Wants to... [→]│ │ │
│ │ └─────────────────┘ │ │
│ └─────────────────────┘ │
│                         │
│ ┌─ Idle (1) ──────────┐ │
│ │ ┌─────────────────┐ │ │
│ │ │ old-fix         │ │ │
│ │ │ Done 2h ago [→]│ │ │
│ │ └─────────────────┘ │ │
│ └─────────────────────┘ │
└─────────────────────────┘

  ↓ Tap a card to open terminal fullscreen ↓

┌─────────────────────────┐
│ ← myproject             │
├─────────────────────────┤
│                         │
│ $ claude                │
│ ╭─────────────────────╮ │
│ │ I'll refactor the   │ │
│ │ authentication...   │ │
│ ╰─────────────────────╯ │
│                         │
│ Reading src/auth/...    │
│ █                       │
│                         │
│                         │
├─────────────────────────┤
│ [Keyboard input area]   │
└─────────────────────────┘
```

### Interaction Flow

1. **View dashboard** → See all sessions by status
2. **Click/tap card** → Terminal panel opens (bottom on desktop, fullscreen on mobile)
3. **Interact** → Type in terminal, runs in actual tmux
4. **Close terminal** → Back to dashboard view
5. **Notification** → Browser sound/badge when "Needs Approval" column gets a card

### Browser Notifications

```typescript
// Request permission on first visit
if (Notification.permission === 'default') {
  Notification.requestPermission()
}

// When session moves to needs_approval
function notifyApprovalNeeded(session: Session) {
  // Play sound
  new Audio('/notification.mp3').play()

  // Browser notification (if permitted and tab not focused)
  if (document.hidden && Notification.permission === 'granted') {
    new Notification(`${session.name} needs approval`, {
      body: 'Claude is waiting for tool permission',
      icon: '/icon.png',
      tag: session.id, // Prevents duplicate notifications
    })
  }

  // Update favicon with badge
  updateFavicon({ badge: true })
}
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|------------|-----|
| **Frontend** | React + Vite | Fast, modern, good ecosystem |
| **Styling** | Tailwind CSS | Responsive, utility-first |
| **Terminal** | xterm.js + fit addon | Standard web terminal, auto-resize |
| **State** | Zustand | Simple, no boilerplate |
| **Backend** | Node.js + Express | Simple, good WebSocket support |
| **WebSocket** | ws | Standard Node WebSocket library |
| **PTY** | node-pty | Spawn pseudo-terminals |
| **File watching** | chokidar | Watch JSONL log files |
| **State machine** | XState | Status detection logic |

### Directory Structure

```
agentboard/
├── SPEC.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
│
├── src/
│   ├── client/                 # Frontend
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Dashboard.tsx   # Kanban board
│   │   │   ├── SessionCard.tsx # Individual session card
│   │   │   ├── Terminal.tsx    # xterm.js wrapper
│   │   │   └── NewSessionModal.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   └── useSessions.ts
│   │   ├── stores/
│   │   │   └── sessionStore.ts # Zustand store
│   │   └── styles/
│   │       └── index.css
│   │
│   └── server/                 # Backend
│       ├── index.ts            # Entry point
│       ├── SessionManager.ts   # tmux discovery/creation
│       ├── StatusWatcher.ts    # JSONL log parsing
│       ├── TerminalProxy.ts    # WebSocket ↔ PTY bridge
│       └── statusMachine.ts    # XState definition
│
├── public/
│   ├── index.html
│   ├── icon.png
│   └── notification.mp3
│
└── scripts/
    └── claude-session.sh       # Helper to start named tmux sessions
```

---

## Implementation Plan

### Phase 1: Skeleton (Day 1 morning)

- [ ] Initialize repo with Vite + React + Tailwind
- [ ] Set up Express server with WebSocket
- [ ] Basic "Hello World" frontend ↔ backend communication
- [ ] Deploy/run locally, verify hot reload works

### Phase 2: Session Discovery (Day 1 afternoon)

- [ ] Implement `SessionManager.discover()` - list tmux sessions
- [ ] Display sessions in simple list (not kanban yet)
- [ ] Add "New Session" that creates tmux session
- [ ] Test creating/discovering sessions

### Phase 3: Terminal Embed (Day 2 morning)

- [ ] Add xterm.js to frontend
- [ ] Implement `TerminalProxy` with node-pty
- [ ] Wire up WebSocket: click session → open terminal
- [ ] Test typing in browser → appears in tmux

### Phase 4: Status Detection (Day 2 afternoon)

- [ ] Implement log file discovery (match tmux session → project → JSONL)
- [ ] Set up chokidar to watch log files
- [ ] Implement XState status machine
- [ ] Emit status changes over WebSocket

### Phase 5: Kanban UI (Day 3 morning)

- [ ] Refactor list into kanban columns
- [ ] Sessions move between columns based on status
- [ ] Style cards with status indicators
- [ ] Add session count badges to column headers

### Phase 6: Polish (Day 3 afternoon)

- [ ] Browser notifications (sound + Notification API)
- [ ] Mobile responsive layout
- [ ] Terminal resize handling
- [ ] Error states and loading indicators
- [ ] Favicon badge for attention needed

### Phase 7: Remote Access (Post-MVP)

- [ ] HTTPS support (self-signed cert generation)
- [ ] Optional authentication (simple password)
- [ ] Document Tailscale/SSH tunnel setup

---

## Open Questions

1. **Log file matching**: How to reliably match a tmux session to its Claude Code log file? Current plan: parse project path from tmux session's CWD, hash it to find log folder.

2. **Multiple Claude instances per project**: What if someone runs multiple Claude sessions in the same project? Probably edge case, ignore for MVP.

3. **Session naming conflicts**: What if `claude-myproject` already exists? Add suffix like `claude-myproject-2`.

---

## References

- [claude-code-ui](https://github.com/KyleAMathews/claude-code-ui) - Status detection approach
- [webmux](https://github.com/nooesc/webmux) - Terminal proxy architecture
- [ttyd](https://github.com/tsl0922/ttyd) - PTY ↔ WebSocket reference
- [xterm.js](https://xtermjs.org/) - Terminal emulator docs
- [node-pty](https://github.com/microsoft/node-pty) - PTY library