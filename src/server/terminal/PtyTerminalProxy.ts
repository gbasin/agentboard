import { TerminalProxyBase } from './TerminalProxyBase'
import { TerminalProxyError, TerminalState } from './types'

class PtyTerminalProxy extends TerminalProxyBase {
  private process: ReturnType<typeof Bun.spawn> | null = null
  private decoder = new TextDecoder()
  private cols = 80
  private rows = 24
  private clientTty: string | null = null
  private startAttemptId = 0

  getMode(): 'pty' {
    return 'pty'
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
      /* logging-audit:intentional */
      // Ignore resize errors
    }
  }

  async dispose(): Promise<void> {
    // Invalidate any in-flight start attempt so doStart bails out before
    // mutating state after we've disposed.
    this.startAttemptId += 1
    this.state = TerminalState.DEAD
    this.outputSuppressed = false

    if (this.process) {
      try {
        this.process.kill()
        this.process.terminal?.close()
      } catch {
        /* logging-audit:intentional */
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
      /* logging-audit:intentional */
      // Ignore cleanup failures
    }

    this.clientTty = null
    this.currentWindow = null
    this.readyAt = null
    this.startPromise = null
  }

  protected async doStart(): Promise<void> {
    if (this.process) {
      return
    }

    const attemptId = ++this.startAttemptId
    const startedAt = this.now()
    this.state = TerminalState.ATTACHING

    this.logEvent('terminal_proxy_start', {
      sessionName: this.options.sessionName,
      baseSession: this.options.baseSession,
      mode: this.getMode(),
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
      /* logging-audit:intentional */
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_SESSION_CREATE_FAILED',
        error instanceof Error
          ? error.message
          : 'Failed to create grouped session',
        true
      )
    }

    if (attemptId !== this.startAttemptId) {
      await this.dispose()
      return
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = this.spawn(['tmux', 'attach', '-t', this.options.sessionName], {
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
      /* logging-audit:intentional */
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_TMUX_ATTACH_FAILED',
        error instanceof Error ? error.message : 'Failed to attach tmux client',
        true
      )
    }

    if (attemptId !== this.startAttemptId) {
      try {
        proc.kill()
        proc.terminal?.close()
      } catch {
        /* logging-audit:intentional */
        // Ignore if already exited
      }
      await this.dispose()
      return
    }

    this.process = proc

    proc.exited.then(() => {
      if (this.process !== proc) return
      this.process = null
      this.state = TerminalState.DEAD
      this.logEvent('terminal_proxy_dead', {
        sessionName: this.options.sessionName,
        mode: this.getMode(),
      })
      this.options.onExit?.()
    })

    try {
      const tty = await this.discoverClientTty(proc.pid)
      if (attemptId !== this.startAttemptId) {
        await this.dispose()
        return
      }
      this.clientTty = tty
      this.readyAt = this.now()
      this.state = TerminalState.READY
      this.logEvent('terminal_proxy_ready', {
        sessionName: this.options.sessionName,
        clientTty: tty,
        durationMs: this.readyAt - startedAt,
        mode: this.getMode(),
      })
    } catch (error) {
      /* logging-audit:intentional */
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
      this.runTmux(['switch-client', '-c', this.clientTty, '-t', target])
      if (onReady) {
        try {
          onReady()
        } catch {
          /* logging-audit:intentional */
          // Ignore onReady failures
        }
      }
      this.outputSuppressed = false
      this.setCurrentWindow(target)
      try {
        this.runTmux(['refresh-client', '-t', this.clientTty])
      } catch {
        /* logging-audit:intentional */
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
      /* logging-audit:intentional */
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

  private async discoverClientTty(pid: number): Promise<string> {
    const start = this.now()
    let delay = 50
    const maxWaitMs = 2000

    while (this.now() - start <= maxWaitMs) {
      let output = ''
      try {
        output = this.runTmux([
          'list-clients',
          '-F',
          '#{client_tty} #{client_pid}',
        ])
      } catch {
        /* logging-audit:intentional */
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
}

export { PtyTerminalProxy }
