/** Internal relay messages never carry transcript/catalog payloads to terminal workers. */
import type { ClientMessage, Session } from '../../shared/types'

export type TerminalSession = Pick<Session, 'id' | 'tmuxWindow' | 'host' | 'remote'>

export interface RelayOptions {
  port: number
  hostname: string
  upstreamPort: number
  tlsCert: string
  tlsKey: string
  terminalColorsEnabled: boolean
}
export type ParentToRelay =
  | { type: 'init'; options: RelayOptions; sessions: TerminalSession[] }
  | { type: 'bind'; hostname: string }
  | { type: 'send'; id: string; payload: string }
  | { type: 'sessions'; sessions: TerminalSession[]; terminalColorsEnabled: boolean }
  | { type: 'shutdown' }
export type RelayToParent =
  | { type: 'listening'; hostname: string; port: number }
  | { type: 'bind-error'; hostname: string; error: string }
  | { type: 'open'; id: string; remoteAddress: string | null; userAgent: string | null }
  | { type: 'message'; id: string; payload: string }
  | { type: 'close'; id: string }
  | { type: 'group-created' }
  | { type: 'lease-created'; id: string }
  | { type: 'lease-removed'; id: string }
  | { type: 'submit'; sessionId: string }
  | { type: 'stopped' }
  | { type: 'fatal'; error: string }
export type RelayToTerminal =
  | { type: 'init'; id: string; sessions: TerminalSession[]; terminalColorsEnabled: boolean }
  | { type: 'sessions'; sessions: TerminalSession[]; terminalColorsEnabled: boolean }
  | { type: 'message'; epoch: number; message: ClientMessage }
  | { type: 'resume'; epoch: number }
  | { type: 'suspend' }
  | { type: 'credit'; sequence: number }
  | { type: 'shutdown' }
export type TerminalToRelay =
  | { type: 'send'; epoch: number; sequence: number; payload: string }
  | { type: 'overflow' }
  | { type: 'group-created' }
  | { type: 'submit'; sessionId: string }
  | { type: 'stopped' }

export function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // Snapshot the current realm's isolation, not Bun's process-start environment.
  if (env.TMUX_TMPDIR) { delete env.TMUX; delete env.TMUX_PANE }
  return env
}
