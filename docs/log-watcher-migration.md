# Log Watcher Migration: setInterval Polling → Chokidar File Watching

Replace the current `setInterval`-based log polling with event-driven file watching using chokidar v4. Near-instant detection when agents are active, near-zero CPU when idle.

## Problem

The current `LogPoller` runs `pollOnce()` every 2-5 seconds regardless of whether any log files have changed. Each cycle:
1. Synchronously scans 3 directory trees (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`)
2. Stats all `.jsonl` files, sorts by mtime, takes top 25
3. Reads unknown files to extract metadata
4. Runs ripgrep matching via worker thread

This wastes CPU when no agents are running and adds 2-5s latency for detecting new activity.

## Solution

Use [chokidar v4](https://github.com/paulmillr/chokidar) to watch log directories for `.jsonl` file changes, with cass-style debouncing. Keep a slow fallback poll as a safety net.

### Why chokidar v4
- 1 pure-JS dependency (no native compilation)
- macOS: Uses FSEvents natively — recursive, efficient
- Linux: Manages per-directory inotify watchers automatically
- Windows: Uses ReadDirectoryChangesW
- v4 dropped from 13 deps to 1, ESM/CJS dual

### Prior art: cass (coding_agent_session_search)
cass uses the Rust `notify` crate (same concept) with a 2s debounce + 5s max-wait pattern in `src/indexer/mod.rs:1319-1441`. Their architecture validated that file watching + debouncing works well for agent log directories.

## Architecture

### Current flow
```
setInterval(5000ms)
  → scanAllLogDirs()           // sync fs.readdirSync walk
  → collectLogEntryBatch()     // stat + sort + read
  → matchWorker.poll()         // ripgrep matching
  → DB updates
```

### New flow
```
chokidar.watch(logDirs, { filter })
  → on 'add'/'change' → debouncer.push(path)
  → debouncer fires (2s quiet / 5s max-wait)
    → pollOnce(changedPaths)   // only process changed files
    → matchWorker.poll()
    → DB updates

fallback setInterval(60000ms)  // safety net, catches missed events
  → pollOnce()                 // full scan, same as today
```

## Implementation Plan

### Step 1: Add chokidar dependency

```bash
bun add chokidar
```

### Step 2: New file — `src/server/logWatcher.ts`

Encapsulates file watching and debounce logic. Emits batched change events.

```typescript
import chokidar from 'chokidar'

interface LogWatcherOptions {
  /** Directories to watch recursively */
  dirs: string[]
  /** Quiet period — wait this long after last event before firing (ms) */
  debounceMs?: number       // default: 2000
  /** Max wait — force fire even if events keep coming (ms) */
  maxWaitMs?: number        // default: 5000
  /** Callback with batch of changed file paths */
  onBatch: (paths: string[]) => void
}

export class LogWatcher {
  private watcher: chokidar.FSWatcher | null = null
  private pending: Set<string> = new Set()
  private debounceTimer: Timer | null = null
  private firstEventTime: number | null = null
  private options: Required<LogWatcherOptions>

  constructor(options: LogWatcherOptions) { ... }

  start(): void {
    this.watcher = chokidar.watch(this.options.dirs, {
      persistent: true,
      ignoreInitial: true,          // don't fire for existing files
      depth: 4,                     // match current scan depth
      ignored: [
        /(^|[/\\])\../,            // dotfiles other than the root dirs
        '**/subagents/**',          // skip subagent logs (existing behavior)
        /(?<!\.jsonl)$/,            // only watch .jsonl files
      ],
      // Low polling interval for fallback (Linux edge cases)
      usePolling: false,
    })

    this.watcher
      .on('add', (path) => this.handleEvent(path))
      .on('change', (path) => this.handleEvent(path))
      .on('error', (err) => logger.warn({ err }, 'logWatcher error'))
  }

  private handleEvent(filePath: string): void {
    // Only care about .jsonl files
    if (!filePath.endsWith('.jsonl')) return

    this.pending.add(filePath)

    if (this.firstEventTime === null) {
      this.firstEventTime = Date.now()
    }

    // Check max wait
    if (Date.now() - this.firstEventTime >= this.options.maxWaitMs) {
      this.flush()
      return
    }

    // Reset debounce timer
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flush(), this.options.debounceMs)
  }

  private flush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    this.firstEventTime = null

    if (this.pending.size === 0) return

    const paths = [...this.pending]
    this.pending.clear()
    this.options.onBatch(paths)
  }

  stop(): void {
    this.flush()
    this.watcher?.close()
    this.watcher = null
  }
}
```

### Step 3: Modify `LogPoller` to support event-driven mode

Changes to `src/server/logPoller.ts`:

1. **New method: `pollChanged(changedPaths: string[])`**
   - Like `pollOnce()` but scoped to only the changed files
   - Skips the full directory scan — goes straight to metadata extraction + matching
   - Reuses all existing caching (emptyLogCache, rematchAttemptCache, etc.)

2. **Modify `start()`** to accept a mode:
   ```typescript
   start(intervalMs: number, mode: 'poll' | 'watch' = 'watch'): void {
     if (mode === 'watch') {
       this.startWatchMode(intervalMs)
     } else {
       this.startPollMode(intervalMs)  // existing behavior, renamed
     }
   }
   ```

3. **New method: `startWatchMode(fallbackIntervalMs: number)`**
   ```typescript
   private startWatchMode(fallbackIntervalMs: number): void {
     const dirs = getLogSearchDirs()

     this.logWatcher = new LogWatcher({
       dirs,
       debounceMs: 2000,
       maxWaitMs: 5000,
       onBatch: (paths) => void this.pollChanged(paths),
     })
     this.logWatcher.start()

     // Safety net: full poll at 60s interval
     this.interval = setInterval(() => {
       void this.pollOnce()
     }, Math.max(fallbackIntervalMs, 60_000))

     // Still do initial poll + orphan rematch
     void this.pollOnce().then(() => {
       if (this.orphanRematchPending) {
         this.orphanRematchPromise = this.runOrphanRematchInBackground()
       }
     })
   }
   ```

4. **Modify `stop()`** to clean up watcher:
   ```typescript
   stop(): void {
     if (this.interval) clearInterval(this.interval)
     this.interval = null
     this.logWatcher?.stop()
     this.logWatcher = null
     this.matchWorker?.dispose()
   }
   ```

### Step 4: Add `pollChanged()` method

This is the key optimization — skip the full directory scan when we already know which files changed.

```typescript
async pollChanged(changedPaths: string[]): Promise<void> {
  if (this.pollInFlight) return
  this.pollInFlight = true

  try {
    const windows = this.registry.getAll()
    const knownByPath = this.buildKnownByPathMap()

    // Build log entries only for the changed files (skip full dir scan)
    const entries: LogEntrySnapshot[] = []
    for (const logPath of changedPaths) {
      // Stat the file
      // Extract metadata if unknown
      // Same logic as collectLogEntryBatch but for specific files
    }

    // Rest is same as pollOnce(): match worker, DB updates, etc.
    ...
  } finally {
    this.pollInFlight = false
  }
}
```

### Step 5: Config changes

In `src/server/config.ts`:

```typescript
// New: watch mode toggle (env override to force polling)
const logWatchMode = process.env.AGENTBOARD_LOG_WATCH === 'false' ? 'poll' : 'watch'

