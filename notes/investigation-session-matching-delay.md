# Investigation: Session Matching Delay

## Issue

An orphaned session took ~8 minutes to be matched to its tmux window, even though both existed from the start and the session was actively being used.

## Specific Session Details

| Field | Value |
|-------|-------|
| Session ID | `019bccf6-630a-71e3-9a61-f00916f9e79a` |
| Display Name | `tiny-frame` → `warm-twig` (after match) |
| Log File | `/Users/garybasin/.codex/sessions/2026/01/17/rollout-2026-01-17T12-17-37-019bccf6-630a-71e3-9a61-f00916f9e79a.jsonl` |
| Tmux Window | `agentboard:@4219` |
| Agent Type | Codex |

### Timeline (UTC)

| Time | Event |
|------|-------|
| 17:17:37 | Log file created (birth time) |
| 17:17:37 | Session inserted into DB as orphaned (`currentWindow = null`) |
| 17:25:51 | Session rematched to window `agentboard:@4219` |
| 17:42:36 | Log file last modified |

**Delay: ~8 minutes** between session creation and successful window match.

### Server Log Entry

```json
{
  "ts": "2026-01-17T17:25:51.492Z",
  "level": "info",
  "event": "session_rematched",
  "sessionId": "019bccf6-630a-71e3-9a61-f00916f9e79a",
  "window": "agentboard:@4219",
  "displayName": "warm-twig"
}
```

## Background: How Session-to-Window Matching Works

1. **Log Discovery**: `LogPoller` scans `~/.claude/projects/` and `~/.codex/sessions/` for JSONL log files every 5 seconds

2. **Session Creation**: When a new log is found, a session record is created in the DB. If no matching tmux window is found at that moment, the session is "orphaned" (`currentWindow = null`)

3. **Window Discovery**: `SessionManager` discovers tmux windows and maintains them in a registry

4. **Matching**: The system tries to match orphaned sessions to windows by:
   - Extracting user messages from tmux terminal scrollback
   - Searching for those messages in log files using ripgrep
   - If messages match, associating the session with the window

## Key Code Constraints

### Constraint 1: Only top 25 logs are processed per poll

```typescript
// logPollData.ts:75
const limited = timeEntries.slice(0, Math.max(1, maxLogs))  // DEFAULT_MAX_LOGS = 25
```

### Constraint 2: Orphaned sessions only included in matching when `mtime > lastActivityAt`

```typescript
// logMatchGate.ts:36-40
if (!session.currentWindow) {
  const lastActivity = Date.parse(session.lastActivityAt)
  if (!Number.isFinite(lastActivity) || entry.mtime > lastActivity) {
    needs.push(entry)
  }
}
```

### Constraint 3: `lastActivityAt` is updated to `mtime` after each poll

```typescript
// logPoller.ts:338-339
if (hasActivity) {
  update.lastActivityAt = new Date(entry.mtime).toISOString()
}
```

### Constraint 4: Matching only searches logs in `entriesToMatch`

```typescript
// logMatchWorker.ts:69-70
const matchLogPaths = entriesToMatch.map((entry) => entry.logPath)
const matches = matchWindowsToLogsByExactRg(payload.windows, logDirs, ..., { logPaths: matchLogPaths })
```

### Constraint 5: 60-second cooldown is set BEFORE checking if match exists

```typescript
// logPoller.ts:360-366
if (Date.now() - lastAttempt > REMATCH_COOLDOWN_MS) {
  this.rematchAttemptCache.set(existing.sessionId, Date.now())  // SET FIRST
  const exactMatch = exactWindowMatches.get(entry.logPath) ?? null
  if (exactMatch) { /* rematch */ }
}
```

## Evidence

| Fact | Source |
|------|--------|
| Session created at 17:17:37 UTC | DB query: `created_at` field |
| Session rematched at 17:25:51 UTC | Server log: `session_rematched` event |
| Delay: ~8 minutes | Timestamp difference |
| Log was actively being written | User confirmed + mtime shows 17:42:36 (after rematch) |
| Window existed from the start | User confirmed |
| 29 recently modified logs, limit is 25 | `find ~/.claude/projects ~/.codex/sessions -name "*.jsonl" -mmin -60 \| wc -l` |
| Direct matching test worked immediately | Running `tryExactMatchWindowToLog('agentboard:@4219', ...)` returned correct match |

