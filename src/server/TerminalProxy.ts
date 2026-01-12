import type { TerminalErrorCode } from '../shared/types'

type SpawnFn = (
  args: string[],
  options: Parameters<typeof Bun.spawn>[1]
) => ReturnType<typeof Bun.spawn>

type SpawnSyncFn = (
  args: string[],
  options: Parameters<typeof Bun.spawnSync>[1]
) => ReturnType<typeof Bun.spawnSync>

type WaitFn = (ms: number) => Promise<void>

export enum TerminalState {
  INITIAL = 'INITIAL',
  ATTACHING = 'ATTACHING',
  READY = 'READY',
  SWITCHING = 'SWITCHING',
  DEAD = 'DEAD',
}

export class TerminalProxyError extends Error {
  code: TerminalErrorCode
  retryable: boolean

  constructor(code: TerminalErrorCode, message: string, retryable: boolean) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

interface TerminalProxyOptions {
  connectionId: string
  sessionName: string
  baseSession: string
  onData: (data: string) => void
  onExit?: () => void
  spawn?: SpawnFn
  spawnSync?: SpawnSyncFn
  now?: () => number
  wait?: WaitFn
}

export class TerminalProxy {
  private process: ReturnType<typeof Bun.spawn> | null = null
  private decoder = new TextDecoder()
  private cols = 80
  private rows = 24
  private spawn: SpawnFn
  private spawnSync: SpawnSyncFn
  private now: () => number
  private wait: WaitFn
  private state: TerminalState = TerminalState.INITIAL
  private clientTty: string | null = null
  private currentWindow: string | null = null
  private readyAt: number | null = null
  private startPromise: Promise<void> | null = null
  private switchQueue: Promise<void> = Promise.resolve()
  private pendingTarget: string | null = null
  private pendingOnReady: (() => void) | undefined
  private pendingResolvers: Array<{
    resolve: (result: boolean) => void
    reject: (error: unknown) => void
  }> = []
  // TODO: Buffer and replay output during switches to avoid dropped bytes.
  private outputSuppressed = false

  constructor(
    private options: TerminalProxyOptions
  ) {
    this.spawn = options.spawn ?? Bun.spawn
    this.spawnSync = options.spawnSync ?? Bun.spawnSync
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
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

  private async doStart(): Promise<void> {
    if (this.process) {
      return
    }

    const startedAt = this.now()
    this.state = TerminalState.ATTACHING

    this.logEvent('terminal_proxy_start', {
      sessionName: this.options.sessionName,
      baseSession: this.options.baseSession,
    })

    try {
      this.runTmux([
        'new-session',
        '-d',
        '-t',
        this.options.baseSession,
        '-s',
        this.options.sessionName,
      ])
    } catch (error) {
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_SESSION_CREATE_FAILED',
        error instanceof Error ? error.message : 'Failed to create grouped session',
        true
      )
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = this.spawn(['tmux', 'attach', '-t', this.options.sessionName, '-E', '-f', 'ignore-size'], {
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
        terminal: {
          cols: this.cols,
          rows: this.rows,
          name: 'xterm-256color',
          data: (_terminal, data) => {
            const text = this.decoder.decode(data, { stream: true })
            if (!text || this.outputSuppressed) {
              return
            }
            this.options.onData(text)
          },
          exit: () => {
            const tail = this.decoder.decode()
            if (tail && !this.outputSuppressed) {
              this.options.onData(tail)
            }
          },
        },
      })
    } catch (error) {
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_TMUX_ATTACH_FAILED',
        error instanceof Error ? error.message : 'Failed to attach tmux client',
        true
      )
    }

    this.process = proc

    proc.exited.then(() => {
      this.process = null
      this.state = TerminalState.DEAD
      this.logEvent('terminal_proxy_dead', { sessionName: this.options.sessionName })
      this.options.onExit?.()
    })

    try {
      const tty = await this.discoverClientTty(proc.pid)
      this.clientTty = tty
      this.readyAt = this.now()
      this.state = TerminalState.READY
      this.logEvent('terminal_proxy_ready', {
        sessionName: this.options.sessionName,
        clientTty: tty,
        durationMs: this.readyAt - startedAt,
      })
    } catch (error) {
      this.state = TerminalState.DEAD
      await this.dispose()
      throw error
    }
  }

