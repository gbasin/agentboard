# Hybrid Session Matching: Content + Name-Based Fallback

## Problem

After server restart or conversation compaction, sessions can fail to rematch to their windows because:

1. **Content-based matching fails when terminal content is ambiguous** - short prompts like "generate a PR" may exist in multiple log files
2. **Ties return null** - when two logs score equally, the matcher returns no match rather than guessing
3. **Post-compaction scrollback lacks original user prompts** - only action summaries remain visible

This causes sessions to stay orphaned even when the window exists and has the correct name.

## History

### Previous Approach: Name-Based Recovery (Removed)

Commit `4135bf0` added `recoverOrphanedSessions()` which matched orphaned sessions to windows by display name. This was later removed in commit `9953322` because:

- **Name collisions could cause wrong matches** - two different sessions with the same name would incorrectly match
- **Content-based verification was seen as more accurate** - actually checks terminal content against log

### Current Approach: Content-Only Verification

Commit `9953322` replaced name recovery with `verifyWindowLogAssociation()` which:

- Extracts user messages from terminal scrollback
- Searches for those messages in log files
- Returns the best-matching log (or null on tie/no-match)

**Problem:** When content is ambiguous (short messages, ties, empty scrollback), sessions get orphaned with no fallback.

## Solution: Hybrid Approach

Use content-based matching as **primary** and name-based matching as **fallback**:

1. **Content match succeeds** → use it (most accurate)
2. **Content match finds mismatch** → orphan the session (content proves wrong association)
3. **Content match is inconclusive** → fall back to name matching

This gives the best of both worlds: prefer content accuracy when available, but recover via names when content is ambiguous.

---

## Implementation Plan

### TODO 1: Add Tri-State Verification Result (logMatcher.ts)

Add a detailed verification function that returns three states instead of boolean:

**File:** `src/server/logMatcher.ts`

**Add types:**
```typescript
export type WindowLogVerificationStatus = 'verified' | 'mismatch' | 'inconclusive'

export interface WindowLogVerificationResult {
  status: WindowLogVerificationStatus
  /** The best match found, if any */
  bestMatch: ExactMatchResult | null
  /** Why inconclusive (for debugging) */
  reason?: 'no_match' | 'error'
}
```

**Add function:**
```typescript
/**
 * Verify that a window's terminal content matches a specific log file.
 *
 * Returns detailed result with tri-state status:
 * - 'verified': Window content matches the expected log (this log is the best match)
 * - 'mismatch': Window content matches a DIFFERENT log (strong evidence of wrong association)
 * - 'inconclusive': No confident match (empty scrollback, tie between logs, or error)
 */
export function verifyWindowLogAssociationDetailed(
  tmuxWindow: string,
  logPath: string,
  logDirs: string[],
  options: VerifyWindowLogOptions = {}
): WindowLogVerificationResult {
  const {
    context = {},
    scrollbackLines = DEFAULT_SCROLLBACK_LINES,
    excludeLogPaths = [],
  } = options

  const excludeSet = new Set(excludeLogPaths)
  excludeSet.delete(logPath)

  try {
    const bestMatch = tryExactMatchWindowToLog(
      tmuxWindow,
      logDirs,
      scrollbackLines,
      context,
      { excludeLogPaths: excludeSet.size > 0 ? [...excludeSet] : undefined }
    )

    if (bestMatch === null) {
      // null means no match or tie - treat as inconclusive
      return { status: 'inconclusive', bestMatch: null, reason: 'no_match' }
    }

    if (bestMatch.logPath === logPath) {
      return { status: 'verified', bestMatch }
    }

    return { status: 'mismatch', bestMatch }
  } catch (error) {
    // IO errors, parse errors, etc. - treat as inconclusive
    logger.warn('verify_window_log_error', { tmuxWindow, logPath, error: String(error) })
    return { status: 'inconclusive', bestMatch: null, reason: 'error' }
  }
}
```

---

### TODO 2: Update Startup Verification with Name Fallback (index.ts)

**File:** `src/server/index.ts`

**Current code (approximately lines 266-296):**
```typescript
if (verifyAssociations) {
  const otherSessionLogPaths = activeSessions
    .filter((s) => s.sessionId !== agentSession.sessionId && s.currentWindow)
    .map((s) => s.logFilePath)

  const verified = verifyWindowLogAssociation(
    agentSession.currentWindow,
    agentSession.logFilePath,
    logDirs,
    {
      context: { agentType: agentSession.agentType, projectPath: agentSession.projectPath },
      excludeLogPaths: otherSessionLogPaths,
    }
  )

  if (!verified) {
    logger.info('session_verification_failed', { ... })
    db.orphanSession(agentSession.sessionId)
    continue
  }
}
```

