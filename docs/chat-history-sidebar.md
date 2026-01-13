# Technical Specification: Chat History Sidebar

**Version:** 1.0
**Status:** Approved
**Last Updated:** 2026-01-11
**Debated With:** codex/gpt-5.2-codex (xhigh reasoning)
**Rounds:** 3

---

## Overview / Context

Add a History section to the Sessions sidebar to browse, search, and resume past Claude/Codex sessions from local JSONL logs. Search uses an optional local indexer when available; otherwise it falls back to a bounded local scan. All data remains on the local machine and no network calls are made.

## Goals and Non-Goals

### Goals
- Deterministic local search with documented semantics in both indexed and basic modes.
- Support 1k to 10k session files with acceptable latency (indexed and basic targets below).
- Work out-of-the-box without extra installs; indexed mode is optional and discoverable.
- Resume a prior session in a new tmux window with clear success/failure states.

### Non-Goals
- Real-time updates from active sessions.
- Editing or deleting logs.
- Multi-user support or remote data sources.
- Cross-machine search or cloud sync.

## System Architecture

- Frontend `HistorySection` uses REST endpoints (no WebSocket).
- Backend `HistoryService` owns all file access, parsing, search, and resume orchestration.
- Search flow: `/api/history/search` → `HistoryService.search()` → `IndexedSearchAdapter` (if healthy) else `BasicSearchScanner`.
- Resume flow: `/api/history/resume` → validate → locate session log → spawn tmux window → `SessionManager.refresh()`.

## Component Design

### Backend

#### `src/server/HistoryService.ts`
- Validates inputs, selects search mode, dispatches to indexer or scanner.
- Maintains counts cache and indexer health.

#### `src/server/IndexedSearchAdapter.ts`
- Executes `aichat-search` with required flags, enforces timeout and cooldown.
- Parses JSONL output into normalized hits, filters to allowed roots.

#### `src/server/BasicSearchScanner.ts`
- Enumerates log files under allowed roots with glob patterns.
- Reads bounded bytes/lines per file with concurrency control.
- Extracts metadata and applies query filters (basic mode).

#### `src/server/LogMetadataExtractor.ts`
- Deterministic parsing of JSONL records into `HistorySession` metadata.

### Frontend

#### `src/client/stores/historyStore.ts`
- Holds sessions, search state, loading/error flags, and status (indexed/basic).

#### `src/client/components/HistorySection.tsx`
- History header, search input, results list, empty/error states.
- Keyboard navigation and resume action.

#### `src/client/components/HistoryList.tsx`
- Handles selection and key navigation; list items show project info and snippet.

## API Design

### Common Response Headers
- `X-Request-Id`: UUID v4 generated per request.
- `Cache-Control: no-store`

### Common Error Response
```typescript
interface ErrorResponse {
  error: string
  message: string
  requestId: string
  details?: Record<string, unknown>
}
```

### Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `history_disabled` | 404 | Feature flag off |
| `invalid_request` | 400 | Missing/invalid params |
| `rate_limited` | 429 | Rate limit exceeded |
| `search_failed` | 500 | Unexpected search error |
| `indexer_unavailable` | 503 | Indexed search requested but unavailable |
| `session_not_found` | 404 | Session ID not found |
| `resume_cli_unavailable` | 503 | `claude` or `codex` CLI missing |
| `tmux_unavailable` | 503 | tmux not running or not found |
| `resume_timeout` | 504 | tmux window not visible in time |
| `resume_failed` | 500 | Resume command failed |

### GET /api/history/status

**Response 200:**
```json
{
  "enabled": true,
  "mode": "indexed",
  "indexer": {
    "available": true,
    "version": "0.5.2",
    "health": "healthy",
    "lastError": null,
    "cooldownUntil": null
  },
  "claudeSessionCount": 847,
  "codexSessionCount": 234,
  "countsCachedAt": "2024-01-15T10:30:00Z",
  "countsError": null
}
```

**Errors:** `history_disabled` (404).

### GET /api/history/search

**Query params:**

| Param | Required | Default | Constraints |
|-------|----------|---------|-------------|
| `q` | Yes | - | 1-500 chars after trim, no null bytes |
| `limit` | No | 50 | 1-200 |
| `agent` | No | - | `claude` or `codex` |

**Response 200:**
```json
{
  "mode": "indexed",
  "query": "auth",
  "sessions": [
    {
      "id": "agent-abc123",
      "projectPath": "~/myproject",
      "projectName": "myproject",
      "agentType": "claude",
      "lastModified": "2024-01-15T10:30:00Z",
      "sessionType": "original",
      "messageCount": 42,
      "firstMessage": "Help me implement user authentication...",
      "matchSnippet": "...implementing OAuth2 flow..."
    }
  ],
  "totalCount": 12,
  "truncated": true,
  "truncatedReason": "limit"
}
```