  write(data: string): void {
    this.process?.terminal?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows

    try {
      this.process?.terminal?.resize(cols, rows)
    } catch {
      // Ignore resize errors
    }
  }

  async dispose(): Promise<void> {
    this.state = TerminalState.DEAD
    this.outputSuppressed = false

    if (this.process) {
      try {
        this.process.kill()
        this.process.terminal?.close()
      } catch {
        // Ignore if already exited
      }
      this.process = null
    }

    try {
      this.runTmux(['kill-session', '-t', this.options.sessionName])
      this.logEvent('terminal_session_cleanup', {
        sessionName: this.options.sessionName,
      })
    } catch {
      // Ignore cleanup failures
    }

    this.clientTty = null
    this.currentWindow = null
    this.readyAt = null
    this.startPromise = null
  }

  isReady(): boolean {
    return this.state === TerminalState.READY
  }

  getClientTty(): string | null {
    return this.clientTty
  }

  getCurrentWindow(): string | null {
    return this.currentWindow
  }

  getSessionName(): string {
    return this.options.sessionName
  }

  private async doSwitch(target: string, onReady?: () => void): Promise<boolean> {
    if (!this.clientTty || this.state === TerminalState.DEAD) {
      throw new TerminalProxyError(
        'ERR_NOT_READY',
        'Terminal client not ready',
        true
      )
    }

    this.state = TerminalState.SWITCHING
    this.outputSuppressed = true
    const startedAt = this.now()

    this.logEvent('terminal_switch_attempt', {
      sessionName: this.options.sessionName,
      tmuxWindow: target,
      clientTty: this.clientTty,
    })

    try {
      this.runTmux(['switch-client', '-c', this.clientTty, '-t', target])
      if (onReady) {
        try {
          onReady()
        } catch {
          // Ignore onReady failures
        }
      }
      this.outputSuppressed = false
      this.currentWindow = extractWindowId(target)
      try {
        this.runTmux(['refresh-client', '-t', this.clientTty])
      } catch {
        // Ignore refresh failures
      }
      const durationMs = this.now() - startedAt
      this.logEvent('terminal_switch_success', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        clientTty: this.clientTty,
        durationMs,
      })
      this.state = TerminalState.READY
      return true
    } catch (error) {
      this.outputSuppressed = false
      this.state = TerminalState.READY
      this.logEvent('terminal_switch_failure', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        clientTty: this.clientTty,
        error: error instanceof Error ? error.message : 'tmux switch failed',
      })
      throw new TerminalProxyError(
        'ERR_TMUX_SWITCH_FAILED',
        error instanceof Error ? error.message : 'Unable to switch tmux client',
        true
      )
    }
  }

  private async discoverClientTty(pid: number): Promise<string> {
    const start = this.now()
    let delay = 50
    const maxWaitMs = 2000

    while (this.now() - start <= maxWaitMs) {
      let output = ''
      try {
        output = this.runTmux(['list-clients', '-F', '#{client_tty} #{client_pid}'])
      } catch {
        output = ''
      }
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const [tty, pidValue] = trimmed.split(/\s+/)
        if (!tty || !pidValue) continue
        if (Number.parseInt(pidValue, 10) === pid) {
          return tty
        }
      }

      await this.wait(delay)
      delay = Math.min(delay * 2, 800)
    }

    throw new TerminalProxyError(
      'ERR_TTY_DISCOVERY_TIMEOUT',
      'Unable to discover tmux client TTY',
      true
    )
  }

  private runTmux(args: string[]): string {
    const result = this.spawnSync(['tmux', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      const error = result.stderr.toString() || 'tmux command failed'
      throw new Error(error)
    }

    return result.stdout.toString()
  }

  private logEvent(event: string, payload: Record<string, unknown> = {}): void {
    console.log(
      JSON.stringify({
        event,
        connectionId: this.options.connectionId,
        sessionName: this.options.sessionName,
        ...payload,
      })
    )
  }
}

function extractWindowId(target: string): string {
  const colonIndex = target.indexOf(':')
  const windowTarget = colonIndex >= 0 ? target.slice(colonIndex + 1) : target
  const paneIndex = windowTarget.indexOf('.')
  return paneIndex >= 0 ? windowTarget.slice(0, paneIndex) : windowTarget
}
