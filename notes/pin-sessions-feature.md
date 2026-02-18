# Pin Sessions Feature

## Summary

Users can pin agent sessions. Pinned sessions automatically resurrect when the agentboard server starts and their tmux window is missing.

## Requirements

| Aspect | Decision |
|--------|----------|
| Behavior | Prevent auto-cleanup + auto-resurrect on server start |
| Scope | Agent sessions only (have stable IDs in DB) |
| UI | Visual indicator (pin icon), no special sorting |
| Storage | Server SQLite DB (syncs across tabs) |

## Behavior Matrix

| Scenario | What happens |
|----------|--------------|
| Server starts, pinned session has no tmux window | Auto-create window, run `claude --resume {sessionId}` or `codex resume {sessionId}` |
| Resume command fails | Show error notification, unpin the session, move to inactive |
| User manually kills pinned window | Session becomes orphaned (inactive) but stays pinned - will resurrect on next server start |
| Cleanup script runs | Should check `is_pinned` before killing (documented behavior) |

## Data Model

### Database Schema Change

Add to `agent_sessions` table:

```sql
ALTER TABLE agent_sessions ADD COLUMN is_pinned INTEGER DEFAULT 0;
```

### Type Changes

```typescript
// AgentSessionRecord (server/db.ts)
isPinned: boolean

// AgentSession (shared/types.ts)
isPinned?: boolean

// New WebSocket messages (shared/types.ts)
| { type: 'session-pin'; sessionId: string; isPinned: boolean }
| { type: 'session-pin-result'; sessionId: string; ok: boolean; error?: string }
```

## Implementation

### Files to Modify

| File | Changes |
|------|---------|
| `src/server/db.ts` | Add `is_pinned` column, migration, `setPinned()` method, `getPinnedOrphaned()` query |
| `src/shared/types.ts` | Add `isPinned` to `AgentSession`, new message types |
| `src/server/index.ts` | Handle `session-pin` message, add `resurrectPinnedSessions()` on startup |
| `src/server/SessionRegistry.ts` | Include `isPinned` when emitting agent sessions |
| `src/client/stores/sessionStore.ts` | Add `pinSession(id)` action |
| `src/client/components/SessionList.tsx` | Pin icon toggle in context menu |
| `src/client/components/SessionItem.tsx` | Visual pin indicator |

### Server Startup Flow

```
1. initDatabase()
2. sessionManager.listWindows()           // discover current tmux state
3. hydrateSessionsWithAgentSessions()     // reconcile DB with tmux
4. resurrectPinnedSessions()              // NEW
   |-- for each pinned session where current_window IS NULL:
       |-- create tmux window (name = displayName)
       |-- cd to projectPath
       |-- run resume command (claude --resume {sessionId} or codex resume {sessionId})
       |-- on success: update current_window in DB
       |-- on failure: set is_pinned = 0, log error
5. start refresh interval
```

### Database Methods to Add

```typescript
// db.ts
setPinned: (sessionId: string, isPinned: boolean) => AgentSessionRecord | null
getPinnedOrphaned: () => AgentSessionRecord[]  // WHERE is_pinned = 1 AND current_window IS NULL
```

### Resurrection Query

```sql
SELECT * FROM agent_sessions
WHERE is_pinned = 1 AND current_window IS NULL
```

## UI

- **Pin toggle**: Context menu item "Pin" / "Unpin" on active sessions
- **Visual indicator**: Small pin icon on pinned sessions
- **No sorting change**: Pinned sessions stay in normal sort order

## Edge Cases

| Case | Handling |
|------|----------|
| Session ID no longer valid (agent wiped) | Resume fails -> unpin + notify |
| Project path deleted | Resume fails -> unpin + notify |
| Multiple pinned sessions | Resurrect sequentially to avoid tmux race conditions |
| User pins then immediately kills tmux | Won't resurrect until next server start |

## Testing Strategy

The codebase already supports isolated testing via environment variables. We can TDD this feature without touching production data.

### Test Environment

```bash
# Isolated test instance
PORT=5050
TMUX_SESSION=agentboard-test-pin-${timestamp}
AGENTBOARD_DB_PATH=/tmp/agentboard-pin-test.db
CLAUDE_CONFIG_DIR=/tmp/test-claude    # empty or mock logs
CODEX_HOME=/tmp/test-codex
```

### Unit Tests (db.test.ts)

```typescript
test('setPinned updates is_pinned flag', () => {
  const session = makeSession()
  db.insertSession(session)

  db.setPinned(session.sessionId, true)
  expect(db.getSessionById(session.sessionId)?.isPinned).toBe(true)

  db.setPinned(session.sessionId, false)
  expect(db.getSessionById(session.sessionId)?.isPinned).toBe(false)
})

test('getPinnedOrphaned returns pinned sessions without window', () => {
  db.insertSession(makeSession({ sessionId: 'a', isPinned: true, currentWindow: null }))
  db.insertSession(makeSession({ sessionId: 'b', isPinned: true, currentWindow: 'agentboard:1' }))
  db.insertSession(makeSession({ sessionId: 'c', isPinned: false, currentWindow: null }))

  const orphaned = db.getPinnedOrphaned()
  expect(orphaned.map(s => s.sessionId)).toEqual(['a'])
})
```

### Integration Tests (pin-sessions.integration.test.ts)

```typescript
describe('pin sessions', () => {
  // Uses isolated tmux session + temp DB (same pattern as integration.test.ts)

  test('pinned session survives server restart', async () => {
    // 1. Start server, create session via WebSocket
    // 2. Pin the session
    // 3. Kill the tmux window (simulates tmux crash)
    // 4. Stop server
    // 5. Restart server
    // 6. Verify session was resurrected with new tmux window
  })

  test('failed resurrection unpins session', async () => {
    // 1. Create and pin session
    // 2. Kill tmux window
    // 3. Set CLAUDE_RESUME_CMD to a failing command
    // 4. Restart server
    // 5. Verify session is unpinned and in inactive list
  })
})
```

### Manual Testing Script

```bash
#!/bin/bash
# scripts/test-pin-feature.sh

export PORT=5050
export TMUX_SESSION="agentboard-pin-test"
export AGENTBOARD_DB_PATH="/tmp/agentboard-pin-test.db"
export CLAUDE_RESUME_CMD="echo 'mock resume {sessionId}'"

# Cleanup
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
rm -f "$AGENTBOARD_DB_PATH"

# Start isolated server
bun run src/server/index.ts
```

### CI Considerations

- Integration tests need tmux installed (already skipped if unavailable)
- Tests create/destroy their own tmux sessions - no interference
- Temp DB files cleaned up in `afterAll`

## Not in Scope (v1)

- Pinning non-agent sessions
- Special sorting for pinned sessions
- "Resurrect now" manual button (could add later)
- Syncing pin state across multiple agentboard instances
