export type SessionStatus =
  | 'working'
  | 'needs_approval'
  | 'waiting'
  | 'idle'
  | 'unknown'

export type SessionSource = 'managed' | 'external'

export interface Session {
  id: string
  name: string
  tmuxWindow: string
  projectPath: string
  status: SessionStatus
  lastActivity: string
  logFile?: string
  source: SessionSource
  command?: string
}

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
  | { type: 'session-rename'; sessionId: string; newName: string }
  | { type: 'session-refresh' }
