# Parallel Startup Verification: spawnSync → async Bun.spawn

Replace serial synchronous subprocess calls during server startup with parallel async spawns to reduce time-to-interactive from ~11s to ~3s.

## Problem

Server startup blocks for ~11 seconds before the HTTP server can respond. The startup timeline on a machine with 5 active sessions:

```
+0ms      terminal_mode_resolved
+126ms    startup_state (5 sessions, 5 windows discovered)
+7000ms   session_verification_name_fallback (blog-posts)    ← serial verification
+8700ms   session_verification_name_fallback (rare-track)    ← serial verification
+9000ms   resurrect_pinned_sessions_start
+9200ms   resurrect_pinned_session_success
+9500ms   log_watcher_started (66ms setup)
+10800ms  server_started (HTTP now accepts requests)
+11300ms  log_poll complete
+16200ms  orphan_rematch_complete
```

The biggest bottleneck is **session verification** (~7s for 5 sessions, ~1.4s each). Each `verifyWindowLogAssociationDetailed()` call runs serially in a `for` loop and makes multiple `spawnSync` calls:

1. `tmux capture-pane` — capture terminal scrollback (~50ms)
2. `tmux capture-pane -e` — fallback ANSI capture if no prompts found (~50ms)
3. `rg -l` — ripgrep search across log dirs per user message (~200-500ms each, 2-5 messages)
4. `rg --json` — tiebreaker scoring (~200ms per tied candidate)

Total: ~1.4s per session × 5 sessions = **~7s blocked on the main thread**.

## Goals

1. Parallelize startup session verification: 5 sessions verified concurrently in ~1.5s instead of ~7s serial.
2. Move HTTP server startup **before** verification so the UI can connect immediately.
3. No changes to verification logic, match accuracy, or log polling behavior.

## Non-Goals

1. No conversion of `SessionManager.runTmux()` — it's used broadly and is fast per call.
2. No concurrency limiter — 5-15 concurrent tmux/rg processes is well within OS limits.
3. No changes to worker threads — they stay synchronous (see "Why workers stay sync" below).
4. No async conversion of `spawnSync` callers outside `logMatcher.ts` (e.g., `SessionManager`, `index.ts` tmux helpers). Only logMatcher spawn functions change.

## Approach: Spawn strategy pattern + startup Promise.all

### Why not worker threads?

Session verification is **I/O-bound** (waiting on tmux server + ripgrep disk I/O), not CPU-bound. Async `Bun.spawn` with `Promise.all` gives true parallelism at the OS process level without the overhead of worker thread creation or message serialization.

### Why Bun.spawn over child_process.spawn?

- Native Bun API, uses `posix_spawn(3)` — ~60% faster process creation than Node.js `child_process`
- Stdout is a `ReadableStream` consumed via `new Response(proc.stdout).text()`
- Supports `timeout` option natively for safety

### Why workers stay sync

Bun worker threads process messages **sequentially** — even with an async `onmessage` handler, the next message isn't dispatched until the previous handler returns (confirmed via Bun's `MessagePort::dispatchMessages` in C++). Making workers async gives zero concurrency benefit within a single worker.

Workers exist to move I/O-heavy work off the main thread. With `Bun.spawnSync` inside a worker, the worker thread blocks but the main thread stays responsive for HTTP/WebSocket handling. This is the correct design and doesn't need changing.

**Important:** `sessionRefreshWorker.ts` maintains a module-level `paneContentCache` map that tracks status transitions across messages. This cache requires sequential message processing to function correctly. Bun guarantees this today, but the constraint should be documented in the code.

### Why spawn strategy pattern (not full duplication)?

Workers need sync spawns; startup needs async spawns. Rather than duplicating all 11 functions, the core logic accepts a `SpawnFn` parameter:

```typescript
// Spawn strategy type
type SpawnResult = { stdout: string; exitCode: number }
type SpawnFn = (cmd: string[], opts?: SpawnOpts) => SpawnResult | Promise<SpawnResult>

// Core function accepts either strategy
function getTerminalScrollbackWith(
  spawn: SpawnFn, tmuxWindow: string, lines: number
): ReturnType<SpawnFn> { ... }

// Thin wrappers
function getTerminalScrollback(w: string, l: number) {
  return getTerminalScrollbackWith(spawnSync, w, l)  // sync for workers
}
async function getTerminalScrollbackAsync(w: string, l: number) {
  return getTerminalScrollbackWith(spawnAsync, w, l)  // async for startup
}
```

This keeps one implementation of the parsing/scoring logic with ~100 LOC of wrapper overhead instead of ~300 LOC of full duplication.

### Architecture: Separate verification from hydration

Create a standalone `verifyAllSessions()` async function. The existing `hydrateSessionsWithAgentSessions` gains a `precomputedVerifications?` parameter — when provided, it uses the map instead of calling verification inline.

This cleanly separates concerns:
- `verifyAllSessions()` — pure I/O, parallelizable, no side effects
- `hydrateSessionsWithAgentSessions()` — state mutations, broadcasts, sequential

