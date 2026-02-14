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

## Approach: Full async Bun.spawn conversion

### Why not worker threads?

Session verification is **I/O-bound** (waiting on tmux server + ripgrep disk I/O), not CPU-bound. Async `Bun.spawn` with `Promise.all` gives true parallelism at the OS process level without the overhead of worker thread creation or message serialization.

### Why Bun.spawn over child_process.spawn?

- Native Bun API, uses `posix_spawn(3)` — ~60% faster process creation than Node.js `child_process`
- Stdout is a `ReadableStream` consumed via `new Response(proc.stdout).text()`
- Supports `timeout` option natively for safety

### Why full async (not sync+async duplication)?

**Decision:** Convert all `Bun.spawnSync` calls in logMatcher.ts to `Bun.spawn` — no sync copies retained. The worker threads (`logMatchWorker.ts`, `sessionRefreshWorker.ts`) also convert to async. This eliminates ~300 LOC of duplication that would otherwise drift over time.

Workers will allow concurrent message processing since operations target independent sessions and are read-only (tmux captures + ripgrep searches).

### Architecture: Separate verification from hydration

**Decision:** Create a standalone `verifyAllSessions()` async function that returns `Map<sessionId, VerificationResult>`. The existing `hydrateSessionsWithAgentSessions` gains a `precomputedVerifications?: Map` parameter — when provided, it uses the map instead of calling verification inline.

This cleanly separates concerns:
- `verifyAllSessions()` — pure I/O, parallelizable, no side effects
- `hydrateSessionsWithAgentSessions()` — state mutations, broadcasts, sequential

```typescript
// New standalone verification function
async function verifyAllSessions(
  sessions: AgentSession[],
  logDirs: string[]
): Promise<Map<string, WindowLogVerificationResult>> {
  const results = new Map()
  await Promise.all(
    sessions.map(async (session) => {
      try {
        const result = await verifyWindowLogAssociationDetailed(
          session.currentWindow, session.logFilePath, logDirs, { ... }
        )
        results.set(session.sessionId, result)
      } catch (error) {
        logger.warn('session_verification_error', { sessionId: session.sessionId, error: String(error) })
        results.set(session.sessionId, { status: 'verified', bestMatch: null })
      }
    })
  )
  return results
}

// Existing hydration consumes pre-computed results
const verifications = await verifyAllSessions(activeSessions, logDirs)
const hydrated = hydrateSessionsWithAgentSessions(sessions, {
  verifyAssociations: true,
  precomputedVerifications: verifications,
})
```

## Scope of Changes

### Phase 1: Convert logMatcher.ts to async

Replace `Bun.spawnSync` with `Bun.spawn` in all subprocess-calling functions:

| Function | Change |
|----------|--------|
| `getTerminalScrollback` | `Bun.spawnSync` → `async Bun.spawn` + `await proc.stdout` |
| `getTerminalScrollbackWithAnsi` | `Bun.spawnSync` → `async Bun.spawn` + `await proc.stdout` |
| `findLogsWithExactMessage` | `Bun.spawnSync` → `async Bun.spawn` + `await proc.stdout` |
| `findLogsWithExactMessageInPaths` | `Bun.spawnSync` → `async Bun.spawn` + `await proc.stdout` |
| `getRgMatchLines` | `Bun.spawnSync` → `async Bun.spawn` + `await proc.stdout` |
| `tryExactMatchWindowToLog` | becomes `async`, calls async versions above |
| `verifyWindowLogAssociationDetailed` | becomes `async`, calls async `tryExactMatchWindowToLog` |

**No sync copies retained.** All callers (startup, workers) use the async versions.

### Phase 2: Convert worker threads to async

| File | Change |
|------|--------|
| `logMatchWorker.ts` | Message handler becomes async. Allows concurrent processing of independent session messages. |
| `sessionRefreshWorker.ts` | Same async conversion. Independent session operations can overlap. |

Workers allow concurrent message handling — no queue needed. Operations target different sessions and are read-only (tmux captures + ripgrep searches).

### Phase 3: Startup reorder + parallel verification

**New `verifyAllSessions()` function in index.ts:**
- Standalone async function, runs `Promise.all` over all active sessions
- Returns `Map<sessionId, WindowLogVerificationResult>`
- Per-session try/catch — one failure doesn't block others
- On error/timeout: returns `{ status: 'verified' }` (keep current association)

**`hydrateSessionsWithAgentSessions` modification:**
- New optional param: `precomputedVerifications?: Map<string, WindowLogVerificationResult>`
- When provided, uses the map instead of calling verification inline
- All existing decision logic (orphan/keep/name-fallback) unchanged

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
      return { session, result: await verifyWindowLogAssociationDetailed(...) }
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

No per-session or global deadline needed — `Promise.all` means one slow session doesn't block others, and per-subprocess timeouts cap the worst case.

## Race conditions considered and accepted

1. **UI flicker**: UI connects before verification finishes, shows sessions that may later be orphaned. Accepted — the UI already handles runtime orphaning gracefully. Sessions can be orphaned at any time during normal operation.

2. **Log poller overlap**: `logPoller.start()` runs before verification completes. The poller may fire during async verification, causing duplicate tmux captures. Accepted — both are read-only operations, the ~1.5s overlap is harmless and slightly wasteful at worst.

3. **Periodic refresh overlap**: `setInterval(refreshSessions, ...)` could fire during verification. Accepted — same reasoning as log poller overlap, read-only operations.

4. **Resurrection ordering**: `resurrectPinnedSessions` runs after verification, same as today. Claude/Codex reuse the same JSONL log file on `--resume`, so the log path in DB stays valid after resurrection. No stale association issue.

## Files Changed

| File | Type | Description |
|------|------|-------------|
| `src/server/logMatcher.ts` | Modified | Convert all spawn functions from sync to async (`Bun.spawnSync` → `Bun.spawn`) |
| `src/server/logMatchWorker.ts` | Modified | Convert message handler to async, allow concurrent processing |
| `src/server/sessionRefreshWorker.ts` | Modified | Convert message handler to async, allow concurrent processing |
| `src/server/index.ts` | Modified | Add `verifyAllSessions()`, add `precomputedVerifications` param to hydrate, restructure startup order, move `Bun.serve()` before verification |
| `src/server/__tests__/logMatcher.test.ts` | Modified | Update tests for async function signatures |
| `src/server/__tests__/index.test.ts` | Modified | Update startup sequence tests |

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
- [ ] Worker threads handle concurrent messages correctly (no race conditions in output)
