import { logger } from '../logger'
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
  protected state: TerminalState = TerminalState.INITIAL
  protected currentWindow: string | null = null
  protected readyAt: number | null = null
  protected startPromise: Promise<void> | null = null
  protected outputSuppressed = false

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

  protected runTmux(args: string[]): string {
    const result = this.spawnSync(['tmux', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      const error = result.stderr?.toString() || 'tmux command failed'
      throw new Error(error)
    }

    return result.stdout?.toString() ?? ''
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
      /* logging-audit:intentional */
      resolvers.forEach((resolver) => resolver.reject(error))
    }
  }

  abstract write(data: string): void
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
