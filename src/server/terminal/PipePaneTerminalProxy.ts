import { subscribePaneOutput, type PaneOutputLease } from './PaneOutputFeed'
import { TerminalProxyBase } from './TerminalProxyBase'
import { TerminalProxyError, TerminalState } from './types'
import type { TerminalProxyOptions } from './types'

class PipePaneTerminalProxy extends TerminalProxyBase {
  private lease: PaneOutputLease | null = null
  private cols = 80
  private rows = 24
  private currentTarget: string | null = null
  private disposed = false
  private monitorInterval: ReturnType<typeof setInterval> | null = null
  private monitorEnabled: boolean

  constructor(options: TerminalProxyOptions) {
    super(options)
    this.monitorEnabled = options.monitorTargets ?? true
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new TerminalProxyError('ERR_NOT_READY', 'Terminal disposed', false))
    return super.start()
  }

  getMode(): 'pipe-pane' {
    return 'pipe-pane'
  }

  getClientTty(): string | null {
    return null
  }

  write(data: string): void {
    if (!this.currentTarget || this.state === TerminalState.DEAD) {
      return
    }

    try {
      if (!data) {
        return
      }

      // Handle SGR mouse scroll sequences that may be batched with other input.
      // In pipe-pane mode, send-keys -l passes escape sequences to the pane program
      // (shell/app) instead of tmux's mouse handler, so we intercept scroll events
      // and translate them to tmux copy-mode commands.
      //
      // SGR mouse encoding: ESC[<button;col;rowM (press) or ESC[<button;col;rowm (release)
      // Wheel up = button 64, wheel down = button 65
      // Modifier keys are OR'd as bit flags: Shift (+4), Alt (+8), Ctrl (+16)
      // So wheel-up with Shift = 68, wheel-up with Ctrl = 80, etc.
      // We mask with 0b1000011 (67) to extract the base button (64 or 65).
      // eslint-disable-next-line no-control-regex
      const sgrMousePattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
      let remaining = data
      let hasScrollEvents = false
      let hasScrollDown = false
      const nonScrollParts: string[] = []
      let lastIndex = 0

      let match: RegExpExecArray | null
      while ((match = sgrMousePattern.exec(data)) !== null) {
        const button = parseInt(match[1], 10)
        const baseButton = button & 67 // Mask off modifier bits (keep bits 0,1,6)
        const isPress = match[4] === 'M'

        // Only handle wheel events on press (not release)
        if (isPress && (baseButton === 64 || baseButton === 65)) {
          // Collect any text before this scroll sequence
          if (match.index > lastIndex) {
            nonScrollParts.push(data.slice(lastIndex, match.index))
          }
          lastIndex = match.index + match[0].length

          if (!hasScrollEvents) {
            // Enter copy-mode once (idempotent, but avoid repeated calls)
            this.runTmux(['copy-mode', '-t', this.currentTarget])
            hasScrollEvents = true
          }

          const direction = baseButton === 64 ? 'scroll-up' : 'scroll-down'
          if (baseButton === 65) {
            hasScrollDown = true
          }
          this.runTmux(['send-keys', '-X', '-t', this.currentTarget, direction])
        }
      }

      // After scroll-down events, check if we've reached the bottom and exit copy-mode
      // This prevents getting stuck in copy-mode from incidental scroll-down input
      if (hasScrollDown) {
        try {
          const scrollPos = this.runParsedTmux([
            'display-message',
            '-t',
            this.currentTarget,
            '-p',
            '#{scroll_position}',
          ]).trim()
          if (scrollPos === '0') {
            this.runTmux(['send-keys', '-X', '-t', this.currentTarget, 'cancel'])
          }
        } catch {
          // Ignore errors checking scroll position
        }
      }

      // Collect any remaining text after the last scroll sequence
      if (lastIndex < data.length) {
        nonScrollParts.push(data.slice(lastIndex))
      }

      // If we only had scroll events with no other input, we're done
      remaining = nonScrollParts.join('')
      if (!remaining) {
        return
      }

      const lines = remaining.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line) {
          this.runTmux(['send-keys', '-t', this.currentTarget, '-l', '--', line])
        }
        if (index < lines.length - 1) {
          this.runTmux(['send-keys', '-t', this.currentTarget, 'Enter'])
        }
      }
    } catch {
      // Ignore write errors
    }
  }

  paste(data: string): void {
    if (!data || !this.currentTarget || this.state === TerminalState.DEAD) {
      return
    }
    this.deliverPasteViaTmux(this.currentTarget, data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows

    if (!this.currentTarget || this.state === TerminalState.DEAD) {
      return
    }

    this.resizeTarget(this.currentTarget, cols, rows)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.state = TerminalState.DEAD
    this.outputSuppressed = true
    this.stopMonitor()
    const lease = this.lease
    this.lease = null
    this.currentTarget = null
    this.currentWindow = null
    this.readyAt = null
    await lease?.release()
  }

  protected async doStart(): Promise<void> {
    if (this.disposed) throw new TerminalProxyError('ERR_NOT_READY', 'Terminal disposed', false)
    if (this.state === TerminalState.READY || this.state === TerminalState.SWITCHING) {
      return
    }

    const startedAt = this.now()
    this.state = TerminalState.ATTACHING

    this.logEvent('terminal_proxy_start', {
      sessionName: this.options.sessionName,
      baseSession: this.options.baseSession,
      mode: this.getMode(),
    })

    this.readyAt = this.now()
    this.state = TerminalState.READY
    this.logEvent('terminal_proxy_ready', {
      sessionName: this.options.sessionName,
      durationMs: this.readyAt - startedAt,
      mode: this.getMode(),
    })
  }

  protected async doSwitch(target: string, onReady?: () => void): Promise<boolean> {
    if (this.state === TerminalState.DEAD) {
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
      mode: this.getMode(),
    })

    try {
      this.stopMonitor()
      const previous = this.lease
      this.lease = null
      await previous?.release()
      if (this.disposed) return false
      // Resolve aliases/grouped sessions to the same physical pane and socket.
      const identity = this.runParsedTmux(['display-message', '-t', target, '-p', '#{socket_path}:#{pid}:#{pane_id}']).trim()
      const key = identity || `${process.env.TMUX_TMPDIR ?? process.env.TMUX ?? 'default'}:${target}`
      const paneTarget = identity.match(/:(%\d+)$/)?.[1] ?? target
      const lease = (this.options.paneOutput ?? subscribePaneOutput)(key, paneTarget, {
        runTmux: (args) => this.runTmux(args), spawn: this.spawn,
      }, {
        onData: (data) => { if (!this.disposed && !this.outputSuppressed) this.options.onData(data) },
        onExit: () => {
          if (this.disposed) return
          this.state = TerminalState.DEAD
          this.stopMonitor()
          this.options.onExit?.()
        },
      })
      this.lease = lease
      await lease.ready
      if (this.disposed || (this.state as TerminalState) === TerminalState.DEAD) {
        await lease.release()
        return false
      }
      this.resizeTarget(target, this.cols, this.rows)

      if (onReady) {
        try {
          onReady()
        } catch {
          // Ignore onReady failures
        }
      }

      if (this.disposed) return false
      this.outputSuppressed = false
      this.currentTarget = target
      this.setCurrentWindow(target)
      this.startMonitor(target)
      const durationMs = this.now() - startedAt
      this.logEvent('terminal_switch_success', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        durationMs,
        mode: this.getMode(),
      })
      this.state = TerminalState.READY
      return true
    } catch (error) {
      await this.lease?.release()
      this.lease = null
      if (this.disposed) return false
      this.outputSuppressed = false
      this.state = TerminalState.READY
      this.logEvent('terminal_switch_failure', {
        sessionName: this.options.sessionName,
        tmuxWindow: target,
        error: error instanceof Error ? error.message : 'tmux switch failed',
        mode: this.getMode(),
      })
      throw new TerminalProxyError(
        'ERR_TMUX_SWITCH_FAILED',
        error instanceof Error ? error.message : 'Unable to switch tmux target',
        true
      )
    }
  }

  private startMonitor(target: string): void {
    if (!this.monitorEnabled) {
      return
    }
    this.stopMonitor()
    const monitorTarget = target
    this.monitorInterval = setInterval(() => {
      if (this.state === TerminalState.DEAD || this.currentTarget !== monitorTarget) {
        this.stopMonitor()
        return
      }
      let output = ''
      try {
        output = this.runParsedTmux([
          'list-panes',
          '-t',
          monitorTarget,
          '-F',
          '#{pane_id}',
        ])
      } catch {
        output = ''
      }
      if (output.trim()) {
        return
      }
      this.logEvent('terminal_target_missing', {
        sessionName: this.options.sessionName,
        tmuxWindow: monitorTarget,
        mode: this.getMode(),
      })
      void this.lease?.release()
      this.lease = null
      this.currentTarget = null
      this.currentWindow = null
      this.outputSuppressed = false
      this.state = TerminalState.READY
      this.stopMonitor()
    }, 2000)
  }

  private stopMonitor(): void {
    if (!this.monitorInterval) {
      return
    }
    clearInterval(this.monitorInterval)
    this.monitorInterval = null
  }

  private resizeTarget(target: string, cols: number, rows: number): void {
    if (!target || cols <= 0 || rows <= 0) {
      return
    }
    try {
      this.runTmux([
        'resize-pane',
        '-t',
        target,
        '-x',
        cols.toString(),
        '-y',
        rows.toString(),
      ])
    } catch {
      // Ignore resize errors
    }
  }
}

export { PipePaneTerminalProxy }
