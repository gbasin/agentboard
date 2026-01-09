interface TerminalCallbacks {
  onData: (data: string) => void
  onExit?: () => void
}

export class TerminalProxy {
  private process: Subprocess | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()

  constructor(
    private tmuxWindow: string,
    private callbacks: TerminalCallbacks
  ) {}

  start(): void {
    if (this.process) {
      return
    }

    const proc = Bun.spawn([
      'tmux',
      'attach',
      '-t',
      this.tmuxWindow,
    ], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      pty: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TMUX: undefined,
      },
    })

    this.process = proc
    this.writer = proc.stdin.getWriter()

    this.readStream(proc.stdout)
    this.readStream(proc.stderr)

    proc.exited.then(() => {
      this.callbacks.onExit?.()
    })
  }

  write(data: string): void {
    if (!this.writer) {
      return
    }

    void this.writer.write(this.encoder.encode(data))
  }

  resize(cols: number, rows: number): void {
    const proc = this.process as
      | (Subprocess & { resize?: (cols: number, rows: number) => void })
      | null

    if (proc?.resize) {
      proc.resize(cols, rows)
      return
    }

    try {
      Bun.spawnSync([
        'tmux',
        'resize-window',
        '-t',
        this.tmuxWindow,
        '-x',
        String(cols),
        '-y',
        String(rows),
      ])
    } catch {
      // Ignore resize failures; terminal will still work.
    }
  }

  dispose(): void {
    if (!this.process) {
      return
    }

    try {
      this.process.kill()
    } catch {
      // Ignore if already exited.
    }

    this.process = null
    this.writer = null
  }

  private async readStream(stream: ReadableStream<Uint8Array> | null) {
    if (!stream) {
      return
    }

    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        this.callbacks.onData(this.decoder.decode(value))
      }
    }
  }
}