```typescript
interface VerificationDecision {
  verification: WindowLogVerificationResult
  nameMatches: boolean
  windowExists: boolean
}

// Standalone async verification — returns raw results + metadata
async function verifyAllSessions(
  activeSessions: AgentSession[],
  sessions: Session[],    // for name matching + windowSet
  logDirs: string[]
): Promise<Map<string, VerificationDecision>> {
  const windowSet = new Set(sessions.map(s => s.tmuxWindow))
  const allLogPaths = activeSessions
    .filter(s => s.currentWindow)
    .map(s => ({ sessionId: s.sessionId, logPath: s.logFilePath }))

  const results = new Map<string, VerificationDecision>()
  await Promise.all(
    activeSessions.map(async (session) => {
      const windowExists = Boolean(session.currentWindow && windowSet.has(session.currentWindow))
      if (!windowExists) {
        results.set(session.sessionId, {
          verification: { status: 'inconclusive', bestMatch: null, reason: 'no_match' },
          nameMatches: false,
          windowExists: false,
        })
        return
      }

      // Exclude other sessions' logs to prevent cross-session pollution
      const excludeLogPaths = allLogPaths
        .filter(p => p.sessionId !== session.sessionId)
        .map(p => p.logPath)

      try {
        const verification = await verifyWindowLogAssociationDetailedAsync(
          session.currentWindow, session.logFilePath, logDirs,
          {
            context: { agentType: session.agentType, projectPath: session.projectPath },
            excludeLogPaths,
          }
        )
        const window = sessions.find(s => s.tmuxWindow === session.currentWindow)
        const nameMatches = Boolean(window && window.name === session.displayName)
        results.set(session.sessionId, { verification, nameMatches, windowExists: true })
      } catch (error) {
        logger.warn('session_verification_error', {
          sessionId: session.sessionId, error: String(error),
        })
        // Keep current association on error/timeout
        results.set(session.sessionId, {
          verification: { status: 'verified', bestMatch: null },
          nameMatches: true,
          windowExists: true,
        })
      }
    })
  )
  return results
}

// Caller applies orphan/keep decision using raw results
const verifications = await verifyAllSessions(activeSessions, sessions, logDirs)
const hydrated = hydrateSessionsWithAgentSessions(sessions, {
  verifyAssociations: true,
  precomputedVerifications: verifications,
})
```

## Scope of Changes

### Phase 1: Spawn strategy + async wrappers in logMatcher.ts

Add a spawn strategy abstraction and async versions of all subprocess-calling functions. Sync versions are retained for worker thread callers.

**Direct spawn callers (5 functions):**

| Function | Change |
|----------|--------|
| `getTerminalScrollback` | Add `*Async` version using `Bun.spawn`. Core logic shared via spawn strategy. |
| `getTerminalScrollbackWithAnsi` | Same pattern. |
| `findLogsWithExactMessage` | Same pattern. |
| `findLogsWithExactMessageInPaths` | Same pattern. |
| `getRgMatchLines` | Same pattern. |

**Transitive callers (6 functions — must also get async versions):**

| Function | Why |
|----------|-----|
| `scoreOrderedMessageMatchesWithRg` | Calls `getRgMatchLines` |
| `scoreOrderedMessageMatches` | Calls `scoreOrderedMessageMatchesWithRg` |
| `tryExactMatchWindowToLog` | Calls `getTerminalScrollback`, `getTerminalScrollbackWithAnsi`, `findLogsWithExactMessage`, `scoreOrderedMessageMatches` |
| `matchWindowsToLogsByExactRg` | Calls `tryExactMatchWindowToLog` (exported, used by `logMatchWorker`) |
| `verifyWindowLogAssociation` | Calls `tryExactMatchWindowToLog` (exported) |
| `verifyWindowLogAssociationDetailed` | Calls `tryExactMatchWindowToLog` |

**Total: 11 functions** get async versions. Sync originals are kept for worker callers.

### Phase 2: Startup reorder + parallel verification

**New `verifyAllSessions()` function in index.ts:**
- Standalone async function, runs `Promise.all` over all active sessions
- Returns `Map<sessionId, VerificationDecision>` with raw results + metadata
- Pre-computes `excludeLogPaths` per session and `windowSet` before the parallel loop
- Per-session try/catch — one failure doesn't block others
- On error/timeout: returns `{ status: 'verified' }` (keep current association)

**`hydrateSessionsWithAgentSessions` modification:**
- New optional param: `precomputedVerifications?: Map<string, VerificationDecision>`
- When provided, reads `verification`, `nameMatches`, `windowExists` from the map
- Applies the same orphan/keep/name-fallback decision logic as today
- All side effects (DB updates, broadcasts) remain here

