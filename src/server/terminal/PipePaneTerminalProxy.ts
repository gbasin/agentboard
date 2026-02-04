import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TerminalProxyBase } from './TerminalProxyBase'
import { TerminalProxyError, TerminalState } from './types'
import type { TerminalProxyOptions } from './types'

class PipePaneTerminalProxy extends TerminalProxyBase {
  private tailProcess: ReturnType<typeof Bun.spawn> | null = null
  private tailSequence = 0
  private cols = 80
  private rows = 24
  private currentTarget: string | null = null
  private pipeRoot: string
  private disposing = false
  private monitorInterval: ReturnType<typeof setInterval> | null = null
  private monitorEnabled: boolean

  constructor(options: TerminalProxyOptions) {
    super(options)
    this.monitorEnabled = options.monitorTargets ?? true
    this.pipeRoot = path.join(
      os.tmpdir(),
      'agentboard-pipes',
      sanitizeConnectionId(options.connectionId)
    )
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

      // Check for SGR mouse scroll sequences: ESC[<64;col;rowM (up) or ESC[<65;col;rowM (down)
      // These need special handling in pipe-pane mode since send-keys -l sends them to the shell
      // instead of tmux's mouse handler
      // eslint-disable-next-line no-control-regex
      const scrollMatch = data.match(/^\x1b\[<(64|65);\d+;\d+M$/)
      if (scrollMatch) {
        const direction = scrollMatch[1] === '64' ? 'scroll-up' : 'scroll-down'
        // Enter copy-mode if not already (idempotent)
        this.runTmux(['copy-mode', '-t', this.currentTarget])
        // Send scroll command
        this.runTmux(['send-keys', '-X', '-t', this.currentTarget, direction])
        return
      }

      const lines = data.split('\n')
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

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows

    if (!this.currentTarget || this.state === TerminalState.DEAD) {
      return
    }

    this.resizeTarget(this.currentTarget, cols, rows)
  }

  async dispose(): Promise<void> {
    this.state = TerminalState.DEAD
    this.outputSuppressed = false
    this.disposing = true

    this.stopMonitor()
    await this.stopPipe(this.currentTarget)
    this.stopTail()

    try {
      await fs.rm(this.pipeRoot, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures
    }

    this.currentTarget = null
    this.currentWindow = null
    this.readyAt = null
    this.startPromise = null
    this.disposing = false
  }

  protected async doStart(): Promise<void> {
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

    try {
      await this.ensurePipeRoot()
    } catch (error) {
      this.state = TerminalState.DEAD
      throw new TerminalProxyError(
        'ERR_TMUX_ATTACH_FAILED',
        error instanceof Error ? error.message : 'Failed to prepare pipe directory',
        true
      )
    }

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
      await this.stopPipe(this.currentTarget)
      this.stopTail()
      this.clearPipePane(target)

      const pipeFile = await this.preparePipeFile(target)
      this.startPipePane(target, pipeFile)
      this.startTail(pipeFile)
      this.resizeTarget(target, this.cols, this.rows)

      if (onReady) {
        try {
          onReady()
        } catch {
          // Ignore onReady failures
        }
      }

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

  private async ensurePipeRoot(): Promise<void> {
    await fs.mkdir(this.pipeRoot, { recursive: true, mode: 0o700 })
    try {
      await fs.chmod(this.pipeRoot, 0o700)
    } catch {
      // Ignore chmod failures
    }
  }

  private async preparePipeFile(target: string): Promise<string> {
    const pipeFile = this.getPipeFile(target)
    await fs.writeFile(pipeFile, '', { mode: 0o600 })
    try {
      await fs.chmod(pipeFile, 0o600)
    } catch {
      // Ignore chmod failures
    }
    return pipeFile
  }

  private startPipePane(target: string, pipeFile: string): void {
    const command = `cat >> ${pipeFile}`
    this.runTmux(['pipe-pane', '-t', target, command])
  }

  private startTail(pipeFile: string): void {
    const sequence = ++this.tailSequence

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = this.spawn(['tail', '-n', '+1', '-F', pipeFile], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (error) {
      throw new TerminalProxyError(
        'ERR_TMUX_ATTACH_FAILED',
        error instanceof Error ? error.message : 'Failed to start pipe tail',
        true
      )
    }

    this.tailProcess = proc

    const stdout = proc.stdout
    if (stdout && typeof stdout !== 'number') {
      const reader = stdout.getReader()
      const decoder = new TextDecoder()
      const readLoop = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value || sequence !== this.tailSequence) {
              continue
            }
            const text = decoder.decode(value, { stream: true })
            if (text && !this.outputSuppressed) {
              this.options.onData(text)
            }
          }
          const tail = decoder.decode()
          if (tail && sequence === this.tailSequence && !this.outputSuppressed) {
            this.options.onData(tail)
          }
        } catch {
          // Ignore tail read errors
        }
      }
      void readLoop()
    }

    proc.exited.then(() => {
      if (sequence !== this.tailSequence) {
        return
      }
      this.tailProcess = null
      if (this.state === TerminalState.DEAD || this.disposing) {
        return
      }
      this.state = TerminalState.DEAD
      this.logEvent('terminal_proxy_dead', {
        sessionName: this.options.sessionName,
        mode: this.getMode(),
      })
      this.options.onExit?.()
    })
  }

  private stopTail(): void {
    this.tailSequence += 1
    if (!this.tailProcess) {
      return
    }

    try {
      this.tailProcess.kill()
    } catch {
      // Ignore kill failures
    }
    this.tailProcess = null
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
        output = this.runTmux([
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
      void this.stopPipe(monitorTarget)
      this.stopTail()
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

  private async stopPipe(target: string | null): Promise<void> {
    if (!target) {
      return
    }

    try {
      this.runTmux(['pipe-pane', '-t', target])
    } catch {
      // Ignore pipe stop failures
    }
  }

  private clearPipePane(target: string): void {
    try {
      this.runTmux(['pipe-pane', '-t', target])
    } catch {
      // Ignore pipe reset failures
    }
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

  private getPipeFile(target: string): string {
    const token = Buffer.from(target).toString('hex')
    return path.join(this.pipeRoot, `${token}.pipe`)
  }
}

function sanitizeConnectionId(connectionId: string): string {
  const sanitized = connectionId.replace(/[^A-Za-z0-9_-]/g, '')
  return sanitized || 'connection'
}

export { PipePaneTerminalProxy }
