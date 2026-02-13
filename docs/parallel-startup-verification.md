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

1. No changes to periodic polling — it already uses a worker thread.
2. No conversion of `SessionManager.runTmux()` — it's used broadly and is fast per call.
3. No async refactor of `logMatcher.ts` internals — the functions are shared with the sync worker thread. Only the startup call site changes.
4. No concurrency limiter — 5-15 concurrent tmux/rg processes is well within OS limits.

## Approach: async Bun.spawn + Promise.all

### Why not worker threads?

Session verification is **I/O-bound** (waiting on tmux server + ripgrep disk I/O), not CPU-bound. Async `Bun.spawn` with `Promise.all` gives true parallelism at the OS process level without the overhead of worker thread creation or message serialization.

### Why Bun.spawn over child_process.spawn?

- Native Bun API, uses `posix_spawn(3)` — ~60% faster process creation than Node.js `child_process`
- Stdout is a `ReadableStream` consumed via `new Response(proc.stdout).text()`
- Supports `timeout` option natively for safety

### Pattern

```typescript
// Before (serial, blocking main thread):
for (const session of activeSessions) {
  const result = verifyWindowLogAssociationDetailed(session.currentWindow, ...)
  // ... orphan/keep decision
}

// After (parallel, non-blocking):
const verifications = await Promise.all(
  sessionsToVerify.map(async (session) => {
    const result = await verifyWindowLogAssociationDetailedAsync(session.currentWindow, ...)
    return { session, result }
  })
)
for (const { session, result } of verifications) {
  // ... same orphan/keep decision logic (unchanged)
}
```

## Scope of Changes

### Phase 1: Async verification wrappers (startup path only)

Create async versions of the two subprocess-calling functions used during verification:

**`logMatcher.ts` — new async functions:**

| Function | Current (sync) | New (async) |
|----------|---------------|-------------|
| `getTerminalScrollback` | `Bun.spawnSync(['tmux', 'capture-pane', ...])` | `Bun.spawn` + `await proc.stdout` |
| `getTerminalScrollbackWithAnsi` | `Bun.spawnSync(['tmux', 'capture-pane', '-e', ...])` | `Bun.spawn` + `await proc.stdout` |
| `findLogsWithExactMessage` | `Bun.spawnSync(['rg', '-l', ...])` | `Bun.spawn` + `await proc.stdout` |
| `findLogsWithExactMessageInPaths` | `Bun.spawnSync(['rg', '-l', ...])` | `Bun.spawn` + `await proc.stdout` |
| `getRgMatchLines` | `Bun.spawnSync(['rg', '--json', ...])` | `Bun.spawn` + `await proc.stdout` |

These become the building blocks for:

| Function | Current | New |
|----------|---------|-----|
| `tryExactMatchWindowToLog` | sync, calls above sync functions | `tryExactMatchWindowToLogAsync` — same logic, calls async versions |
| `verifyWindowLogAssociationDetailed` | sync | `verifyWindowLogAssociationDetailedAsync` — same logic, calls async `tryExactMatchWindowToLogAsync` |

**Keep the sync versions.** They are used by the log match worker thread (`logMatchWorker.ts`, `sessionRefreshWorker.ts`) where sync is correct and desired. The async versions are only for the startup path.

**`index.ts` — modified functions:**

| Function | Change |
|----------|--------|
| `hydrateSessionsWithAgentSessions` | Add async overload: when `verifyAssociations: true`, returns `Promise<Session[]>` and runs verifications in parallel via `Promise.all` |
| `refreshSessionsSync` | Rename to `refreshSessionsAsync` for the verification startup call. Keep sync version for the non-verification calls. |
| Startup sequence (lines 660-662) | Restructure: start HTTP server first, then run async verification, then resurrect pinned sessions |

### Phase 2: Reorder startup to serve HTTP earlier

