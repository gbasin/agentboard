# Log Watcher Migration: setInterval Polling → Chokidar File Watching

Replace the current `setInterval`-based log polling with event-driven file watching using chokidar v4.

## Goals

1. Reduce idle CPU usage by eliminating frequent directory scans when no agents are active.
2. Reduce log change detection latency from 2–5s polling to near-instant via file events.
3. Maintain functional parity with existing polling behavior via a 60s fallback scan.

## Non-Goals

1. No changes to log parsing, match logic, session DB schema, or UI behavior.
2. No changes to log file formats or agent-side logging.
3. No support for remote or networked file watching.
4. No changes to the session refresh loop (2s tmux pane capture) — it is independent of log polling.

## Problem

The current `LogPoller` runs `pollOnce()` every 2-5 seconds regardless of whether any log files have changed. Each cycle:
1. Synchronously scans 3 directory trees (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`)
2. Stats all `.jsonl` files, sorts by mtime, takes top 25
3. Reads unknown files to extract metadata
4. Sends a request to the match worker (Bun `Worker`), which internally runs `collectLogEntryBatch()` → `scanAllLogDirs()` and then ripgrep matching

This wastes CPU when no agents are running and adds 2-5s latency for detecting new activity.

## Solution

Use [chokidar v4](https://github.com/paulmillr/chokidar) to watch log directories for `.jsonl` file changes, with cass-style debouncing. Keep a slow fallback poll as a safety net.

### Why chokidar v4
- 1 runtime dependency (`readdirp`), ESM/CJS dual
- macOS: Uses `fsevents` (optional native dep) — recursive, efficient
- Linux: Manages per-directory inotify watchers automatically
- Windows: Uses ReadDirectoryChangesW
- v4 dropped from 13 deps to 1

> **Note:** chokidar v4 uses `fsevents` as an optional native dependency on macOS. This must be tested with Bun's compiled binary pipeline before merging (see [Pre-merge Checklist](#pre-merge-checklist)).

### Prior art: cass (coding_agent_session_search)
cass uses the Rust `notify` crate (same concept) with a 2s debounce + 5s max-wait pattern in `src/indexer/mod.rs:1319-1441`. Their architecture validated that file watching + debouncing works well for agent log directories.

## Architecture

### Current flow
```
setInterval(5000ms)
  → matchWorker.poll(request)
    → [worker] collectLogEntryBatch()  // scanAllLogDirs() + stat + sort + enrich
    → [worker] matchWindowsToLogsByExactRg()
  → [main] DB updates from response
```

### New flow
```
chokidar.watch(parentDirs, { filter })
  → on 'add'/'change' → debouncer.push(path)
  → debouncer fires (2s quiet / 5s max-wait)
    → matchWorker.poll({ preFilteredPaths })  // worker skips scanAllLogDirs, enriches only these
    → DB updates

fallback setInterval(60000ms)  // safety net, catches missed events
  → matchWorker.poll()          // full scan, same as today
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
import { logger } from './logger'

interface LogWatcherOptions {
  /** Directories to watch recursively */
  dirs: string[]
  /** Max recursive depth per watched directory */
  depth: number
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private firstEventTime: number | null = null
  private options: Required<LogWatcherOptions>

  constructor(options: LogWatcherOptions) {
    this.options = {
      debounceMs: 2000,
      maxWaitMs: 5000,
      ...options,
    }
  }

  start(): void {
    this.watcher = chokidar.watch(this.options.dirs, {
      persistent: true,
      ignoreInitial: true,
      depth: this.options.depth,
      followSymlinks: false,       // match existing scanDirForJsonl behavior
      ignored: '**/subagents/**',  // skip subagent logs (existing behavior)
      // Use chokidar v4 filter fn for .jsonl-only watching.
      // Must return true for directories so chokidar can descend into them.
      // The broken regex approaches (dotfile filter, lookbehind) are avoided —
      // they would filter out the .claude/.codex/.pi root dirs and block traversal.
      filter: (filePath: string, stats?: { isFile(): boolean }) =>
        stats?.isFile() ? filePath.endsWith('.jsonl') : true,
      usePolling: false,
    })

    this.watcher
      .on('add', (filePath) => this.handleEvent(filePath))
      .on('change', (filePath) => this.handleEvent(filePath))
      .on('error', (err) => {
        logger.warn({ err }, 'logWatcher error')
        // Note: chokidar continues watching after emitting errors.
        // If the watcher becomes fully non-functional, the 60s fallback poll
        // ensures we still detect changes (just with higher latency).
      })
  }

  private handleEvent(filePath: string): void {
    // Belt-and-suspenders: filter fn should already enforce this,
    // but guard against chokidar edge cases.
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
    try {
      this.options.onBatch(paths)
    } catch (err) {
      // Log but don't re-add paths — the 60s fallback poll will catch them.
      logger.warn({ err, pathCount: paths.length }, 'logWatcher onBatch error')
    }
  }

  stop(): void {
    this.flush()
    this.watcher?.close()
    this.watcher = null
  }
}
```

### Step 3: Extract per-file enrichment helper in `logPollData.ts`

The existing `collectLogEntryBatch()` does two things: (1) scan all directories, (2) enrich each file. We need to extract the per-file enrichment so it can be reused by the new pre-filtered path.

```typescript
// New: shared per-file enrichment (extracted from collectLogEntryBatch's inner loop)
export function enrichLogEntry(
  logPath: string,
  mtime: number,
  birthtime: number,
  size: number,
  knownByPath: Map<string, KnownSession>
): LogEntrySnapshot {
  const known = knownByPath.get(logPath)
  if (known) {
    // Use cached metadata from DB, skip file content reads
    const codexExec = known.agentType === 'codex' && !known.isCodexExec
      ? isCodexExec(logPath)
      : known.isCodexExec
    return {
      logPath, mtime, birthtime, size,
      sessionId: known.sessionId,
      projectPath: known.projectPath,
      agentType: known.agentType,
      isCodexSubagent: false,
      isCodexExec: codexExec,
      logTokenCount: -1,  // already validated
    }
  }

  // Unknown log — full enrichment
  const agentType = inferAgentTypeFromPath(logPath)
  const sessionId = extractSessionId(logPath)
  const projectPath = extractProjectPath(logPath)
  const codexSubagent = agentType === 'codex' ? isCodexSubagent(logPath) : false
  const codexExec = agentType === 'codex' ? isCodexExec(logPath) : false
  const shouldCountTokens = Boolean(sessionId) && !codexSubagent && Boolean(agentType)
  const logTokenCount = shouldCountTokens ? getLogTokenCount(logPath) : 0

  return {
    logPath, mtime, birthtime, size,
    sessionId, projectPath,
    agentType: agentType ?? null,
    isCodexSubagent: codexSubagent,
    isCodexExec: codexExec,
    logTokenCount,
  }
}

// Refactored: collectLogEntryBatch now uses enrichLogEntry internally
export function collectLogEntryBatch(maxLogs: number, options: CollectLogEntryBatchOptions = {}): LogEntryBatch {
  const { knownSessions = [] } = options
  const knownByPath = new Map(knownSessions.map((s) => [s.logFilePath, s]))

  const scanStart = performance.now()
  const logPaths = scanAllLogDirs()
  const scanMs = performance.now() - scanStart

  // ... stat + sort + slice (unchanged) ...

  const entries = limited.map((entry) =>
    enrichLogEntry(entry.logPath, entry.mtime, entry.birthtime, entry.size, knownByPath)
  )

  return { entries, scanMs, sortMs }
}

// New: build entries from specific paths (no dir scan)
export function collectLogEntriesForPaths(
  logPaths: string[],
  knownSessions: KnownSession[] = []
): LogEntrySnapshot[] {
  const knownByPath = new Map(knownSessions.map((s) => [s.logFilePath, s]))
  const entries: LogEntrySnapshot[] = []

  for (const logPath of logPaths) {
    const times = getLogTimes(logPath)
    if (!times) continue  // file may have been deleted between event and processing
    entries.push(enrichLogEntry(
      logPath, times.mtime.getTime(), times.birthtime.getTime(), times.size, knownByPath
    ))
  }

  return entries
}
```

### Step 4: Extend `MatchWorkerRequest` for pre-filtered paths

In `logMatchWorkerTypes.ts`, add a new optional field:

```typescript
export interface MatchWorkerRequest {
  // ... existing fields ...

  /**
   * Pre-filtered paths from the file watcher. When set, the worker skips
   * scanAllLogDirs() and builds entries from only these paths.
   * Falls back to full scan when undefined/empty.
   */
  preFilteredPaths?: string[]
}
```

In `logMatchWorker.ts`, use it:

```typescript
export function handleMatchWorkerRequest(payload: MatchWorkerRequest): MatchWorkerResponse {
  let entries: LogEntrySnapshot[]
  let scanMs = 0
  let sortMs = 0

  if (payload.preFilteredPaths && payload.preFilteredPaths.length > 0) {
    // Validate: only allow paths under configured log roots
    const logRoots = getLogSearchDirs()
    const validPaths = payload.preFilteredPaths.filter((p) =>
      p.endsWith('.jsonl') && logRoots.some((root) => p.startsWith(root))
    )

    // Watch mode: skip full scan, enrich only the changed files
    entries = collectLogEntriesForPaths(
      validPaths,
      payload.knownSessions
    )
  } else {
    // Poll mode / fallback: full scan (existing behavior)
    const batch = collectLogEntryBatch(payload.maxLogsPerPoll, {
      knownSessions: payload.knownSessions,
    })
    entries = batch.entries
    scanMs = batch.scanMs
    sortMs = batch.sortMs
  }

  // ... rest unchanged: matching, orphan handling, etc. ...
}
```

### Step 5: Modify `LogPoller` to support event-driven mode

Changes to `src/server/logPoller.ts`:

1. **New property + import:**
   ```typescript
   import { LogWatcher } from './logWatcher'

   // Inside the class:
   private logWatcher: LogWatcher | null = null
   ```

2. **Modify `start()`** to accept an optional mode (backwards-compatible):
   ```typescript
   start(intervalMs = DEFAULT_INTERVAL_MS, mode: 'poll' | 'watch' = 'poll'): void {
     if (this.interval) return
     if (intervalMs <= 0) return

     if (mode === 'watch') {
       this.startWatchMode(intervalMs)
     } else {
       this.startPollMode(intervalMs)
     }
   }

   private startPollMode(intervalMs: number): void {
     // Existing start() body, unchanged
     const safeInterval = Math.max(MIN_INTERVAL_MS, intervalMs)
     this.interval = setInterval(() => {
       void this.pollOnce()
     }, safeInterval)
     void this.pollOnce().then(() => {
       if (this.orphanRematchPending && !this.orphanRematchInProgress) {
         this.orphanRematchPromise = this.runOrphanRematchInBackground()
       }
     })
   }
   ```

3. **New method: `startWatchMode(fallbackIntervalMs: number)`**
   ```typescript
   private startWatchMode(fallbackIntervalMs: number): void {
     // Watch parent dirs so we detect newly-created agent log directories.
     // e.g., watch ~/.claude/ (depth 4) instead of ~/.claude/projects/ (depth 3)
     // so that if ~/.codex/sessions/ doesn't exist at startup, we still see it
     // when a user first runs Codex.
     const watchDirs = getLogWatchParentDirs()  // new helper, see Step 8

     this.logWatcher = new LogWatcher({
       dirs: watchDirs,
       depth: 5,  // one deeper than max agent depth (4) since we watch parents
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
       if (this.orphanRematchPending && !this.orphanRematchInProgress) {
         this.orphanRematchPromise = this.runOrphanRematchInBackground()
       }
     })
   }
   ```

4. **New method: `pollChanged(changedPaths: string[])`**
   ```typescript
   async pollChanged(changedPaths: string[]): Promise<void> {
     if (this.pollInFlight) return  // watcher-triggered poll is lower priority
     this.pollInFlight = true

     try {
       if (!this.matchWorker) return

       const windows = this.registry.getAll()
       const logDirs = getLogSearchDirs()
       const sessionRecords = [
         ...this.db.getActiveSessions(),
         ...this.db.getInactiveSessions(),
       ]
       const sessions: SessionSnapshot[] = sessionRecords.map((session) => ({
         sessionId: session.sessionId,
         logFilePath: session.logFilePath,
         currentWindow: session.currentWindow,
         lastActivityAt: session.lastActivityAt,
         lastUserMessage: session.lastUserMessage,
         lastKnownLogSize: session.lastKnownLogSize,
       }))
       const knownSessions: KnownSession[] = sessionRecords
         .filter((session) => session.logFilePath)
         .map((session) => ({
           logFilePath: session.logFilePath,
           sessionId: session.sessionId,
           projectPath: session.projectPath ?? null,
           agentType: session.agentType ?? null,
           isCodexExec: session.isCodexExec,
         }))

       const response = await this.matchWorker.poll({
         windows,
         logDirs,
         maxLogsPerPoll: this.maxLogsPerPoll,
         sessions,
         knownSessions,
         scrollbackLines: DEFAULT_SCROLLBACK_LINES,
         minTokensForMatch: MIN_LOG_TOKENS_FOR_INSERT,
         forceOrphanRematch: false,
         orphanCandidates: [],
         lastMessageCandidates: [],
         skipMatchingPatterns: config.skipMatchingPatterns,
         preFilteredPaths: changedPaths,  // <-- the key difference from pollOnce
         search: {
           rgThreads: this.rgThreads,
         },
       })

       // See Step 5b — shared response processing
       this.processMatchResponse(response, windows, sessionRecords)
     } catch (error) {
       logger.warn('log_poll_changed_error', {
         message: error instanceof Error ? error.message : String(error),
         pathCount: changedPaths.length,
       })
     } finally {
       this.pollInFlight = false
     }
   }
   ```

### Step 5b: Extract `processMatchResponse()` from `pollOnce()`

The entry-processing loop in `pollOnce()` (~200 lines, starting after the `matchWorker.poll()` call) handles DB inserts/updates, rematch logic, display name generation, and orphan processing. This must be extracted into a shared method so both `pollOnce()` and `pollChanged()` can use it without duplication.

```typescript
private processMatchResponse(
  response: MatchWorkerResponse,
  windows: Session[],
  sessionRecords: SessionRecord[]
): PollStats {
  // Contains the existing entry-processing loop from pollOnce():
  // - Build exactWindowMatches from response.matches
  // - Iterate response.entries + orphanEntries
  // - For each entry: check existing by logPath, existing by sessionId, or insert new
  // - Handle rematch attempts for orphaned sessions
  // - Apply applyLogEntryToExistingRecord for updates
  // - Generate unique display names
  // - Fire onSessionActivated / onSessionOrphaned callbacks
}
```

After extraction, `pollOnce()` calls `this.processMatchResponse(response, windows, sessionRecords)` in place of the inline loop, and `pollChanged()` does the same.

5. **Modify `stop()`** to clean up watcher:
   ```typescript
   stop(): void {
     if (this.interval) clearInterval(this.interval)
     this.interval = null
     this.logWatcher?.stop()
     this.logWatcher = null
     this.matchWorker?.dispose()
     this.matchWorker = null
   }
   ```

### Step 6: Config changes

In `src/server/config.ts`:

```typescript
// Watch mode: 'watch' (default, chokidar) or 'poll' (existing setInterval behavior)
const logWatchModeRaw = process.env.AGENTBOARD_LOG_WATCH_MODE
const logWatchMode: 'watch' | 'poll' =
  logWatchModeRaw === 'poll' ? 'poll' : 'watch'

export const config = {
  // ... existing fields ...
  logWatchMode,
}
```

### Step 7: Wire up in `src/server/index.ts`

```typescript
if (config.logPollIntervalMs > 0) {
  logPoller.start(config.logPollIntervalMs, config.logWatchMode)
}
```

### Step 8: Add `getLogWatchParentDirs()` in `logDiscovery.ts`

Watch parent directories so we detect newly-created subdirectories (e.g., `~/.codex/sessions/` appearing when Codex is first used):

```typescript
export function getLogWatchParentDirs(): string[] {
  return [
    getClaudeConfigDir(),   // ~/.claude/     (projects/ may not exist yet)
    getCodexHomeDir(),      // ~/.codex/      (sessions/ may not exist yet)
    path.join(getPiHomeDir(), 'agent'),  // ~/.pi/agent/ (sessions/ may not exist yet)
  ]
}
```

## Migration Safety

### Fallback behavior
- `AGENTBOARD_LOG_WATCH_MODE=poll` forces pure polling mode (existing behavior, unchanged)
- 60s fallback poll catches anything the watcher misses
- All existing caches (emptyLogCache, rematchAttemptCache) remain unchanged

### What stays the same
- `pollOnce()` — unchanged, still used for fallback and initial scan
- Match worker architecture — unchanged (extended with `preFilteredPaths`, backwards-compatible)
- Orphan rematch — unchanged
- All DB operations — unchanged
- Session refresh loop (every 2s) — unchanged, independent of log polling

### What changes
- Primary trigger: `setInterval(5s)` → chokidar file events + debounce
- Full dir scans: every 5s → every 60s (fallback only)
- New dependency: `chokidar@4`
- New file: `src/server/logWatcher.ts`
- Modified: `logPollData.ts` (extracted `enrichLogEntry`, added `collectLogEntriesForPaths`)
- Modified: `logMatchWorkerTypes.ts` (added `preFilteredPaths` field)
- Modified: `logMatchWorker.ts` (pre-filtered path branch)
- Modified: `logPoller.ts` (watch mode, `pollChanged`, extracted `processMatchResponse`)
- Modified: `logDiscovery.ts` (added `getLogWatchParentDirs`)
- Modified: `config.ts` (added `logWatchMode`)
- Modified: `index.ts` (pass watch mode to `logPoller.start`)

### Known limitations

- **`pollInFlight` drops watcher polls:** If a watcher-triggered `pollChanged()` overlaps with a fallback `pollOnce()`, the later call is silently dropped. This is acceptable — the watcher already processed recent changes, and the next fallback fires in 60s. The alternative (queueing) adds complexity for minimal benefit.
- **Deleted log files:** The watcher doesn't listen for `unlink` events. If a log file is deleted (e.g., Claude Code cleanup), detection relies on the fallback poll + DB reconciliation. This matches existing behavior since the poller also doesn't actively track deletions.

## Testing Plan

### Unit tests: LogWatcher (`src/server/__tests__/logWatcher.test.ts`)

1. **Debounce timer resets on new events**
   - Emit events at 500ms intervals, verify single batch fires after last + 2s
2. **Max-wait forces flush**
   - Emit events continuously for 6s, verify flush at 5s mark (not waiting for quiet period)
3. **Batch deduplication**
   - Same path emitted multiple times → appears once in batch
4. **Filter function correctness**
   - `.jsonl` files pass filter → trigger events
   - `.json`, `.log`, `.txt` files → no events
   - Directories always pass → watcher can descend
5. **Non-existent watched directories**
   - Pass a dir that doesn't exist → watcher starts without error
   - Create the dir + add a .jsonl file → event fires
6. **onBatch error handling**
   - onBatch throws → watcher continues, error logged, not re-thrown
7. **Rapid-fire events (load test)**
   - Emit 1000 events in 100ms → single batch, no memory leak, pending set bounded
8. **stop() flushes pending**
   - Events queued but not yet flushed → calling stop() fires them before closing

### Unit tests: enrichLogEntry (`src/server/__tests__/logPollData.test.ts`)

9. **Known session fast path**
   - Known session → returns cached metadata, logTokenCount = -1
10. **Unknown session full enrichment**
    - New log → extracts sessionId, projectPath, agentType, token count
11. **Codex subagent/exec detection**
    - Subagent log → isCodexSubagent = true
    - Exec log → isCodexExec = true

### Unit tests: Worker pre-filtered path (`src/server/__tests__/logMatchWorker.test.ts`)

12. **preFilteredPaths set → skips scanAllLogDirs**
    - Mock scanAllLogDirs, pass preFilteredPaths → scanAllLogDirs not called
13. **preFilteredPaths empty/undefined → full scan**
    - No preFilteredPaths → collectLogEntryBatch called as before

### Integration tests

14. **Watch mode detects new agent session**
    - Start agentboard in watch mode
    - Create a fake `.jsonl` in `~/.claude/projects/test/`
    - Verify session appears within ~2-3s (debounce)

15. **Fallback poll catches missed events**
    - Start agentboard, then `mv` a log file from outside watched tree
    - Verify it's picked up within 60s

16. **Watcher error recovery**
    - Force an error on the watcher (e.g., chmod watched dir to 000)
    - Verify fallback poll still works
    - Restore permissions → watcher resumes

17. **Regression: polling mode still works**
    - Set `AGENTBOARD_LOG_WATCH_MODE=poll`
    - Verify identical behavior to current

### Platform tests

18. **macOS: verify FSEvents path in compiled binary**
    - Build Bun compiled binary
    - Run the `logWatcher.test.ts` suite against it
    - Run with `DEBUG=chokidar:*` and verify output includes FSEvents initialization (not polling fallback)

19. **Linux: verify inotify path in CI**
    - Run integration tests in CI (Linux)
    - Verify events fire correctly

## Pre-merge Checklist

Before merging this change:

- [ ] **Bun compiled binary + chokidar + fsevents**: Build the agentboard binary on macOS ARM64 and x64. Verify chokidar resolves FSEvents correctly and events fire. If FSEvents doesn't work in compiled mode, evaluate:
  - Use `usePolling: true` as fallback for compiled builds
  - Or vendor/patch fsevents for Bun compatibility
- [ ] **Linux inotify limits**: Check `cat /proc/sys/fs/inotify/max_user_watches` on CI. Verify the parent-dir watching approach stays well under the limit for typical log directory sizes.
- [ ] **All unit + integration tests pass** on macOS and Linux
- [ ] **No regression in polling mode** (`AGENTBOARD_LOG_WATCH_MODE=poll`)

## Risks

| Risk | Mitigation |
|---|---|
| chokidar misses events on edge cases | 60s fallback poll catches everything |
| FSEvents doesn't work in compiled Bun binary | Pre-merge checklist requires testing; can fall back to `usePolling: true` |
| Linux inotify watch limit on huge log dirs | Watching parent dirs keeps count low; check limits in CI |
| Extra dependency | chokidar v4 is 1 runtime dep (`readdirp`), widely used |
| `pollInFlight` drops watcher-triggered polls | Acceptable — watcher already processed recent changes, fallback fires in 60s |
| Non-existent agent dirs at startup | Watching parent dirs ensures we see them created |
| Symlinks in log dirs | `followSymlinks: false` matches existing scanner behavior |
| Bun Worker + chokidar event loop interactions | chokidar runs in main thread (not the worker); worker is only used for matching |
