interface TerminalCallbacks {
  onData: (data: string) => void
  onExit?: () => void
}

interface TerminalOptions {
  cols?: number
  rows?: number
  spawn?: (
    args: string[],
    options: Parameters<typeof Bun.spawn>[1]
  ) => ReturnType<typeof Bun.spawn>
}

export class TerminalProxy {
  private process: ReturnType<typeof Bun.spawn> | null = null
  private decoder = new TextDecoder()
  private cols: number
  private rows: number
  private spawn: NonNullable<TerminalOptions['spawn']>
  private monitorInterval: Timer | null = null
  private pipePath: string

  constructor(
    private tmuxWindow: string,
    private callbacks: TerminalCallbacks,
    options?: TerminalOptions
  ) {
    this.cols = options?.cols ?? 80
    this.rows = options?.rows ?? 24
    this.spawn = options?.spawn ?? Bun.spawn
    // Create unique pipe path for this terminal
    this.pipePath = `/tmp/agentboard-${Date.now()}-${Math.random().toString(36).slice(2)}.pipe`
  }

  start(): void {
    if (this.process) {
      return
    }

    // Set up pipe-pane to stream output to a file we can read
    try {
      // First, ensure any existing pipe-pane is cleared
      Bun.spawnSync(['tmux', 'pipe-pane', '-t', this.tmuxWindow, ''])

      // Set up new pipe to our file (append mode, no shell escaping)
      Bun.spawnSync(['tmux', 'pipe-pane', '-t', this.tmuxWindow, '-o', `cat >> ${this.pipePath}`])

      // Also send current pane content immediately
      const captureResult = Bun.spawnSync(['tmux', 'capture-pane', '-t', this.tmuxWindow, '-p'])
      if (captureResult.exitCode === 0) {
        const content = captureResult.stdout.toString()
        if (content) {
          this.callbacks.onData(content)
        }
      }
    } catch (error) {
      console.error('Failed to set up pipe-pane:', error)
      this.callbacks.onExit?.()
      return
    }

    // Spawn tail process to follow the pipe file
    const proc = this.spawn(['tail', '-f', '-n', '+0', this.pipePath], {
      stdout: 'pipe',
      stderr: 'ignore',
    })

    this.process = proc

    // Read from stdout
    if (proc.stdout && typeof proc.stdout !== 'number') {
      const reader = proc.stdout.getReader()
      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const text = this.decoder.decode(value, { stream: true })
            if (text) {
              this.callbacks.onData(text)
            }
          }
        } catch {
          // Stream closed or errored
        } finally {
          reader.releaseLock()
        }
      }
      readLoop()
    }

    // Monitor if tmux window still exists
    this.monitorInterval = setInterval(() => {
      try {
        const result = Bun.spawnSync(['tmux', 'list-panes', '-t', this.tmuxWindow, '-F', '#{pane_id}'])
        if (result.exitCode !== 0) {
          // Window no longer exists
          this.dispose()
          this.callbacks.onExit?.()
        }
      } catch {
        // tmux command failed
        this.dispose()
        this.callbacks.onExit?.()
      }
    }, 2000)

    proc.exited.then(() => {
      this.cleanup()
      this.callbacks.onExit?.()
    })
  }

  write(data: string): void {
    if (!this.process) return

    try {
      // Use tmux send-keys with -l flag (literal) to avoid interpreting keys
      // Split on newlines to send each line separately
      const lines = data.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line) {
          Bun.spawnSync(['tmux', 'send-keys', '-t', this.tmuxWindow, '-l', line])
        }
        // Send Enter for newlines (except after the last chunk if it didn't end with \n)
        if (i < lines.length - 1 || data.endsWith('\n')) {
          Bun.spawnSync(['tmux', 'send-keys', '-t', this.tmuxWindow, 'Enter'])
        }
      }
    } catch {
      // Ignore send errors (window might be gone)
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows

    try {
      Bun.spawnSync(['tmux', 'resize-pane', '-t', this.tmuxWindow, '-x', String(cols), '-y', String(rows)])
    } catch {
      // Ignore resize errors (might not be supported on all tmux versions)
    }
  }

  private cleanup(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval)
      this.monitorInterval = null
    }

    try {
      // Clear pipe-pane
      Bun.spawnSync(['tmux', 'pipe-pane', '-t', this.tmuxWindow, ''])
    } catch {
      // Ignore cleanup errors
    }

    try {
      // Remove pipe file
      const fs = require('node:fs')
      if (fs.existsSync(this.pipePath)) {
        fs.unlinkSync(this.pipePath)
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  dispose(): void {
    if (!this.process) {
      return
    }

    this.cleanup()

    try {
      this.process.kill()
    } catch {
      // Ignore if already exited
    }
    this.process = null
  }
}
