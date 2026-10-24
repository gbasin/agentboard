import type { TerminalSession } from './protocol'
/** Terminal operations run in the lease worker, outside dashboard and peers. */
import { config } from '../config'
import { logger } from '../logger'
import { createTerminalProxy, SshTerminalProxy, TerminalProxyError } from '../terminal'
import type { ITerminalProxy, TerminalProxyOptions } from '../terminal'
import type { ClientMessage, TerminalErrorCode } from '../../shared/types'
import { isValidSessionId, isValidTmuxTarget } from '../validators'
import { armRelayClipboard, startRelayClipboard, stopRelayClipboard } from './terminalRuntimeClipboard'
import { cancelTerminalCopyMode, captureTerminalScreen, checkTerminalCopyMode, terminalSshOptions } from './terminalRuntimeCommands'
import { matchesAttach, matchesTerminalIdentity, terminalIdentity, sendTerminal, type TerminalMessage, type TerminalPeer, type TerminalRuntimeOptions } from './terminalRuntimeTypes'
export { createTerminalPeerData } from './terminalRuntimeTypes'
export type { TerminalPeer, TerminalPeerData, TerminalRuntimeOptions } from './terminalRuntimeTypes'

const COMMANDS = new Set(['terminal-attach', 'terminal-detach', 'terminal-input', 'terminal-paste', 'terminal-resize', 'tmux-cancel-copy-mode', 'tmux-check-copy-mode'])

export class TerminalRuntime {
  private readonly clipboard: NonNullable<TerminalRuntimeOptions['clipboard']>
  private readonly pendingCopyMode = new WeakMap<TerminalPeer, Promise<void>>()

  constructor(private readonly options: TerminalRuntimeOptions) {
    this.clipboard = options.clipboard ?? { start: (peer, session) => startRelayClipboard(peer, session, options.getSession), stop: stopRelayClipboard, arm: armRelayClipboard }
  }

  /** The capability handshake owns transport establishment; PTY starts lazily. */
  open(_peer: TerminalPeer): void {}