// Rename existing interval to be the fallback interval in watch mode
const logPollFallbackMs = 60_000  // 60s safety net in watch mode
```

### Step 6: Wire up in `src/server/index.ts`

```typescript
if (config.logPollIntervalMs > 0) {
  logPoller.start(config.logPollIntervalMs, config.logWatchMode)
}
```

### Step 7: Update `logDiscovery.ts`

Add a targeted function for building entries from specific paths (used by `pollChanged`):

```typescript
export function buildLogEntryFromPath(logPath: string): LogEntrySnapshot | null {
  // Stat + extract metadata for a single known path
  // Reuses existing extractSessionId, extractProjectPath, etc.
}
```

## Migration Safety

### Fallback behavior
- `AGENTBOARD_LOG_WATCH=false` forces pure polling mode (existing behavior)
- 60s fallback poll catches anything the watcher misses
- All existing caches (emptyLogCache, rematchAttemptCache) remain unchanged

### What stays the same
- `pollOnce()` — unchanged, still used for fallback and initial scan
- Match worker architecture — unchanged
- Orphan rematch — unchanged
- All DB operations — unchanged
- Session refresh loop (every 2s) — unchanged, independent of log polling

### What changes
- Primary trigger: `setInterval(5s)` → chokidar file events + debounce
- Full dir scans: every 5s → every 60s (fallback only)
- New dependency: `chokidar@4`
- New file: `src/server/logWatcher.ts`

## Testing Plan

1. **Unit tests for LogWatcher debounce logic**
   - Verify debounce timer resets on new events
   - Verify max-wait forces flush
   - Verify `.jsonl` filter works
   - Verify batch deduplication (same path multiple events)

2. **Integration: watch mode detects new agent session**
   - Start agentboard in watch mode
   - Create a fake `.jsonl` in `~/.claude/projects/test/`
   - Verify session appears within ~2-3s (debounce)

3. **Integration: fallback poll catches missed events**
   - Start agentboard, then add a log file via a method that bypasses fs events (e.g., `mv` from outside watched tree)
   - Verify it's picked up within 60s

4. **Regression: existing polling mode still works**
   - Set `AGENTBOARD_LOG_WATCH=false`
   - Verify identical behavior to current

5. **Platform: verify on macOS (primary) and Linux (CI)**

## Risks

| Risk | Mitigation |
|---|---|
| chokidar misses events on edge cases | 60s fallback poll catches everything |
| Linux inotify watch limit on huge log dirs | Log dirs are typically small; can add `usePolling: true` fallback |
| Extra dependency | chokidar v4 is 1 dep, pure JS, widely used |
| Race between watcher and fallback poll | Existing `pollInFlight` guard prevents concurrent polls |
