import { config } from '../config'
import { logger } from '../logger'
import { withTmuxUtf8Flag } from '../tmuxFormat'
import { TmuxTimeoutError } from '../tmuxTimeout'
import type {
  ITerminalProxy,
  SpawnFn,
  SpawnSyncFn,
  TerminalProxyOptions,
  WaitFn,
} from './types'
import { TerminalState } from './types'

abstract class TerminalProxyBase implements ITerminalProxy {
  protected readonly options: TerminalProxyOptions
  protected readonly spawn: SpawnFn
  protected readonly spawnSync: SpawnSyncFn
  protected readonly now: () => number
  protected readonly wait: WaitFn
  protected readonly commandTimeoutMs: number
  protected readonly mutationTimeoutMs: number
  protected state: TerminalState = TerminalState.INITIAL
  protected currentWindow: string | null = null
  protected readyAt: number | null = null
  protected startPromise: Promise<void> | null = null
  protected outputSuppressed = false

  private pasteSeq = 0
  private switchQueue: Promise<void> = Promise.resolve()
  private pendingTarget: string | null = null
  private pendingOnReady: (() => void) | undefined
  private pendingResolvers: Array<{
    resolve: (result: boolean) => void
    reject: (error: unknown) => void
  }> = []

  constructor(options: TerminalProxyOptions) {
    this.options = options
    this.spawn = options.spawn ?? Bun.spawn
    this.spawnSync = options.spawnSync ?? Bun.spawnSync
    this.now = options.now ?? Date.now
    this.wait =
      options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.commandTimeoutMs = options.commandTimeoutMs ?? config.tmuxTimeoutMs
    this.mutationTimeoutMs = options.mutationTimeoutMs ?? config.tmuxMutationTimeoutMs
  }

  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.doStart().catch((error) => {
      this.startPromise = null
      throw error
    })