Current startup order:
```
1. checkPortAvailable + ensureTmux + pruneOrphaned    (~200ms)
2. DB init + manager setup                             (~50ms)
3. refreshSessionsSync({ verifyAssociations: true })   (~7000ms) ← BLOCKS HTTP
4. resurrectPinnedSessions()                           (~300ms)
5. refreshSessionsSync()                               (~200ms)
6. logPoller.start()                                   (~100ms)
7. Bun.serve()                                         (~50ms)  ← HTTP ready
```

New startup order:
```
1. checkPortAvailable + ensureTmux + pruneOrphaned     (~200ms)
2. DB init + manager setup                              (~50ms)
3. refreshSessionsSync() (no verification)              (~200ms)  ← sessions from DB, no verify
4. Bun.serve()                                          (~50ms)  ← HTTP ready immediately
5. logPoller.start()                                    (~100ms)
6. await verifySessionAssociations()                    (~1500ms) ← async, parallel
7. resurrectPinnedSessions()                            (~300ms)
8. refreshSessionsSync()                                (~200ms)
```

The UI can connect and see sessions at **~500ms** (from DB state). Verification runs in the background and broadcasts updates if any sessions get orphaned.

### Error handling

Use per-session try/catch inside `Promise.all` — one verification failing should not block others:

```typescript
const results = await Promise.all(
  sessionsToVerify.map(async (session) => {
    try {
      return { session, result: await verifyAsync(session) }
    } catch (error) {
      logger.warn('session_verification_error', { sessionId: session.sessionId, error: String(error) })
      return { session, result: { status: 'inconclusive' as const, bestMatch: null, reason: 'error' } }
    }
  })
)
```

### Timeouts

All async spawns should have timeouts to prevent hung processes from blocking startup:

| Command | Timeout |
|---------|---------|
| `tmux capture-pane` | 5s (matches existing copy-mode timeout) |
| `rg -l` / `rg --json` | 10s (large log directories) |

## Files Changed

| File | Type | Description |
|------|------|-------------|
| `src/server/logMatcher.ts` | Modified | Add async versions of `getTerminalScrollback`, `getTerminalScrollbackWithAnsi`, `findLogsWithExactMessage`, `findLogsWithExactMessageInPaths`, `getRgMatchLines`, `tryExactMatchWindowToLog`, `verifyWindowLogAssociationDetailed` |
| `src/server/index.ts` | Modified | Restructure startup order; make `hydrateSessionsWithAgentSessions` support async verification; move `Bun.serve()` before verification |
| `src/server/__tests__/logMatcher.test.ts` | Modified | Add tests for async verification functions |
| `src/server/__tests__/index.test.ts` | Modified | Update startup sequence tests if applicable |

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Time to HTTP ready | ~10.8s | ~0.5s |
| Time to verified sessions | ~10.8s | ~2.0s |
| Total startup (incl. orphan rematch) | ~16.2s | ~7.0s |

The biggest win is HTTP-ready time: the UI loads almost instantly instead of waiting 11 seconds.

## Risks

1. **Race condition**: UI connects before verification finishes → shows sessions that might get orphaned seconds later. Mitigation: verification broadcasts `session-removed` events, UI handles gracefully (already does — sessions can be orphaned at any time during normal operation).

2. **tmux server contention**: 5 concurrent `tmux capture-pane` + 5 concurrent `rg` processes. tmux serializes internally via its Unix socket, so captures queue but don't contend. rg processes compete for disk I/O but are read-only. Tested: tmux handles 20+ concurrent client commands without issues.

3. **Keeping sync+async in logMatcher.ts**: Duplication of the wrapper layer. Mitigation: the async functions are thin wrappers that delegate to the same parsing/scoring logic. Only the spawn call differs. Consider a shared helper that accepts a spawn strategy.

## Pre-merge Checklist

- [ ] All 532+ tests pass
- [ ] `bun run lint && bun run typecheck` clean
- [ ] Manual test: start server with 5+ active sessions, verify HTTP responds in <2s
- [ ] Manual test: verify orphaned sessions are correctly detected after async verification
- [ ] Manual test: UI shows sessions immediately, then updates if verification orphans any
- [ ] Startup log shows parallel verification completing in ~1.5s