### Direct Match Test Result

When matching was tested directly (bypassing the poller constraints), it succeeded immediately:

```javascript
const result = tryExactMatchWindowToLog(
  'agentboard:@4219',
  logDirs,
  10000,
  { agentType: 'codex' }
)
// Result:
{
  logPath: "/Users/garybasin/.codex/sessions/2026/01/17/rollout-2026-01-17T12-17-37-019bccf6-630a-71e3-9a61-f00916f9e79a.jsonl",
  userMessage: "...",
  matchedCount: 6,
  matchedLength: 770,
}
```

## Hypothesis: Two Bugs Compounding

### Bug 1: Premature Cooldown Setting

**Location**: `src/server/logPoller.ts:364`

When cooldown expires and we check for a match:
1. If `exactMatch` is null (log wasn't in `entriesToMatch` at matching time)
2. Cooldown is still set to now (line 364)
3. We must wait another 60 seconds even though the match might be available on the very next poll

### Bug 2: Timing Race with `mtime > lastActivityAt`

**Location**: `src/server/logMatchGate.ts:38`

Even with constant writes to the log:
1. Poll N: `mtime = T1`, `lastActivityAt = T0`, `T1 > T0` ✓ → log in `entriesToMatch`
2. We update `lastActivityAt = T1`
3. Poll N+1 (5s later): If no write happened in those 5 seconds, `mtime = T1`, `lastActivityAt = T1`
4. `T1 > T1` ✗ → log NOT in `entriesToMatch`
5. Matching doesn't search this log
6. `exactWindowMatches.get(logPath)` returns null

### Combined Effect

```
T=0:      Session created orphaned (maybe window not discovered yet, or race condition)
T=0-60:   Cooldown blocks retries
T=60:     Cooldown expires, but mtime == lastActivityAt at this moment
          → Log not in entriesToMatch → exactMatch null → cooldown set again
T=60-120: Cooldown blocks
T=120:    Same race condition might happen again
...repeat until lucky timing where both conditions align...
T=~480:   Finally matches (8 minutes later)
```

Each time the cooldown expires (~every 60s), there's a chance the `mtime > lastActivityAt` check fails due to timing, causing another 60-second wait. Over 8 minutes, this could happen ~8 times.

## Proposed Fixes

### Fix 1: Only set cooldown when `exactMatch` is not null

**File**: `src/server/logPoller.ts`

```typescript
// Before (buggy):
if (Date.now() - lastAttempt > REMATCH_COOLDOWN_MS) {
  this.rematchAttemptCache.set(existing.sessionId, Date.now())
  const exactMatch = exactWindowMatches.get(entry.logPath) ?? null
  if (exactMatch) { /* rematch */ }
}

// After (fixed):
const exactMatch = exactWindowMatches.get(entry.logPath) ?? null
if (exactMatch) {
  const lastAttempt = this.rematchAttemptCache.get(existing.sessionId) ?? 0
  if (Date.now() - lastAttempt > REMATCH_COOLDOWN_MS) {
    this.rematchAttemptCache.set(existing.sessionId, Date.now())
    // ... do rematch
  }
}
```

### Fix 2: Always include orphaned session logs in `entriesToMatch`

**File**: `src/server/logMatchGate.ts`

```typescript
// Before (buggy):
if (!session.currentWindow) {
  const lastActivity = Date.parse(session.lastActivityAt)
  if (!Number.isFinite(lastActivity) || entry.mtime > lastActivity) {
    needs.push(entry)
  }
}

// After (fixed):
if (!session.currentWindow) {
  // Always include orphaned sessions - they need to find windows
  needs.push(entry)
}
```

## Notes

- Claude subagent logs are already filtered out at scan time (`scanAllLogDirs` skips `/subagents/` directories)
- Codex subagent logs are detected by reading file content (`isCodexSubagent`) and excluded from session creation
- The 25-log limit exists for performance reasons but may need adjustment if users have many active sessions