**New code:**
```typescript
if (verifyAssociations) {
  const otherSessionLogPaths = activeSessions
    .filter((s) => s.sessionId !== agentSession.sessionId && s.currentWindow)
    .map((s) => s.logFilePath)

  const verification = verifyWindowLogAssociationDetailed(
    agentSession.currentWindow,
    agentSession.logFilePath,
    logDirs,
    {
      context: { agentType: agentSession.agentType, projectPath: agentSession.projectPath },
      excludeLogPaths: otherSessionLogPaths,
    }
  )

  // Get the window to check name match
  const window = sessions.find(s => s.tmuxWindow === agentSession.currentWindow)
  const nameMatches = window && window.name === agentSession.displayName

  // Decide whether to orphan based on verification status and name match
  let shouldOrphan = false
  let fallbackUsed = false

  if (verification.status === 'verified') {
    // Content confirms association - keep
    shouldOrphan = false
  } else if (verification.status === 'mismatch') {
    // Content proves wrong association - orphan regardless of name
    shouldOrphan = true
  } else {
    // Inconclusive - use name as fallback
    if (nameMatches) {
      shouldOrphan = false
      fallbackUsed = true
    } else {
      shouldOrphan = true
    }
  }

  if (shouldOrphan) {
    logger.info('session_verification_failed', {
      sessionId: agentSession.sessionId,
      displayName: agentSession.displayName,
      currentWindow: agentSession.currentWindow,
      logFilePath: agentSession.logFilePath,
      verificationStatus: verification.status,
      nameMatches,
      bestMatchLog: verification.bestMatch?.logPath ?? null,
    })
    const orphanedSession = db.orphanSession(agentSession.sessionId)
    if (orphanedSession) {
      orphaned.push(toAgentSession(orphanedSession))
    }
    continue
  }

  if (fallbackUsed) {
    logger.info('session_verification_name_fallback', {
      sessionId: agentSession.sessionId,
      displayName: agentSession.displayName,
      currentWindow: agentSession.currentWindow,
      verificationStatus: verification.status,
    })
  }
}
```

**Import change:**
```typescript
// Change from:
import { verifyWindowLogAssociation } from './logMatcher'
// To:
import { verifyWindowLogAssociationDetailed } from './logMatcher'
```

---

### TODO 3: Add Name-Based Fallback to Orphan Rematch (logPoller.ts)

**File:** `src/server/logPoller.ts`

**Location:** `runOrphanRematchInBackground()` method (around line 128-245)

**After the content-based matching loop, add name-based fallback:**

