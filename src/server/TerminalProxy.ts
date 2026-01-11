interface TerminalCallbacks {
  onData: (data: string) => void
  onExit?: () => void
}

type SpawnFn = (
  args: string[],
  options: Parameters<typeof Bun.spawn>[1]
) => ReturnType<typeof Bun.spawn>

export class TerminalProxy {
  private process: ReturnType<typeof Bun.spawn> | null = null
  private decoder = new TextDecoder()
  private cols = 80
  private rows = 24
  private spawn: SpawnFn

  constructor(
    private tmuxWindow: string,
    private callbacks: TerminalCallbacks,
    spawn?: SpawnFn
  ) {
    this.spawn = spawn ?? Bun.spawn
  }

  start(): void {
    if (this.process) {
      return
    }

    const proc = this.spawn(['tmux', 'attach', '-t', this.tmuxWindow], {
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
          if (text) {
            this.callbacks.onData(text)
          }
        },
        exit: () => {
          const tail = this.decoder.decode()
          if (tail) {
            this.callbacks.onData(tail)
          }
        },
      },
    })

    this.process = proc

    proc.exited.then(() => {
      this.process = null
      this.callbacks.onExit?.()
    })
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

  dispose(): void {
    if (!this.process) {
      return
    }

    try {
      this.process.kill()
      this.process.terminal?.close()
    } catch {
      // Ignore if already exited
    }
    this.process = null
  }
}
