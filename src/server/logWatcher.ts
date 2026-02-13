import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { logger } from './logger'

interface LogWatcherOptions {
  /** Directories to watch recursively */
  dirs: string[]
  /** Max recursive depth per watched directory */
  depth: number
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
  private watcher: FSWatcher | null = null
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
    if (this.watcher) return

    const watchDirs = this.resolveWatchDirs(this.options.dirs)
    this.watcher = chokidar.watch(watchDirs, {
      persistent: true,
      ignoreInitial: true,
      depth: this.options.depth,
      followSymlinks: false,
      ignored: (filePath, stats) => !this.shouldWatchPath(filePath, stats),
      usePolling: false,
    })

    this.watcher
      .on('add', (filePath) => this.handleEvent(filePath))
      .on('change', (filePath) => this.handleEvent(filePath))
      .on('error', (error) => {
        logger.warn('log_watcher_error', {
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  stop(): void {
    this.flush()
    if (!this.watcher) return
    const watcher = this.watcher
    this.watcher = null
    void watcher.close().catch((error) => {
      logger.warn('log_watcher_close_error', {
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private resolveWatchDirs(dirs: string[]): string[] {
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

  private shouldWatchPath(filePath: string, stats?: fs.Stats): boolean {
    if (!stats) return true
    if (stats.isDirectory()) return true
    if (!stats.isFile()) return false
    return filePath.endsWith('.jsonl')
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