```typescript
// ... existing content-based matching code ...

// Process orphan matches (existing code)
const windowsByTmux = new Map(
  windows.map((window) => [window.tmuxWindow, window])
)
const claimedWindows = new Set(
  this.db.getActiveSessions().map(s => s.currentWindow).filter(Boolean)
)
const matchedOrphanSessionIds = new Set<string>()
let orphanMatches = 0

for (const match of response.orphanMatches ?? []) {
  const window = windowsByTmux.get(match.tmuxWindow)
  if (!window) continue

  const existing = this.db.getSessionByLogPath(match.logPath)
  if (existing && !existing.currentWindow) {
    if (claimedWindows.has(match.tmuxWindow)) {
      logger.info('orphan_rematch_skipped_window_claimed', {
        sessionId: existing.sessionId,
        window: match.tmuxWindow,
        claimedBySessionId: this.db.getSessionByWindow(match.tmuxWindow)?.sessionId,
      })
      continue
    }
    this.db.updateSession(existing.sessionId, {
      currentWindow: match.tmuxWindow,
      displayName: window.name,
    })
    claimedWindows.add(match.tmuxWindow)
    matchedOrphanSessionIds.add(existing.sessionId)
    this.onSessionActivated?.(existing.sessionId, match.tmuxWindow)
    logger.info('orphan_rematch_success', {
      sessionId: existing.sessionId,
      window: match.tmuxWindow,
      displayName: window.name,
    })
    orphanMatches++
  }
}

// NEW: Name-based fallback for orphans that didn't get content-matched
const unmatchedOrphans = orphanCandidates.filter(
  o => !matchedOrphanSessionIds.has(o.sessionId)
)

if (unmatchedOrphans.length > 0) {
  // Build map of unclaimed window name -> window (only if name is unique)
  const unclaimedByName = new Map<string, Session>()
  const ambiguousNames = new Set<string>()
  for (const window of windows) {
    if (claimedWindows.has(window.tmuxWindow)) continue
    if (ambiguousNames.has(window.name)) continue
    if (unclaimedByName.has(window.name)) {
      // Multiple windows with same name - mark as ambiguous, don't use for fallback
      unclaimedByName.delete(window.name)
      ambiguousNames.add(window.name)
      continue
    }
    unclaimedByName.set(window.name, window)
  }

  // Match unmatched orphans by display name
  let nameMatches = 0
  for (const orphan of unmatchedOrphans) {
    const window = unclaimedByName.get(orphan.displayName)
    if (window) {
      const existing = this.db.getSessionByLogPath(orphan.logFilePath)
      if (existing && !existing.currentWindow) {
        this.db.updateSession(existing.sessionId, {
          currentWindow: window.tmuxWindow,
          displayName: window.name,
        })
        claimedWindows.add(window.tmuxWindow)
        unclaimedByName.delete(orphan.displayName)
        this.onSessionActivated?.(existing.sessionId, window.tmuxWindow)
        logger.info('orphan_rematch_name_fallback', {
          sessionId: existing.sessionId,
          displayName: orphan.displayName,
          window: window.tmuxWindow,
        })
        nameMatches++
      }
    }
  }

  if (nameMatches > 0) {
    orphanMatches += nameMatches
  }
}

logger.info('orphan_rematch_complete', {
  orphanCount: orphanCandidates.length,
  matches: orphanMatches,
})
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Multiple orphans with same displayName | First in iteration order wins (rare due to unique name generation) |
| Multiple windows with same name | Name fallback skipped for that name (ambiguous) |
| Window name matches but content matched different log | Content match takes priority |
| Window renamed after session created | Name fallback won't help, content might |
| Session displayName changed after window created | Name fallback won't help |
| Content proves mismatch but names match | Orphan anyway (content is authoritative when definitive) |
| IO/parse error during verification | Treat as inconclusive, allow name fallback |

---

## Logging

New log events:

| Event | When | Fields |
|-------|------|--------|
| `session_verification_name_fallback` | Startup kept session via name match after inconclusive content | sessionId, displayName, currentWindow, verificationStatus |
| `orphan_rematch_name_fallback` | Orphan rematch succeeded via name match | sessionId, displayName, window |

Updated events:

| Event | New Fields |
|-------|------------|
| `session_verification_failed` | verificationStatus, nameMatches, bestMatchLog |

---

## Testing

### Unit Tests

1. **Tri-state verification returns correct status**
   - 'verified' when best match equals expected log
   - 'mismatch' when best match is different log
   - 'inconclusive' when no match found (reason: 'no_match')
   - 'inconclusive' when error occurs (reason: 'error')

2. **Startup verification with name fallback**
   - Content verified → keep session
   - Content mismatch → orphan even if names match
   - Content inconclusive + names match → keep session (log fallback used)
   - Content inconclusive + names don't match → orphan

3. **Orphan rematch name fallback**
   - Content match succeeds → use it
   - Content match fails, unique name matches → use name fallback
   - Content match fails, name doesn't match → stay orphaned
   - Multiple windows with same name → skip name fallback (ambiguous)
   - Multiple orphans same name → first wins

### Integration Tests

1. Session survives restart with compacted scrollback when names match
2. Session orphans correctly when window reused by different session (content mismatch)
3. Name fallback triggers and logs correctly

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/server/logMatcher.ts` | Add `WindowLogVerificationStatus`, `WindowLogVerificationResult`, `verifyWindowLogAssociationDetailed()` |
| `src/server/index.ts` | Update import, modify verification block to use tri-state + name fallback |
| `src/server/logPoller.ts` | Add name-based fallback after content matching in `runOrphanRematchInBackground()` |

---

## Related Commits

- `4135bf0` - Added `recoverOrphanedSessions()` (name-based recovery)
- `1c62d44` - Added `windowsByName` recovery in hydration
- `9953322` - Removed name recovery, added `verifyAssociations` (content-only)
- `3f2eba6` - Added `excludeLogPaths` to prevent cross-session pollution
