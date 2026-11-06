// One pipe and tail per physical tmux pane. Leases register before startup
// yields, so the last viewer can cancel pending filesystem work as well.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shellQuote } from '../shellQuote'
import { sanitizedTmuxEnv } from '../tmuxEnv'
import type { SpawnFn } from './types'

type Subscriber = { onData: (data: string) => void; onExit: () => void }
type Transport = {
  runTmux: (args: string[]) => string; spawn: SpawnFn
  onResource?: (resource: { root: string; pid?: number; closed?: true }) => void
}
export type PaneOutputLease = { ready: Promise<void>; release: () => Promise<void> }
const feeds = new Map<string, PaneOutputFeed>()

export function subscribePaneOutput(key: string, target: string, transport: Transport, subscriber: Subscriber): PaneOutputLease {
  let feed = feeds.get(key)
  if (!feed) {
    feed = new PaneOutputFeed(key, target, transport)
    feeds.set(key, feed)
  }
  return feed.subscribe(subscriber)
}

class PaneOutputFeed {
  private subscribers = new Set<Subscriber>()
  private closed = false
  private root: string | null = null
  private process: ReturnType<SpawnFn> | null = null
  private installed = false
  private starting: Promise<void> | null = null
  private cleanup: Promise<void> | null = null
  private preparingFile: Promise<void> | null = null

  constructor(private key: string, private target: string, private transport: Transport) {}

  subscribe(subscriber: Subscriber): PaneOutputLease {
    this.subscribers.add(subscriber)
    this.starting ??= this.start().catch(async (error) => {
      await this.close()
      throw error
    })
    let released = false
    return {
      ready: this.starting,
      release: () => {
        if (released) return this.cleanup ?? Promise.resolve()
        released = true
        this.subscribers.delete(subscriber)
        if (this.subscribers.size) return Promise.resolve()
        const cleanup = this.close()
        return Promise.all([cleanup, this.starting?.catch(() => {})]).then(() => {})
      },
    }
  }

  private async start(): Promise<void> {
    this.root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-pane-'))
    this.transport.onResource?.({ root: this.root })
    if (this.closed) {
      const root = this.root
      await this.removeRoot()
      this.transport.onResource?.({ root, closed: true })
      return
    }
    const root = this.root
    const file = path.join(root, 'output')
    this.preparingFile = fs.writeFile(file, '', { mode: 0o600 })
    await this.preparingFile
    // close() waits for this writer before removing the directory.
    if (this.closed) return
    // Quote the generated path: OS temporary directory names may contain spaces.
    const quoted = `'${file.replaceAll("'", "'\\''")}'`
    if (!this.pipePane(`cat >> ${quoted}`)) throw new Error('Tmux server changed during pipe startup')
    this.installed = true
    const proc = this.transport.spawn(['tail', '-n', '+1', '-F', file], {
      stdout: 'pipe', stderr: 'ignore', env: sanitizedTmuxEnv(),
    })
    this.process = proc
    this.transport.onResource?.({ root: this.root!, pid: proc.pid })
    const stdout = proc.stdout
    if (stdout && typeof stdout !== 'number') void this.read(stdout)
    void proc.exited.then(() => {
      if (this.closed) return
      const subscribers = [...this.subscribers]
      void this.close()
      for (const subscriber of subscribers) {
        try { subscriber.onExit() } catch { /* Isolate viewer callbacks. */ }
      }
    })
  }

  private async read(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    try {
      while (!this.closed) {
        const { value, done } = await reader.read()
        if (done) break
        const data = decoder.decode(value, { stream: true })
        if (!this.closed && data) {
          for (const subscriber of this.subscribers) {
            try { subscriber.onData(data) } catch { /* Isolate viewer callbacks. */ }
          }
        }
      }
      const tail = decoder.decode()
      if (!this.closed && tail) {
        for (const subscriber of this.subscribers) {
          try { subscriber.onData(tail) } catch { /* Isolate viewer callbacks. */ }
        }
      }
    } catch { /* Process termination can interrupt a read. */ }
    finally { reader.releaseLock() }
  }

  private close(): Promise<void> {
    if (this.closed) return this.cleanup ?? Promise.resolve()
    this.closed = true
    if (feeds.get(this.key) === this) feeds.delete(this.key)
    this.subscribers.clear()
    if (this.installed) {
      try { this.pipePane() } catch { /* Pane may be gone. */ }
      this.installed = false
    }
    const proc = this.process
    try { proc?.kill() } catch { /* Already exited. */ }
    this.process = null
    const root = this.root
    this.cleanup = Promise.all([
      this.preparingFile?.catch(() => {}).then(() => this.removeRoot()) ?? this.removeRoot(),
      proc?.exited.catch(() => {}),
    ]).then(() => {
      if (root) this.transport.onResource?.({ root, closed: true })
    })
    return this.cleanup
  }

  private pipePane(command?: string): boolean {
    const epoch = this.key.match(/:(\d+):(%\d+)$/)
    if (!epoch) {
      this.transport.runTmux(['pipe-pane', '-t', this.target, ...(command ? [command] : [])])
      return true
    }
    // Evaluate the server identity and mutate its pane in the same tmux
    // command queue. A restarted server can reuse both its socket and %0.
    const mutation = `pipe-pane -t ${epoch[2]}${command ? ` ${shellQuote(command)}` : ''}`
    const result = this.transport.runTmux([
      'if-shell', '-F', '-t', epoch[2], `#{==:#{pid},${epoch[1]}}`,
      mutation, 'display-message -p agentboard-stale-pane',
    ])
    return result.trim() !== 'agentboard-stale-pane'
  }

  private async removeRoot(): Promise<void> {
    if (!this.root) return
    const root = this.root
    this.root = null
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
