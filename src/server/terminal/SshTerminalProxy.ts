// SshTerminalProxy — routes tmux commands through SSH for remote sessions.
// Mirrors PtyTerminalProxy but creates a standalone session on the remote host
// and tunnels all tmux interactions via SSH.

import { logger } from '../logger'
import { shellQuote } from '../shellQuote'
import { TerminalProxyBase } from './TerminalProxyBase'
import { TerminalProxyError, TerminalState } from './types'

class SshTerminalProxy extends TerminalProxyBase {
  /** Maximum time (ms) to wait for SSH startup before aborting. */
  static STARTUP_TIMEOUT_MS = 30_000

  private process: ReturnType<typeof Bun.spawn> | null = null
  private decoder = new TextDecoder()
  private cols = 80
  private rows = 24
  private clientTty: string | null = null
  private sshArgs: string[]
  private commandTimeoutMs: number
  private startAttemptId = 0

  constructor(options: ConstructorParameters<typeof TerminalProxyBase>[0]) {
    super(options)
    const host = this.options.host ?? ''
    const sshOptions = this.options.sshOptions ?? []
    this.commandTimeoutMs = this.options.commandTimeoutMs ?? 10_000
    // Disable SSH multiplexing for command-channel calls to prevent hangs
    // from stale control sockets when the long-running attach process dies.
    this.sshArgs = ['ssh', ...sshOptions, '-o', 'ControlMaster=no', host]
  }

  getMode(): 'ssh' {
    return 'ssh'
  }