  handle(peer: TerminalPeer, message: TerminalMessage): boolean {
    if (!COMMANDS.has(message.type)) return false
    if (message.type === 'terminal-attach') {
      const id = message.attachId
      if (id !== undefined && !(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) return true
      const sequence = ++peer.data.terminalAttachSeq
      peer.data.attachId = id
      peer.data.inputReady = false
      peer.data.currentSessionId = null
      peer.data.currentTmuxTarget = null
      peer.data.attachedIdentity = null
      this.clipboard.stop(peer)
      void this.attach(peer, message, sequence).catch(error => {
        if (this.current(peer, sequence)) this.error(peer, message.sessionId, error, 'ERR_TMUX_ATTACH_FAILED')
      })
      return true
    }
    if (!matchesAttach(peer, message)) return true
    if (message.type === 'terminal-detach') { this.suspend(peer); return true }
    if (!('sessionId' in message) || typeof message.sessionId !== 'string') return true
    const session = this.options.getSession(message.sessionId)
    if (!this.identityCurrent(peer, message.sessionId) || !session) return true
    if (message.type === 'tmux-check-copy-mode') {
      void (this.options.checkCopyMode ?? checkTerminalCopyMode)(peer, session, () => this.identityCurrent(peer, session.id)).catch(() => {})
      return true
    }
    if (!peer.data.inputReady || peer.data.currentSessionId !== message.sessionId) return true
    if (message.type === 'tmux-cancel-copy-mode') {
      const sequence = peer.data.terminalAttachSeq
      const pending = this.pendingCopyMode.get(peer) ?? Promise.resolve()
      this.trackCopyMode(peer, pending.then(async () => {
        if (this.current(peer, sequence) && this.identityCurrent(peer, session.id)) await (this.options.cancelCopyMode ?? cancelTerminalCopyMode)(peer, session)
      }))
    } else if (message.type === 'terminal-input' && typeof message.data === 'string') {
      this.afterCopyMode(peer, message, () => {
        if (!session.remote) this.clipboard.arm(peer, message.data)
        peer.data.terminal?.write(message.data)
        if (!session.remote && /[\r\n]/.test(message.data)) this.options.onSubmit?.(session.id)
      })
    } else if (message.type === 'terminal-paste' && typeof message.data === 'string') {
      // Paste is not a submit. Preserve bracketed-paste semantics in the proxy.
      this.afterCopyMode(peer, message, () => peer.data.terminal?.paste(message.data))
    } else if (message.type === 'terminal-resize' && this.dimensions(message.cols, message.rows)) {
      peer.data.terminal?.resize(message.cols, message.rows)
    }
    return true
  }

  /** Invalidate all in-flight work while preserving the observer for reconnect. */
  suspend(peer: TerminalPeer): void {
    peer.data.terminalAttachSeq++
    peer.data.inputReady = false
    peer.data.currentSessionId = null
    peer.data.currentTmuxTarget = null
    peer.data.attachedIdentity = null
    this.clipboard.stop(peer)
    this.pendingCopyMode.delete(peer)
  }

  private trackCopyMode(peer: TerminalPeer, operation: Promise<void>): void {
    const pending = operation.catch(() => {})
    this.pendingCopyMode.set(peer, pending)
    void pending.then(() => { if (this.pendingCopyMode.get(peer) === pending) this.pendingCopyMode.delete(peer) })
  }

  private afterCopyMode(peer: TerminalPeer, message: TerminalMessage, action: () => void): void {
    const sequence = peer.data.terminalAttachSeq
    const session = 'sessionId' in message ? this.options.getSession(message.sessionId) : undefined
    const run = () => {
      if (!session) return
      if (!this.identityCurrent(peer, session.id)) return
      if (this.current(peer, sequence) && peer.data.inputReady && matchesAttach(peer, message)) action()
    }
    const pending = this.pendingCopyMode.get(peer)
    if (pending) this.trackCopyMode(peer, pending.then(run))
    else run()
  }

  async dispose(peer: TerminalPeer): Promise<void> {
    this.suspend(peer)
    const terminal = peer.data.terminal
    peer.data.terminal = null
    peer.data.terminalHost = null
    if (terminal) await terminal.dispose()
  }

  private current(peer: TerminalPeer, sequence: number): boolean {
    return peer.readyState === 1 && peer.data.terminalAttachSeq === sequence
  }

  private identityCurrent(peer: TerminalPeer, sessionId: string): boolean {
    if (!peer.data.attachedIdentity || peer.data.attachedIdentity.sessionId !== sessionId) return false
    const latest = this.options.getSession(sessionId)
    if (matchesTerminalIdentity(peer.data.attachedIdentity, latest) && !(latest?.remote && !config.remoteAllowAttach)) return true
    if (peer.data.attachedIdentity !== null) {
      this.suspend(peer)
      this.invalid(peer, sessionId, 'TerminalSession changed; attach again')
    }
    return false
  }

  private dimensions(cols: unknown, rows: unknown): boolean {
    return typeof cols === 'number' && typeof rows === 'number' && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000
  }

  private makeProxy(peer: TerminalPeer, session: TerminalSession): ITerminalProxy {
    const host = session.remote ? session.host : undefined
    const options: TerminalProxyOptions = {
      connectionId: peer.data.connectionId,
      sessionName: `${config.tmuxSession}-ws-${peer.data.connectionId}`,
      baseSession: host ? '' : config.tmuxSession,
      monitorTargets: config.terminalMonitorTargets,
      onGroupedSessionCreated: this.options.onGroupedSessionCreated,
      ...(host ? { host, sshOptions: terminalSshOptions(), commandTimeoutMs: config.remoteTimeoutMs } : {}),
      onData: data => {
        if (peer.data.terminal !== terminal || !peer.data.currentSessionId) return
        if (!this.identityCurrent(peer, peer.data.currentSessionId)) return
        sendTerminal(peer, { type: 'terminal-output', sessionId: peer.data.currentSessionId, data })
      },
      onExit: () => {
        if (peer.data.terminal !== terminal) return
        const sessionId = peer.data.currentSessionId
        this.suspend(peer)
        peer.data.terminal = null
        peer.data.terminalHost = null
        void terminal.dispose().catch(() => {})
        this.error(peer, sessionId, new Error(host ? 'SSH tmux client exited' : 'tmux client exited'), 'ERR_TMUX_ATTACH_FAILED')
      },
    }
    const terminal = this.options.createProxy?.(options) ?? (host ? new SshTerminalProxy(options) : createTerminalProxy(options))
    return terminal
  }

  private async ensureProxy(peer: TerminalPeer, session: TerminalSession, sequence: number): Promise<ITerminalProxy | null> {
    const host = session.remote && session.host ? session.host : null
    if (peer.data.terminal && peer.data.terminalHost !== host) {
      const previous = peer.data.terminal
      peer.data.terminal = null
      peer.data.terminalHost = null
      await previous.dispose()
    }
    if (!this.current(peer, sequence)) return null
    if (!peer.data.terminal) {
      peer.data.terminal = this.makeProxy(peer, session)
      peer.data.terminalHost = host
    }
    const terminal = peer.data.terminal
    try {
      await terminal.start()
    } catch (error) {
      if (peer.data.terminal === terminal) {
        peer.data.terminal = null
        peer.data.terminalHost = null
      }
      await terminal.dispose().catch(() => {})
      throw error
    }
    return this.current(peer, sequence) && peer.data.terminal === terminal ? terminal : null
  }

  private async attach(peer: TerminalPeer, message: Extract<ClientMessage, { type: 'terminal-attach' }>, sequence: number): Promise<void> {
    const { sessionId, tmuxTarget, cols, rows } = message
    if (!this.current(peer, sequence)) return
    if (!isValidSessionId(sessionId)) { this.invalid(peer, sessionId, 'Invalid session id'); return }
    const found = this.options.getSession(sessionId)
    if (!found) { this.invalid(peer, sessionId, 'TerminalSession not found'); return }
    // Copy the catalog record before yielding: callers may replace or mutate it.
    const session = { ...found }
    const identity = terminalIdentity(session)
    if (session.remote && !config.remoteAllowAttach) { this.invalid(peer, sessionId, 'Remote session is read-only'); return }
    const target = tmuxTarget ?? session.tmuxWindow
    if (!isValidTmuxTarget(target)) { this.invalid(peer, sessionId, 'Invalid tmux target'); return }
    if (target !== session.tmuxWindow) { this.invalid(peer, sessionId, 'TerminalSession target changed'); return }
    const started = performance.now()
    const terminal = await this.ensureProxy(peer, session, sequence)
    if (!terminal || !this.current(peer, sequence)) return
    if (this.dimensions(cols, rows)) terminal.resize(cols!, rows!)
    const effectiveTarget = terminal.ensureEffectiveTarget(target)
    const capture = this.options.capture ?? captureTerminalScreen
    const history = await capture(effectiveTarget, session.remote ? session.host : undefined)
    if (!this.current(peer, sequence)) return
    // Every resume and switch verifies physical target identity. A retained
    // proxy can have completed an obsolete switch after its owner disconnected.
    const switched = await terminal.switchTo(target, () => {
      if (!this.current(peer, sequence) || !matchesTerminalIdentity(identity, this.options.getSession(sessionId))) return
      peer.data.currentSessionId = sessionId
      peer.data.currentTmuxTarget = effectiveTarget
      peer.data.attachedIdentity = identity
      if (history) {
        for (let offset = 0; offset < history.length; offset += 12_000) {
          sendTerminal(peer, { type: 'terminal-output', sessionId, data: history.slice(offset, offset + 12_000) })
        }
      }
    })
    if (!this.current(peer, sequence)) return
    if (!switched) {
      this.error(peer, sessionId, new Error('Terminal switch was superseded'), 'ERR_TMUX_SWITCH_FAILED')
      return
    }
    // The catalog could have removed the pane while asynchronous verification
    // ran. Refuse readiness; the next attach must resolve a current session.
    const latest = this.options.getSession(sessionId)
    if (!matchesTerminalIdentity(identity, latest)) {
      this.suspend(peer)
      this.invalid(peer, sessionId, 'TerminalSession changed while attaching')
      return
    }
    peer.data.currentSessionId = sessionId
    peer.data.currentTmuxTarget = effectiveTarget
    peer.data.attachedIdentity = identity
    peer.data.inputReady = true
    this.clipboard.start(peer, session)
    sendTerminal(peer, { type: 'terminal-ready', sessionId })
    logger.info('terminal_attach_profile', { sessionId, target, effectiveTarget, totalMs: Math.round(performance.now() - started), connectionId: peer.data.connectionId, relay: true })
  }

  private invalid(peer: TerminalPeer, sessionId: string, message: string): void {
    this.error(peer, sessionId, new TerminalProxyError('ERR_INVALID_WINDOW', message, false), 'ERR_INVALID_WINDOW')
  }

  private error(peer: TerminalPeer, sessionId: string | null, error: unknown, fallback: TerminalErrorCode): void {
    peer.data.inputReady = false
    sendTerminal(peer, {
      type: 'terminal-error', sessionId,
      code: error instanceof TerminalProxyError ? error.code : fallback,
      message: error instanceof Error ? error.message : 'Terminal operation failed',
      retryable: error instanceof TerminalProxyError ? error.retryable : true,
    })
  }
}
