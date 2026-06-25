import { TerminalProxyBase } from './TerminalProxyBase'
import { TerminalProxyError, TerminalState } from './types'
import { resolveGroupedSessionSwitchTarget } from './groupedSessionTarget'
import { buildTmuxFormat, splitTmuxFields } from '../tmuxFormat'

const CLIENT_TTY_FORMAT = buildTmuxFormat([
  '#{client_tty}',
  '#{client_pid}',
])
const TARGET_IDENTITY_FORMAT = buildTmuxFormat([
  '#{session_name}',
  '#{window_id}',
])

// `set-clipboard` is a server-global tmux option, so enabling it touches the
// user's whole tmux server (and isn't reverted on disconnect). It's on by
// default because the clipboard poll needs a paste buffer to read; set
// AGENTBOARD_TMUX_SET_CLIPBOARD=0 (or =false) to leave the user's setting alone.
const SET_CLIPBOARD_ENABLED =
  process.env.AGENTBOARD_TMUX_SET_CLIPBOARD !== '0' &&
  process.env.AGENTBOARD_TMUX_SET_CLIPBOARD !== 'false'

interface TmuxTargetIdentity {
  sessionName: string
  windowId: string | null
}

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

  resolveEffectiveTarget(target: string): string {
    return resolveGroupedSessionSwitchTarget(
      target,
      this.options.baseSession,
      this.options.sessionName
    )
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
        // Ignore if already exited
      }
      this.process = null
    }

    try {
      this.runTmuxMutation(['kill-session', '-t', this.options.sessionName])
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
      this.runTmuxMutation([
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
        error instanceof Error
          ? error.message
          : 'Failed to create grouped session',
        true
      )
    }

    // Grouped sessions get their own session options from the global default,
    // not from the base session. Copy the base session's mouse setting so
    // SGR mouse sequences from the browser aren't silently dropped.
    let mouseValue = ''
    try {
      mouseValue = this.runTmux([
        'show-option',
        '-t',
        this.options.baseSession,
        '-v',
        'mouse',
      ]).trim()
    } catch {
      // Base session may not have an explicit mouse override; ignore
    }

    if (mouseValue) {
      try {
        this.runTmuxMutation([
          'set-option',
          '-t',
          this.options.sessionName,
          'mouse',
          mouseValue,
        ])
      } catch (error) {
        this.logEvent('terminal_mouse_mode_sync_failed', {
          sessionName: this.options.sessionName,
          baseSession: this.options.baseSession,
          mouseValue,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      this.runTmuxMutation([
        'set-option',
        '-t',
        this.options.sessionName,
        'allow-passthrough',
        'on',
      ])
    } catch (error) {
      this.logEvent('terminal_passthrough_enable_failed', {
        sessionName: this.options.sessionName,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Ensure copies inside the session land in a tmux paste buffer so the
    // server-side clipboard poll can deliver them to the browser. This matters
    // most on iOS Safari, where the async OSC 52 path can't satisfy the
    // user-gesture rule. `set-clipboard` is a SERVER option: with the modern
    // `external` default tmux forwards an app's OSC 52 to the outer terminal
    // but stores no buffer for the poll to read; `on` makes it store one.
    // Opt-out via AGENTBOARD_TMUX_SET_CLIPBOARD=0 to avoid the global change.
    if (SET_CLIPBOARD_ENABLED) {
      try {
        this.runTmuxMutation(['set-option', '-s', 'set-clipboard', 'on'])
      } catch (error) {
        this.logEvent('terminal_set_clipboard_failed', {
          sessionName: this.options.sessionName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
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

    const effectiveTarget = this.resolveEffectiveTarget(target)
    this.state = TerminalState.SWITCHING
    this.outputSuppressed = true
    const startedAt = this.now()

    this.logEvent('terminal_switch_attempt', {
      sessionName: this.options.sessionName,
      tmuxWindow: target,
      effectiveTarget,
      clientTty: this.clientTty,
      mode: this.getMode(),
    })

    try {
      const expectedIdentity = this.readTargetIdentity(effectiveTarget)
      this.runTmux(['switch-client', '-c', this.clientTty, '-t', effectiveTarget])
      const actualIdentity = await this.verifyClientTarget(
        effectiveTarget,
        expectedIdentity
      )
      try {
        this.process?.terminal?.resize(this.cols, this.rows)
      } catch {
        // Ignore resize errors; the PTY may already be closing.
      }
      try {
        this.runTmux(['refresh-client', '-t', this.clientTty])
      } catch {
        // Ignore refresh failures
      }
      if (onReady) {
        try {
          onReady()
        } catch {
          // Ignore onReady failures
        }
      }
      this.outputSuppressed = false
      if (effectiveTarget.includes(':') && actualIdentity.windowId) {
        this.setCurrentWindow(`${actualIdentity.sessionName}:${actualIdentity.windowId}`)
      } else {
        this.setCurrentWindow(effectiveTarget)
      }
      const durationMs = this.now() - startedAt
      this.logEvent('terminal_switch_success', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        effectiveTarget,
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
        effectiveTarget,
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

  private readTargetIdentity(target: string): TmuxTargetIdentity {
    const output = this.runParsedTmux([
      'display-message',
      '-p',
      '-t',
      target,
      TARGET_IDENTITY_FORMAT,
    ]).trim()
    const identity = this.parseTargetIdentity(output)
    if (!identity) {
      throw new Error(`Unable to resolve tmux target identity for ${target}`)
    }
    return identity
  }

  private readClientIdentity(): TmuxTargetIdentity {
    if (!this.clientTty) {
      throw new Error('Terminal client not ready')
    }
    const output = this.runParsedTmux([
      'display-message',
      '-p',
      '-c',
      this.clientTty,
      TARGET_IDENTITY_FORMAT,
    ]).trim()
    const identity = this.parseTargetIdentity(output)
    if (!identity) {
      throw new Error(`Unable to resolve tmux client identity for ${this.clientTty}`)
    }
    return identity
  }

  private parseTargetIdentity(output: string): TmuxTargetIdentity | null {
    const parts = splitTmuxFields(output, 2)
    if (!parts) return null
    const sessionName = parts[0]?.trim()
    const windowId = parts[1]?.trim() ?? ''
    if (!sessionName) return null
    return {
      sessionName,
      windowId: windowId || null,
    }
  }

  private identitiesMatch(
    actual: TmuxTargetIdentity,
    expected: TmuxTargetIdentity
  ): boolean {
    if (actual.sessionName !== expected.sessionName) return false
    if (!expected.windowId) return true
    return actual.windowId === expected.windowId
  }

  private async verifyClientTarget(
    effectiveTarget: string,
    expected: TmuxTargetIdentity
  ): Promise<TmuxTargetIdentity> {
    const retryDelays = [0, 25, 50, 100, 150]
    let lastActual: TmuxTargetIdentity | null = null

    for (const delay of retryDelays) {
      if (delay > 0) {
        await this.wait(delay)
        try {
          this.runTmux(['switch-client', '-c', this.clientTty!, '-t', effectiveTarget])
        } catch {
          // The final identity check below will surface a precise switch failure.
        }
      }

      const actual = this.readClientIdentity()
      lastActual = actual
      if (this.identitiesMatch(actual, expected)) {
        return actual
      }
    }

    throw new Error(
      `tmux client attached to ${lastActual?.sessionName ?? '<unknown>'}:` +
      `${lastActual?.windowId ?? '<unknown>'}, expected ` +
      `${expected.sessionName}:${expected.windowId ?? '<current>'}`
    )
  }

  private async discoverClientTty(pid: number): Promise<string> {
    const start = this.now()
    let delay = 50
    const maxWaitMs = 2000

    while (this.now() - start <= maxWaitMs) {
      let output = ''
      try {
        output = this.runParsedTmux([
          'list-clients',
          '-F',
          CLIENT_TTY_FORMAT,
        ])
      } catch {
        output = ''
      }
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parts = splitTmuxFields(trimmed, 2)
        if (!parts) continue
        const [tty, pidValue] = parts
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