  getClientTty(): string | null {
    return this.clientTty
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
      await this.runTmuxAsync(['kill-session', '-t', this.options.sessionName])
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

  /**
   * Run a tmux command on the remote host via SSH (async).
   * Uses Bun.spawn instead of spawnSync so the event loop is not blocked
   * while waiting for SSH round-trips.
   */
  protected async runTmuxAsync(args: string[]): Promise<string> {
    const remoteCmd = `tmux ${args.map(a => shellQuote(a)).join(' ')}`
    const proc = this.spawn([...this.sshArgs, remoteCmd], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const timeout = setTimeout(() => {
      try { proc.kill() } catch {}
    }, this.commandTimeoutMs)

    let exitCode: number
    let stdoutText: string
    let stderrText: string
    try {
      [exitCode, stdoutText, stderrText] = await Promise.all([
        proc.exited,
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ])
    } finally {
      clearTimeout(timeout)
    }

    if (exitCode !== 0) {
      const stderr = stderrText || 'tmux command failed'
      logger.warn('ssh_tmux_command_failed', {
        remoteCmd,
        exitCode,
        stderr: stderr.slice(0, 500),
        sessionName: this.options.sessionName,
        connectionId: this.options.connectionId,
      })
      throw new Error(stderr)
    }

    return stdoutText
  }

  protected async doStart(): Promise<void> {
    if (this.process) {
      return
    }

    const attemptId = ++this.startAttemptId
    const core = this.doStartCore(attemptId)
    core.catch(() => {}) // Prevent unhandled rejection if timeout wins

    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (attemptId !== this.startAttemptId) return
        // Invalidate this attempt so any in-flight core path bails out before mutating state.
        this.startAttemptId += 1

        logger.error('ssh_start_timeout', {
          sessionName: this.options.sessionName,
          host: this.options.host,
          timeoutMs: SshTerminalProxy.STARTUP_TIMEOUT_MS,
        })
        if (this.process) {
          try {
            this.process.kill()
            this.process.terminal?.close()
          } catch {
            // Ignore if already exited
          }
          this.process = null
        }
        this.state = TerminalState.DEAD
        reject(
          new TerminalProxyError(
            'ERR_START_TIMEOUT',
            `SSH startup timed out after ${SshTerminalProxy.STARTUP_TIMEOUT_MS}ms`,
            true
          )
        )
      }, SshTerminalProxy.STARTUP_TIMEOUT_MS)
    })

    try {
      await Promise.race([core, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private isStartAttemptCurrent(attemptId: number): boolean {
    return attemptId === this.startAttemptId
  }

  private async doStartCore(attemptId: number): Promise<void> {
    const startedAt = this.now()
    this.state = TerminalState.ATTACHING

    this.logEvent('terminal_proxy_start', {
      sessionName: this.options.sessionName,
      baseSession: this.options.baseSession,
      mode: this.getMode(),
      host: this.options.host,
    })

    try {
      await this.runTmuxAsync([
        'new-session',
        '-d',
        '-s',
        this.options.sessionName,
      ])
      if (!this.isStartAttemptCurrent(attemptId)) {
        await this.dispose()
        return
      }
      logger.info('ssh_session_created', {
        sessionName: this.options.sessionName,
        host: this.options.host,
      })
    } catch (error) {
      logger.error('ssh_session_create_failed', {
        sessionName: this.options.sessionName,
        host: this.options.host,
        error: error instanceof Error ? error.message : String(error),
      })
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_SESSION_CREATE_FAILED',
        error instanceof Error
          ? error.message
          : 'Failed to create remote session',
        true
      )
    }

    // Pass the remote tmux attach command as a single string to SSH
    const attachCmd = `tmux attach -t ${shellQuote(this.options.sessionName)}`
    const spawnArgs = [
      'ssh',
      '-tt',
      ...(this.options.sshOptions ?? []),
      this.options.host!,
      attachCmd,
    ]

    logger.info('ssh_attach_spawn', {
      sessionName: this.options.sessionName,
      spawnArgs: spawnArgs.join(' '),
    })

    let proc: ReturnType<typeof Bun.spawn>
    try {
      if (!this.isStartAttemptCurrent(attemptId)) {
        await this.dispose()
        return
      }
      proc = this.spawn(
        spawnArgs,
        {
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
        }
      )
    } catch (error) {
      logger.error('ssh_attach_spawn_failed', {
        sessionName: this.options.sessionName,
        error: error instanceof Error ? error.message : String(error),
      })
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_TMUX_ATTACH_FAILED',
        error instanceof Error ? error.message : 'Failed to attach tmux client via SSH',
        true
      )
    }

    if (!this.isStartAttemptCurrent(attemptId)) {
      try {
        proc.kill()
        proc.terminal?.close()
      } catch {
        // Ignore if already exited
      }
      await this.dispose()
      return
    }

    this.process = proc

    proc.exited.then((exitCode) => {
      this.process = null
      this.state = TerminalState.DEAD
      logger.warn('ssh_proxy_exited', {
        sessionName: this.options.sessionName,
        mode: this.getMode(),
        exitCode,
        connectionId: this.options.connectionId,
      })
      this.options.onExit?.()
    })

    try {
      const tty = await this.discoverClientTty()
      if (!this.isStartAttemptCurrent(attemptId)) {
        await this.dispose()
        return
      }
      this.clientTty = tty
      this.readyAt = this.now()
      this.state = TerminalState.READY
      logger.info('ssh_proxy_ready', {
        sessionName: this.options.sessionName,
        clientTty: tty,
        durationMs: this.readyAt - startedAt,
        mode: this.getMode(),
      })
    } catch (error) {
      logger.error('ssh_tty_discovery_failed', {
        sessionName: this.options.sessionName,
        error: error instanceof Error ? error.message : String(error),
      })
      this.state = TerminalState.DEAD
      await this.dispose()
      throw error
    }
  }

  protected async doSwitch(target: string, onReady?: () => void): Promise<boolean> {
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
      mode: this.getMode(),
    })

    try {
      await this.runTmuxAsync(['switch-client', '-c', this.clientTty, '-t', target])
      if (onReady) {
        try {
          onReady()
        } catch {
          // Ignore onReady failures
        }
      }
      this.outputSuppressed = false
      this.setCurrentWindow(target)
      try {
        await this.runTmuxAsync(['refresh-client', '-t', this.clientTty])
      } catch {
        // Ignore refresh failures
      }
      const durationMs = this.now() - startedAt
      this.logEvent('terminal_switch_success', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        clientTty: this.clientTty,
        durationMs,
        mode: this.getMode(),
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
        mode: this.getMode(),
      })
      throw new TerminalProxyError(
        'ERR_TMUX_SWITCH_FAILED',
        error instanceof Error ? error.message : 'Unable to switch tmux client',
        true
      )
    }
  }

  private async discoverClientTty(): Promise<string> {
    const start = this.now()
    let delay = 50
    const maxWaitMs = 4000

    while (this.now() - start <= maxWaitMs) {
      let output = ''
      try {
        output = await this.runTmuxAsync([
          'list-clients',
          '-t',
          this.options.sessionName,
          '-F',
          '#{client_tty}',
        ])
      } catch {
        output = ''
      }
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) {
          return trimmed
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
}

export { SshTerminalProxy }
export { shellQuote } from '../shellQuote'
