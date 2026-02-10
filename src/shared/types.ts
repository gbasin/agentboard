// Inactive sessions lookback limits (in hours)
export const INACTIVE_MAX_AGE_MIN_HOURS = 1
export const INACTIVE_MAX_AGE_MAX_HOURS = 168 // 7 days

export type SessionStatus = 'working' | 'waiting' | 'permission' | 'unknown'

export type SessionSource = 'managed' | 'external'
export type AgentType = 'claude' | 'claude-rp' | 'codex' | 'pi'
export type TerminalErrorCode =
  | 'ERR_INVALID_WINDOW'
  | 'ERR_SESSION_CREATE_FAILED'
  | 'ERR_START_TIMEOUT'
  | 'ERR_TMUX_ATTACH_FAILED'
  | 'ERR_TMUX_SWITCH_FAILED'
  | 'ERR_TTY_DISCOVERY_TIMEOUT'
  | 'ERR_NOT_READY'

export interface Session {
  id: string
  name: string
  tmuxWindow: string
  projectPath: string
  status: SessionStatus
  lastActivity: string
  createdAt: string
  agentType?: AgentType
  source: SessionSource
  host?: string
  remote?: boolean
  command?: string
  agentSessionId?: string
  agentSessionName?: string
  logFilePath?: string
  lastUserMessage?: string
  isPinned?: boolean
}

export interface AgentSession {
  sessionId: string
  logFilePath: string
  projectPath: string
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  isActive: boolean
  host?: string
  lastUserMessage?: string
  isPinned?: boolean
  lastResumeError?: string
}

export interface HostStatus {
  host: string
  ok: boolean
  lastUpdated: string
  error?: string
}

// Directory browser types
export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryListing {
  path: string
  parent: string | null
  directories: DirectoryEntry[]
  truncated: boolean
}

export interface DirectoryErrorResponse {
  error: 'invalid_path' | 'forbidden' | 'not_found' | 'internal_error'
  message: string
}

export type ServerMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session-update'; session: Session }
  | { type: 'session-created'; session: Session }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'host-status'; hosts: HostStatus[] }
  | { type: 'agent-sessions'; active: AgentSession[]; inactive: AgentSession[] }
  | { type: 'session-orphaned'; session: AgentSession }
  | { type: 'session-activated'; session: AgentSession; window: string }
  | { type: 'session-resume-result'; sessionId: string; ok: boolean; session?: Session; error?: ResumeError }
  | { type: 'session-pin-result'; sessionId: string; ok: boolean; error?: string }
  | { type: 'session-resurrection-failed'; sessionId: string; displayName: string; error: string }
  | { type: 'terminal-output'; sessionId: string; data: string }
  | {
      type: 'terminal-error'
      sessionId: string | null
      code: TerminalErrorCode
      message: string
      retryable: boolean
    }
  | { type: 'terminal-ready'; sessionId: string }
  | { type: 'tmux-copy-mode-status'; sessionId: string; inCopyMode: boolean }
  | { type: 'server-config'; remoteAllowControl: boolean; remoteAllowAttach: boolean; hostLabel: string }
  | { type: 'error'; message: string }
  | { type: 'kill-failed'; sessionId: string; message: string }

export interface ResumeError {
  code: 'NOT_FOUND' | 'ALREADY_ACTIVE' | 'RESUME_FAILED'
  message: string
}

export type ClientMessage =
  | {
      type: 'terminal-attach'
      sessionId: string
      tmuxTarget?: string
      cols?: number
      rows?: number
    }
  | { type: 'terminal-detach'; sessionId: string }
  | { type: 'terminal-input'; sessionId: string; data: string }
  | { type: 'terminal-resize'; sessionId: string; cols: number; rows: number }
  | { type: 'session-create'; projectPath: string; name?: string; command?: string; host?: string }
  | { type: 'session-kill'; sessionId: string }
  | { type: 'session-rename'; sessionId: string; newName: string }
  | { type: 'session-refresh' }
  | { type: 'tmux-cancel-copy-mode'; sessionId: string }
  | { type: 'tmux-check-copy-mode'; sessionId: string }
  | { type: 'session-resume'; sessionId: string; name?: string }
  | { type: 'session-pin'; sessionId: string; isPinned: boolean }

// Typed function signatures for client-side messaging
export type SendClientMessage = (message: ClientMessage) => void
export type SubscribeServerMessage = (listener: (message: ServerMessage) => void) => () => void