**Errors:** `history_disabled` (404), `invalid_request` (400), `rate_limited` (429), `search_failed` (500).

### GET /api/history/recent

**Query params:**

| Param | Required | Default | Constraints |
|-------|----------|---------|-------------|
| `limit` | No | 20 | 1-100 |
| `agent` | No | - | `claude` or `codex` |

**Response 200:** Same as search, without `query` and `matchSnippet`.

**Errors:** `history_disabled` (404), `invalid_request` (400), `rate_limited` (429), `search_failed` (500).

### POST /api/history/resume

**Request:**
```json
{
  "sessionId": "agent-abc123",
  "agentType": "claude"
}
```

**Response 200:**
```json
{
  "resumeStatus": "started",
  "session": {
    "id": "window-5",
    "name": "myproject",
    "tmuxWindow": "5",
    "projectPath": "~/myproject",
    "status": "working",
    "lastActivity": "2024-01-15T10:35:00Z",
    "createdAt": "2024-01-15T10:35:00Z",
    "agentType": "claude",
    "source": "managed"
  }
}
```

**Errors:** `history_disabled` (404), `invalid_request` (400), `session_not_found` (404), `resume_cli_unavailable` (503), `tmux_unavailable` (503), `resume_timeout` (504), `resume_failed` (500).

## Data Models

### HistorySession

```typescript
interface HistorySession {
  id: string
  projectPath: string        // redacted, home replaced with "~"
  projectName: string
  agentType: "claude" | "codex"
  lastModified: string       // ISO-8601 UTC from file mtime
  sessionType: "original" | "trimmed" | "rollover" | "sub-agent" | "unknown"
  messageCount: number
  firstMessage?: string      // max 200 chars
  matchSnippet?: string      // max 200 chars, indexed only
}
```

### Session ID Mapping

- `sessionId` is the filename stem: `path.basename(filePath).replace(/\.jsonl$/, "")`.
- If duplicates exist within the same agent type, keep the most recent by mtime and log a warning.

### Session Type Inference

- `trimmed` if filename contains `trimmed`.
- `rollover` if filename contains `rollover`.
- `sub-agent` if filename contains `sub-agent` or `subagent`.
- `original` otherwise; `unknown` only if filename missing.

### Log Metadata Extraction Algorithm

1. Read at most `HISTORY_READ_MAX_BYTES` or `HISTORY_READ_MAX_LINES`, whichever is reached first.
2. Parse each line as JSON; on parse failure, skip line.
3. A message record is detected in one of these shapes, checked in order:
   - `{ role: "user"|"assistant", content: string|ContentArray }`
   - `{ message: { role: "user"|"assistant", content: string|ContentArray } }`
   - `{ type: "message", data: { role, content } }`
   - `{ event: "message", data: { role, content } }`
4. `ContentArray` is an array of objects with `text` or `{ type: "text", text }`. Join with `""`.
5. `firstMessage` is the first `role === "user"` content, truncated to 200 chars, newlines collapsed to spaces.
6. `messageCount` is the count of detected `role === "user"` or `role === "assistant"` records.

### Search Semantics

- **Basic mode:** case-insensitive substring match against `projectPath`, `projectName`, and `firstMessage`.
- **Indexed mode:** query is passed verbatim to the indexer, results are filtered to allowed roots and optionally by agent type.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `AGENTBOARD_HISTORY_ENABLED` | `false` | Feature flag |
| `HISTORY_MAX_FILES` | `20000` | Max files to enumerate in basic mode |
| `HISTORY_MAX_RESULTS` | `200` | Max results per request |
| `HISTORY_READ_MAX_BYTES` | `65536` | Max bytes read per file |
| `HISTORY_READ_MAX_LINES` | `200` | Max lines read per file |
| `HISTORY_INDEX_TIMEOUT_MS` | `10000` | Timeout for indexer |
| `HISTORY_INDEX_COOLDOWN_MS` | `60000` | Cooldown after indexer failure |
| `HISTORY_BASIC_CONCURRENCY` | `8` | Parallel file reads |
| `HISTORY_COUNTS_TTL_MS` | `60000` | Cache TTL for counts |
| `HISTORY_RESUME_TIMEOUT_MS` | `2000` | Max wait for tmux window |
| `HISTORY_TMUX_SESSION` | `agentboard` | tmux session name |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude base dir |
| `CODEX_HOME` | `~/.codex` | Codex base dir |
| `CLAUDE_RESUME_CMD` | `claude --resume {sessionId}` | Resume command template |
| `CODEX_RESUME_CMD` | `codex --resume {sessionId}` | Resume command template |

**Derived paths:**
- Claude log root: `${CLAUDE_CONFIG_DIR}/projects`
- Codex log root: `${CODEX_HOME}/sessions`

## Infrastructure Requirements

- **Runtime:** Bun 1.x, TypeScript 5.x, Node 18+ compatible.
- **Required:** tmux.
- **Required for resume:** `claude` and/or `codex` CLI in PATH.
- **Optional:** `aichat-search` CLI in PATH (indexed mode).
- **OS:** macOS and Linux only.