    return this.startPromise
  }

  async switchTo(target: string, onReady?: () => void): Promise<boolean> {
    await this.start()

    return new Promise((resolve, reject) => {
      this.pendingTarget = target
      this.pendingOnReady = onReady
      this.pendingResolvers.push({ resolve, reject })
      this.switchQueue = this.switchQueue.then(() => this.flushSwitchQueue())
    })
  }

  isReady(): boolean {
    return this.state === TerminalState.READY
  }

  resolveEffectiveTarget(target: string): string {
    return target
  }

  getCurrentWindow(): string | null {
    return this.currentWindow
  }

  getSessionName(): string {
    return this.options.sessionName
  }

  protected abstract doStart(): Promise<void>

  protected abstract doSwitch(
    target: string,
    onReady?: () => void
  ): Promise<boolean>

  protected setCurrentWindow(target: string): void {
    this.currentWindow = extractWindowId(target)
  }

  protected runTmux(
    args: string[],
    options: { timeoutMs?: number; stdin?: string } = {}
  ): string {
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs
    const result = this.spawnSync(['tmux', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      ...(options.stdin !== undefined ? { stdin: Buffer.from(options.stdin) } : {}),
    })

    if (result.signalCode === 'SIGTERM' || result.exitCode === null) {
      throw new TmuxTimeoutError(args.join(' '), timeoutMs)
    }

    if (result.exitCode !== 0) {
      const error = result.stderr?.toString() || 'tmux command failed'
      throw new Error(error)
    }

    return result.stdout?.toString() ?? ''
  }

  protected runTmuxMutation(args: string[]): string {
    return this.runTmux(args, { timeoutMs: this.mutationTimeoutMs })
  }

  /**
   * A unique-per-paste tmux buffer name. The monotonic suffix matters for the
   * SSH proxy, whose paste is fire-and-forget async: two rapid pastes would
   * otherwise stage into (and delete) the same shared buffer and race. Sync
   * proxies (pty/pipe-pane) can't interleave, but a unique name is harmless.
   */
  protected nextPasteBufferName(): string {
    const sanitized =
      this.options.connectionId.replace(/[^A-Za-z0-9_-]/g, '') || 'connection'
    this.pasteSeq += 1
    return `agentboard-paste-${sanitized}-${this.pasteSeq}`
  }

  /**
   * Normalize CRLF/CR to LF so tmux's paste-buffer LF->CR conversion yields
   * exactly one carriage return per line (no doubled blank lines).
   */
  protected normalizePasteData(data: string): string {
    return data.replace(/\r\n?/g, '\n')
  }

  /**
   * Deliver `data` to `target` as a single bracketed paste (synchronous; used
   * by the pty and pipe-pane proxies).
   *
   * The text is staged with `load-buffer -` (read from stdin) rather than
   * `set-buffer -- <data>`: passing the payload as one argv element hits the
   * OS single-argument limit (~128 KB on Linux) for large pastes, and a failed
   * spawn would fall back to the raw write path — which splits newlines into
   * Enter keys and reintroduces the line-by-line auto-submit this fix exists to
   * prevent. `paste-buffer -p` then replays it, wrapping the payload in
   * bracketed-paste markers *only if the target pane's program requested
   * bracketed paste mode* (ESC[?2004h). That gate is keyed on the real pane —
   * not the browser xterm's view — so it works even when the browser attached
   * after the program (e.g. Claude Code) enabled the mode and never re-emitted
   * it (the no-flicker/fullscreen case). `-d` deletes the buffer after pasting.
   *
   * On failure we deliberately do NOT fall back to write(): a partial/raw
   * delivery of multi-line text is exactly the auto-submit bug.
   */
  protected deliverPasteViaTmux(target: string, data: string): void {
    const bufferName = this.nextPasteBufferName()
    const normalized = this.normalizePasteData(data)
    try {
      this.runTmux(['load-buffer', '-b', bufferName, '-'], { stdin: normalized })
    } catch (error) {
      // The paste is dropped (never fall back to a raw write — that's the
      // auto-submit bug); log so the drop isn't silent.
      this.logPasteFailure(target, 'load-buffer', normalized.length, error)
      return
    }
    try {
      this.runTmux(['paste-buffer', '-d', '-p', '-b', bufferName, '-t', target])
    } catch (error) {
      this.logPasteFailure(target, 'paste-buffer', normalized.length, error)
      // paste failed after the buffer was staged; clean it up (best-effort).
      try {
        this.runTmux(['delete-buffer', '-b', bufferName])
      } catch {
        // ignore
      }
    }
  }

  protected logPasteFailure(
    target: string,
    stage: 'load-buffer' | 'paste-buffer',
    bytes: number,
    error: unknown
  ): void {
    // warn (not the debug-level logEvent): a dropped paste is user-visible.
    logger.warn('terminal_paste_failed', {
      connectionId: this.options.connectionId,
      sessionName: this.options.sessionName,
      target,
      stage,
      bytes,
      mode: this.getMode(),
      error: error instanceof Error ? error.message : String(error),
    })
  }

  protected runParsedTmux(
    args: string[],
    options: { timeoutMs?: number } = {}
  ): string {
    return this.runTmux(withTmuxUtf8Flag(args), options)
  }

  protected logEvent(event: string, payload: Record<string, unknown> = {}): void {
    logger.debug(event, { connectionId: this.options.connectionId, ...payload })
  }

  private async flushSwitchQueue(): Promise<void> {
    if (!this.pendingTarget) {
      return
    }

    const target = this.pendingTarget
    const onReady = this.pendingOnReady
    const resolvers = this.pendingResolvers

    this.pendingTarget = null
    this.pendingOnReady = undefined
    this.pendingResolvers = []

    try {
      const result = await this.doSwitch(target, onReady)
      resolvers.forEach((resolver) => resolver.resolve(result))
    } catch (error) {
      resolvers.forEach((resolver) => resolver.reject(error))
    }
  }

  abstract write(data: string): void
  abstract paste(data: string): void
  abstract resize(cols: number, rows: number): void
  abstract dispose(): Promise<void>
  abstract getClientTty(): string | null
  abstract getMode(): 'pty' | 'pipe-pane' | 'ssh'
}

function extractWindowId(target: string): string {
  const colonIndex = target.indexOf(':')
  const windowTarget = colonIndex >= 0 ? target.slice(colonIndex + 1) : target
  const paneIndex = windowTarget.indexOf('.')
  return paneIndex >= 0 ? windowTarget.slice(0, paneIndex) : windowTarget
}

export { TerminalProxyBase }
