import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logger } from './logger'

interface LogWatcherOptions {
  /** Directories to watch recursively */
  dirs: string[]
  /** Quiet period before flushing pending paths */
  debounceMs?: number
  /** Max wait before forcing a flush */
  maxWaitMs?: number
  /** Callback invoked with deduped changed paths */
  onBatch: (paths: string[]) => void
}

const DEFAULT_DEBOUNCE_MS = 2000
const DEFAULT_MAX_WAIT_MS = 5000

export class LogWatcher {
  private watchers: fs.FSWatcher[] = []
  private pending = new Set<string>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private firstEventTime: number | null = null
  private options: Required<LogWatcherOptions>

  constructor(options: LogWatcherOptions) {
    this.options = {
      debounceMs: DEFAULT_DEBOUNCE_MS,
      maxWaitMs: DEFAULT_MAX_WAIT_MS,
      ...options,
    }
  }

  start(): void {
    if (this.watchers.length > 0) return

    const watchDirs = this.resolveWatchDirs(this.options.dirs)
    const startMs = Date.now()

    for (const dir of watchDirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
          if (!filename) return
          // filename can be Buffer on some platforms; coerce to string
          const name = typeof filename === 'string' ? filename : String(filename)
          if (!name.endsWith('.jsonl')) return
          // Skip subagent logs (matches scanDirForJsonl exclusion in logDiscovery)
          if (name.includes(`${path.sep}subagents${path.sep}`) || name.includes('/subagents/')) return
          this.handleEvent(path.join(dir, name))
        })
        watcher.on('error', (error) => {
          logger.warn('log_watcher_error', {
            dir,
            message: error instanceof Error ? error.message : String(error),
          })
        })
        this.watchers.push(watcher)
      } catch (error) {
        logger.warn('log_watcher_setup_error', {
          dir,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    logger.info('log_watcher_started', {
      dirs: watchDirs,
      watcherCount: this.watchers.length,
      setupMs: Date.now() - startMs,
    })
  }

  get watcherCount(): number {
    return this.watchers.length
  }

  stop(): void {
    this.flush()
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // Ignore close errors
      }
    }
    this.watchers = []
  }

  resolveWatchDirs(dirs: string[]): string[] {
    const home = os.homedir()
    const resolved: string[] = []
    for (const dir of dirs) {
      if (!dir) continue
      const absoluteDir = path.resolve(dir)
      let candidate = absoluteDir
      while (!fs.existsSync(candidate)) {
        const parent = path.dirname(candidate)
        if (parent === candidate) break
        candidate = parent
      }
      // Never watch home directory or filesystem root — scope is too broad
      if (candidate === home || path.dirname(candidate) === candidate) {
        continue
      }
      resolved.push(candidate)
    }
    return Array.from(new Set(resolved))
  }

  private handleEvent(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) return

    this.pending.add(filePath)
    const now = Date.now()
    if (this.firstEventTime === null) {
      this.firstEventTime = now
    }

    if (now - this.firstEventTime >= this.options.maxWaitMs) {
      this.flush()
      return
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => this.flush(), this.options.debounceMs)
  }

  private flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.firstEventTime = null

    if (this.pending.size === 0) return

    const paths = Array.from(this.pending)
    this.pending.clear()
    try {
      this.options.onBatch(paths)
    } catch (error) {
      logger.warn('log_watcher_batch_error', {
        message: error instanceof Error ? error.message : String(error),
        pathCount: paths.length,
      })
    }
  }
}