## Security Considerations

1. **Network binding:** Server binds to `127.0.0.1` only; CORS same-origin.

2. **Input validation:**
   - Trim and validate lengths
   - Reject null bytes in all string inputs
   - Validate `agentType` enum and `sessionId` format

3. **Path safety:**
   - Use `realpath()` and ensure files are under configured roots
   - Reject symlinks that escape roots

4. **Command execution:**
   - Always use `spawn()` with argument arrays
   - Never interpolate user input into shell strings
   - Resume commands use templates with `{sessionId}` replaced after validation

5. **Data exposure:**
   - Never return log file paths or raw JSONL content
   - `projectPath` is redacted by replacing home with `~`

6. **Rate limiting:**
   - In-memory per-IP 5 requests/sec for search endpoints
   - Return 429 `rate_limited` when exceeded

## Error Handling Strategy

| Scenario | Behavior |
|----------|----------|
| Feature flag off | Return 404 `history_disabled` for all endpoints |
| Indexer missing | Mark `indexer.available = false`, fallback to basic mode |
| Indexer timeout/failure | Set `health = degraded`, start cooldown, fallback to basic |
| Malformed JSONL | Skip file, log warning, continue scan |
| Unreadable directory | Log error, return partial results with `truncated = true` |
| Invalid session ID format | Return 400 `invalid_request` |
| Session file not found | Return 404 `session_not_found` |
| tmux not running | Return 503 `tmux_unavailable` |
| Resume CLI not found | Return 503 `resume_cli_unavailable` |
| tmux window not detected | Return 504 `resume_timeout` |

## Performance Requirements

| Metric | Target | Conditions |
|--------|--------|------------|
| Indexed search P95 | < 200ms | 10k sessions, SSD |
| Basic search P95 | < 2s | 10k sessions, SSD |
| Basic search P50 | < 800ms | 10k sessions, SSD |
| Recent load P95 | < 200ms | 20 results |
| Resume P95 | < 500ms | tmux window visible |
| Memory overhead | < 150MB | Bounded by config |

Measurements are from HTTP request receipt to response sent.

## Observability

### Logging
- Include `requestId` in all logs.
- Search logs: mode, duration, file count scanned, results count, fallback reason.
- Resume logs: agentType, sessionId, tmux window id, success/failure.
- Redact queries: log length and first 4 chars only.

### Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `history_search_duration_ms` | histogram | mode |
| `history_scan_files_total` | counter | - |
| `history_indexer_fallback_total` | counter | reason |
| `history_resume_total` | counter | agent_type, status |

## Testing Strategy

### Unit Tests
- `LogMetadataExtractor` parsing and truncation rules.
- Session ID validation.
- Search mode detection and indexer cooldown behavior.
- Path redaction for `projectPath`.

### Integration Tests
- API endpoints with mocked HistoryService.
- Indexer adapter with mock CLI output.
- Basic scanner with mocked filesystem and concurrency limits.

### E2E Tests
- Indexed mode using a mock `aichat-search`.
- Basic mode when indexer missing.
- Resume spawns correct tmux command and returns window info.
- Error states: invalid ID, not found, tmux unavailable.
- UI Playwright tests for HistorySection interactions.

### Test Fixtures
- Sample Claude JSONL (various structures).
- Sample Codex JSONL.
- Edge cases: empty, malformed, very large files.

## Deployment Strategy

1. **Feature flag:** `AGENTBOARD_HISTORY_ENABLED` default `false`.
2. **Rollout phases:**
   - Dev/staging: enable flag, validate all modes
   - Production: enable for early adopters
   - GA: flip default to `true`
3. **Rollback:** Set flag to `false`; no data migrations required.

## Migration Plan

Not applicable (new feature; no existing data).

## Open Questions / Future Considerations

1. Cursor-based pagination for more than 200 results? (v2)
2. Expandable message preview per session? (v2)
3. Require minimum `aichat-search` version for schema stability? (defer)

---

## Appendix: Debate Summary

| Round | Participant | Action |
|-------|-------------|--------|
| 1 | Claude | Initial draft |
| 1 | codex/gpt-5.2-codex | Critiqued: binary name inconsistency, missing error codes, filePath exposure |
| 2 | Claude | Incorporated + added keyboard shortcuts, ErrorBoundary |
| 2 | codex/gpt-5.2-codex | Critiqued: incomplete API contracts, missing config table, no rate limiting |
| 3 | Claude | Incorporated all feedback |
| 3 | codex/gpt-5.2-codex | Critiqued: path redaction, resume command templates, log parsing algorithm |
| 3 | Claude | Agreed |
| 3 | codex/gpt-5.2-codex | Agreed |

**Total tokens:** ~35k in / ~32k out
**Consensus reached:** Round 3