Current startup order:
```
1. checkPortAvailable + ensureTmux + pruneOrphaned    (~200ms)
2. DB init + manager setup                             (~50ms)
3. refreshSessionsSync({ verifyAssociations: true })   (~7000ms) <- BLOCKS HTTP
4. resurrectPinnedSessions()                           (~300ms)
5. refreshSessionsSync()                               (~200ms)
6. logPoller.start()                                   (~100ms)
7. Bun.serve()                                         (~50ms)  <- HTTP ready
```

New startup order:
```
1. checkPortAvailable + ensureTmux + pruneOrphaned     (~200ms)
2. DB init + manager setup                              (~50ms)
3. refreshSessionsSync() (no verification)              (~200ms)  <- sessions from DB
4. Bun.serve()                                          (~50ms)  <- HTTP ready immediately
5. logPoller.start()                                    (~100ms)
6. await verifyAllSessions() + hydrate with results     (~1500ms) <- async, parallel
7. resurrectPinnedSessions()                            (~300ms)
8. refreshSessionsSync()                                (~200ms)
```

The UI can connect and see sessions at **~500ms** (from DB state). Verification runs in the background and broadcasts updates if any sessions get orphaned.

### Error handling

Per-session try/catch inside `Promise.all`. On any error (including timeout), **keep the current association** — benefit of the doubt. Only orphan on definitive mismatch:

```typescript
const results = await Promise.all(
  sessionsToVerify.map(async (session) => {
    try {
      return { session, result: await verifyWindowLogAssociationDetailedAsync(...) }
    } catch (error) {
      logger.warn('session_verification_error', { sessionId: session.sessionId, error: String(error) })
      // Keep current association — timeout/error should not orphan a session
      return { session, result: { status: 'verified' as const, bestMatch: null } }
    }
  })
)
```

### Timeouts

Per-subprocess timeouts prevent hung processes from blocking startup:

| Command | Timeout |
|---------|---------|
| `tmux capture-pane` | 5s (matches existing copy-mode timeout) |
| `rg -l` / `rg --json` | 10s (large log directories) |

No per-session or global deadline needed — per-subprocess timeouts cap the worst case. `Promise.all` waits for all sessions but each is individually time-bounded.

## Race conditions considered and accepted

1. **UI flicker**: UI connects before verification finishes, shows sessions that may later be orphaned. Accepted — the UI already handles runtime orphaning gracefully. Sessions can be orphaned at any time during normal operation.

2. **Log poller overlap**: `logPoller.start()` runs before verification completes. The poller may fire during async verification, causing duplicate tmux captures. Accepted — both are read-only operations, the ~1.5s overlap is harmless and slightly wasteful at worst.

3. **Periodic refresh overlap**: `setInterval(refreshSessions, ...)` could fire during verification. Accepted — same reasoning as log poller overlap, read-only operations.

4. **Resurrection ordering**: `resurrectPinnedSessions` runs after verification, same as today. Claude/Codex reuse the same JSONL log file on `--resume`, so the log path in DB stays valid after resurrection. No stale association issue.

## Files Changed

| File | Type | Description |
|------|------|-------------|
| `src/server/logMatcher.ts` | Modified | Add spawn strategy abstraction. Add async versions of 11 functions (5 direct spawn callers + 6 transitive). Keep sync originals for workers. |
| `src/server/index.ts` | Modified | Add `verifyAllSessions()`, add `precomputedVerifications` param to `hydrateSessionsWithAgentSessions`, restructure startup order, move `Bun.serve()` before verification |
| `src/server/__tests__/logMatcher.test.ts` | Modified | Add tests for async verification functions. Update spawn mocks (`Bun.spawnSync` mock → `Bun.spawn` mock returning subprocess-like objects with `.exited` Promise and `.stdout` ReadableStream). |
| `src/server/__tests__/index.test.ts` | Modified | Update startup sequence tests |

**Not changed:**
| File | Why |
|------|-----|
| `src/server/logMatchWorker.ts` | Stays sync — calls sync logMatcher functions, processes messages sequentially |
| `src/server/sessionRefreshWorker.ts` | Stays sync — calls sync logMatcher functions, `paneContentCache` requires sequential access |
| `src/server/SessionManager.ts` | `runTmux()` stays `spawnSync` — fast, broadly used, not a bottleneck |

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Time to HTTP ready | ~10.8s | ~0.5s |
| Time to verified sessions | ~10.8s | ~2.0s |
| Total startup (incl. orphan rematch) | ~16.2s | ~7.0s |

The biggest win is HTTP-ready time: the UI loads almost instantly instead of waiting 11 seconds.

## Pre-merge Checklist

- [ ] All 532+ tests pass
- [ ] `bun run lint && bun run typecheck` clean
- [ ] Manual test: start server with 5+ active sessions, verify HTTP responds in <2s
- [ ] Manual test: verify orphaned sessions are correctly detected after async verification
- [ ] Manual test: UI shows sessions immediately, then updates if verification orphans any
- [ ] Startup log shows parallel verification completing in ~1.5s
- [ ] Sync logMatcher functions still work in worker threads (existing behavior unchanged)
