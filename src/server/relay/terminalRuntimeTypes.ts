import type { TerminalSession } from './protocol'
/** Stable terminal state belongs to a relay lease, not its current WebSocket. */
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { CopyModeQuery } from '../copyModeQuery'
import type { ITerminalProxy, TerminalProxyOptions } from '../terminal'

export type AttachId = number
export type TerminalMessage = ClientMessage & { attachId?: AttachId }
export type TerminalResponse = ServerMessage & { attachId?: AttachId }
export interface TerminalIdentity { sessionId: string; target: string; host: string | null; remote: boolean }

export function terminalIdentity(session: TerminalSession): TerminalIdentity {
  return { sessionId: session.id, target: session.tmuxWindow, host: session.host ?? null, remote: session.remote === true }
}

export function matchesTerminalIdentity(identity: TerminalIdentity | null, session: TerminalSession | undefined): boolean {
  return identity !== null && session !== undefined && identity.sessionId === session.id && identity.target === session.tmuxWindow && identity.host === (session.host ?? null) && identity.remote === (session.remote === true)
}

export interface TerminalPeerData {
  connectionId: string
  terminal: ITerminalProxy | null
  terminalHost: string | null
  currentSessionId: string | null
  currentTmuxTarget: string | null
  attachedIdentity: TerminalIdentity | null
  terminalAttachSeq: number
  attachId?: AttachId
  inputReady: boolean
  copyModeQuery: CopyModeQuery
  clipboardPollTimer: ReturnType<typeof setInterval> | null
  clipboardPollInFlight: boolean
  lastClipboardBufferKey: string | null
  clipboardBufferArmedUntil: number
  clipboardArmedAtSec: number
  clipboardWatchGen: number
}

export interface TerminalPeer {
  data: TerminalPeerData
  readyState: number
  send(payload: string): unknown
}

export interface TerminalRuntimeOptions {
  getSession(id: string): TerminalSession | undefined
  onGroupedSessionCreated?: () => void
  onSubmit?: (sessionId: string) => void
  createProxy?: (options: TerminalProxyOptions) => ITerminalProxy
  capture?: (target: string, host?: string) => Promise<string | null>
  cancelCopyMode?: (peer: TerminalPeer, session: TerminalSession) => Promise<void>
  checkCopyMode?: (peer: TerminalPeer, session: TerminalSession, isCurrent: () => boolean) => Promise<void>
  clipboard?: {
    start(peer: TerminalPeer, session: TerminalSession): void
    stop(peer: TerminalPeer): void
    arm(peer: TerminalPeer, input: string): void
  }
}

export function createTerminalPeerData(connectionId: string): TerminalPeerData {
  return {
    connectionId,
    terminal: null,
    terminalHost: null,
    currentSessionId: null,
    currentTmuxTarget: null,
    attachedIdentity: null,
    terminalAttachSeq: 0,
    inputReady: false,
    copyModeQuery: new CopyModeQuery(),
    clipboardPollTimer: null,
    clipboardPollInFlight: false,
    lastClipboardBufferKey: null,
    clipboardBufferArmedUntil: 0,
    clipboardArmedAtSec: 0,
    clipboardWatchGen: 0,
  }
}

export function sendTerminal(peer: TerminalPeer, message: ServerMessage): void {
  if (peer.readyState !== 1) return
  peer.send(JSON.stringify({ ...message, ...(peer.data.attachId !== undefined ? { attachId: peer.data.attachId } : {}) }))
}

export function matchesAttach(peer: TerminalPeer, message: TerminalMessage): boolean {
  return peer.data.attachId === message.attachId
}
