# Editor Pane Specification

Adversarial review completed with Codex (gpt-5.2-codex, xhigh reasoning) over 5 rounds.

## Overview

Agentboard adds a right-side editor pane for viewing and editing existing text files inside the active session's project root. All file access is via backend APIs that enforce per-session root confinement. No new server-side storage is introduced; only UI preferences are persisted in localStorage.

## Goals and Non-Goals

**Goals:**
- Open and edit existing text files in the active session's project root.
- Provide a fast file picker with fuzzy search and a CodeMirror 6 editor with syntax highlighting by extension.
- Persist editor pane visibility, width, and last opened file per session.
- Support iOS Safari and mobile devices with a defined small-screen layout.

**Non-Goals:**
- No file creation, deletion, or rename.
- No multi-file tabs per session (one open file per session).
- No collaborative editing or external sync.
- No binary editing or rendering.
- No autocomplete/LSP.
- No autosave (manual save only).

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend                             │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌───────────┐ │
│  │ App.tsx  │──│ Terminal  │──│ EditorPane │──│ FilePicker│ │
│  └──────────┘  └───────────┘  └────────────┘  └───────────┘ │
│       │              │              │                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                   editorStore (Zustand)                 │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │ HTTP
┌─────────────────────────────────────────────────────────────┐
│                        Backend (Hono)                        │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ fileRoutes  │──│ pathValidator│──│ SessionManager      │ │
│  └─────────────┘  └──────────────┘  │ (session→projectRoot)│ │
│                                     └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────────────┐
                    │  Project Files  │
                    │   (on disk)     │
                    └─────────────────┘
```

## Component Design

### EditorPane (`src/client/components/EditorPane.tsx`)
- Header: file picker, Save button, dirty indicator (dot before filename when dirty)
- Editor: CodeMirror 6 instance, lazy-loaded on first pane open
- Status bar: relative path, save state, error banner
- Keyboard:
  - `Cmd/Ctrl+S` triggers save and prevents default when editor focused
  - `Cmd/Ctrl+E` toggles editor pane
- Save behavior: disabled when not dirty or when save in flight; shows error banner on failure
- Session termination: when a session is removed while dirty, close file and show toast "Session ended; unsaved changes were discarded"
- CodeMirror load failure: show banner with retry action; editor remains closed until load succeeds
- Last file missing on reopen: show toast and clear `lastFileBySession`
- Small-screen layout (`<768px`): editor becomes full-screen overlay; terminal hidden while open; resize handle disabled

### FilePicker (`src/client/components/FilePicker.tsx`)
- Combobox with client-side fuzzy search over cached list
- Fetches file list via `GET /api/files` on first open; cache TTL 30 seconds keyed by `(sessionId, dir, recursive, limit, ext, includeHidden, includeIgnored)`
- Fuzzy match: case-insensitive subsequence match; score by contiguous run length; sort by score desc, then path length asc, then lexicographic
- Displays relative paths; shows disabled entries for non-editable files (size/ext blocklist)
- Keyboard accessible (arrow keys, Enter, Escape)
- On file switch when dirty: prompt "Discard unsaved changes?" with Cancel/Discard
- After successful save, update the in-memory cache entry for that file path if present

### ResizeHandle (`src/client/components/ResizeHandle.tsx`)
- Drag handle between terminal and editor (mouse and touch)
- Min width: 200px; max width: 60% viewport
- Uses pointer events with `touch-action: none` to prevent scroll interference
- Persists width on drag end
- Disabled on small screens (<768px)

### EditorStore (`src/client/stores/editorStore.ts`)
- Per-session file state and dirty tracking
- Keeps unsaved edits in memory per session (switching sessions does not discard edits; reload discards)
- Subscribes to sessionStore to clean up file state when session is killed

### Theme Integration
- CodeMirror theme configured via compartments
- Theme values derive from CSS variables in `index.css` to match terminal look

---

## API Design

### Common

- Base path: `/api`
- All responses use `Content-Type: application/json; charset=utf-8`
- All responses include `X-Request-Id`
- `Cache-Control: no-store` on `/api/file` GET/PUT responses
- Request ID: if client provides `X-Request-Id`, accept only 1-128 chars of `[A-Za-z0-9._-]`; otherwise generate UUIDv4
- Error schema:
  ```json
  {
    "error": {
      "code": "ERROR_CODE",
      "message": "Human readable message",
      "details": {}
    },
    "requestId": "uuid"
  }
  ```

### Authentication/Authorization
- Endpoints protected by same auth middleware as terminal endpoints
- `sessionId` must belong to authenticated user; otherwise return 404 `SESSION_NOT_FOUND`
- If no auth exists (localhost), document as trusted single-user only

### CORS
- No CORS headers; same-origin only
- Cross-origin access out of scope

### Request Size Limits
- `MAX_FILE_BYTES = 1,048,576` (1 MiB)
- `MAX_BODY_BYTES = 8,388,608` (8 MiB) to allow JSON escaping overhead
- If `Content-Length > MAX_BODY_BYTES`, return 413 before reading
- After JSON parse, enforce `content` UTF-8 byte length <= `MAX_FILE_BYTES`

### Path Normalization
- Paths are relative to session root
- Decode once with `decodeURIComponent`; decode errors return 400
- Reject any decoded backslash, NUL byte, or leading `/`
- Split on `/` and reject: empty segments (`//`), `.` segment, `..` segment
- Allow `..` within a segment (e.g., `foo..bar`)
- Segment length <= 255, total length <= 512
- Trailing slash in `dir` normalized by trimming; trailing slash in `path` is invalid

### Root Confinement
- Compute `rootRealpath = fs.realpath(root)` once per session
- Build `candidate = path.resolve(rootRealpath, rel)`
- Require `candidate === rootRealpath` (empty rel) or `candidate.startsWith(rootRealpath + path.sep)`

### Symlink Policy
- Disallow symlinks in any path segment and for target file
- For file read/write: walk parent dirs with FD-based open (`O_NOFOLLOW | O_DIRECTORY`) where supported, then open file with `O_NOFOLLOW` and verify `fstat` is regular file
- If `O_NOFOLLOW` unavailable, fall back to `lstat` + `realpath` checks and document residual TOCTOU risk
- For `/api/files`: do not follow symlinks; skip and count in `skipped.symlink`

### File Restrictions
- Size limit: 1 MiB
- Encoding: UTF-8 only (`TextDecoder("utf-8", { fatal: true })`)
- Extension blocklist (case-insensitive): `.exe`, `.bin`, `.dll`, `.so`, `.dylib`, `.png`, `.jpg`, `.gif`, `.pdf`, `.zip`, `.tar`, `.gz`
- Extension derived from last `.` in filename
- If both blocked extension and too large apply, `blocked_ext` wins

### Rate Limiting
- Token bucket per `(remoteIP + endpoint + sessionKey)`
- `sessionKey = validated sessionId` or `unknown` before validation
- Limits:
  - `/api/files`: 10 req/min
  - `/api/file` GET: 60 req/min
  - `/api/file` PUT: 30 req/min
- `remoteIP` from `X-Forwarded-For` only when `TRUST_PROXY=true`
- Return 429 `RATE_LIMITED` with `Retry-After`

### CSRF Protection (PUT)
- Require `Origin` matches `Host` (or `X-Forwarded-Host` when `TRUST_PROXY=true`)
- If `Origin` missing, allow only when `Host` is loopback
- On mismatch, return 403 `CSRF_BLOCKED`

### Error Codes

| Code | Meaning |
|------|---------|
| FEATURE_DISABLED | Feature flag off |
| INVALID_PARAM | Malformed input |
| SESSION_NOT_FOUND | Unknown or unauthorized session |
| PATH_OUTSIDE_ROOT | Path escapes root |
| SYMLINK_NOT_ALLOWED | Symlink in path or target |
| DIR_NOT_FOUND | `dir` does not exist |
| NOT_A_DIRECTORY | `dir` exists but is not a directory |
| FILE_NOT_FOUND | File does not exist |
| NOT_REGULAR_FILE | Target is not a regular file |
| FILE_FORBIDDEN | Blocked extension |
| FILE_TOO_LARGE | Size exceeds limit |
| UNSUPPORTED_ENCODING | Non-UTF-8 content |
| UNSUPPORTED_MEDIA_TYPE | Missing/invalid Content-Type |
| ETAG_MISMATCH | Optimistic lock failed |
| CSRF_BLOCKED | Origin/Host mismatch |
| RATE_LIMITED | Too many requests |
| PERMISSION_DENIED | OS permission error |
| INTERNAL_ERROR | Server error |

### ETag Format
- `sha256:<hex>` of raw file bytes (64 hex chars)

---

## Endpoints

### GET /api/files

List files under session's project root.

**Query Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| sessionId | string | yes | - | Session ID (1-128 chars) |
| dir | string | no | "" | Subdirectory (relative) |
| recursive | boolean | no | true | Include subdirectories |
| limit | integer | no | 2000 | Max results (1-10000) |
| ext | string | no | - | Comma-separated extensions |
| includeHidden | boolean | no | false | Include dot-files/dirs |
| includeIgnored | boolean | no | false | Include ignored dirs |

**Boolean Parsing:** `true|false|1|0` (case-insensitive)

**Extension Filter:** Items must start with `.`, 1-16 chars, case-insensitive

**Ignored Directories:** `.git`, `.hg`, `.svn`, `node_modules`, `dist`, `build`, `.next`, `.turbo`, `.cache`

**Traversal:**
- Depth-first, lexicographic sort per directory
- Do not follow symlinks; count in `skipped.symlink`
- Stop at `limit`; set `truncated=true`
- If `dir` unreadable, return 403 `PERMISSION_DENIED`

**Response 200:**
```json
{
  "files": [
    {
      "path": "src/index.ts",
      "name": "index.ts",
      "size": 1234,
      "mtimeMs": 1713371123123,
      "isEditable": true,
      "notEditableReason": null
    }
  ],
  "truncated": false,
  "skipped": {
    "permissionDenied": 0,
    "notRegularFile": 0,
    "ignored": 0,
    "hidden": 0,
    "symlink": 0
  }
}
```

**Error Responses:**

| Code | Error Code | Condition |
|------|------------|-----------|
| 400 | INVALID_PARAM | Bad query params |
| 400 | NOT_A_DIRECTORY | `dir` not a directory |
| 403 | PATH_OUTSIDE_ROOT | Path escapes root |
| 403 | SYMLINK_NOT_ALLOWED | Symlink in path |
| 403 | PERMISSION_DENIED | OS denies access |
| 404 | DIR_NOT_FOUND | `dir` doesn't exist |
| 404 | SESSION_NOT_FOUND | Unknown session |
| 404 | FEATURE_DISABLED | Feature flag off |
| 429 | RATE_LIMITED | Too many requests |
| 500 | INTERNAL_ERROR | Server error |

### GET /api/file

Read file content.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| sessionId | string | yes | Session ID |
| path | string | yes | Relative path |

**Response 200:**
```json
{
  "content": "file text content",
  "mtimeMs": 1713371123123,
  "size": 1234,
  "encoding": "utf-8",
  "etag": "sha256:abcdef..."
}
```

**Error Responses:**

| Code | Error Code | Condition |
|------|------------|-----------|
| 400 | INVALID_PARAM | Bad params |
| 400 | NOT_REGULAR_FILE | Not a regular file |
| 403 | PATH_OUTSIDE_ROOT | Path escapes root |
| 403 | SYMLINK_NOT_ALLOWED | Symlink in path |
| 403 | FILE_FORBIDDEN | Blocked extension |
| 403 | PERMISSION_DENIED | OS denies read |
| 404 | FILE_NOT_FOUND | File doesn't exist |
| 404 | SESSION_NOT_FOUND | Unknown session |
| 404 | FEATURE_DISABLED | Feature flag off |
| 413 | FILE_TOO_LARGE | >1 MiB |
| 415 | UNSUPPORTED_ENCODING | Non-UTF-8 |
| 429 | RATE_LIMITED | Too many requests |
| 500 | INTERNAL_ERROR | Server error |

### PUT /api/file

Write file content with optimistic concurrency.

**Request Headers:**
- `Content-Type: application/json`

**Request Body:**
```json
{
  "sessionId": "string",
  "path": "relative/path/to/file",
  "content": "new text content",
  "expectedEtag": "sha256:abcdef..."
}
```

**Response 200:**
```json
{
  "success": true,
  "mtimeMs": 1713371199123,
  "size": 1250,
  "etag": "sha256:123456..."
}
```

**Write Rules:**
- `expectedEtag` required, must match `^sha256:[0-9a-f]{64}$`
- On mismatch, return 409 with `details: { currentEtag, mtimeMs, size }`
- Atomic write: temp file with `O_EXCL` → `fsync` → `chmod` → rename → `fsync` parent dir

**Error Responses:**

| Code | Error Code | Condition |
|------|------------|-----------|
| 400 | INVALID_PARAM | Bad params or invalid expectedEtag |
| 400 | NOT_REGULAR_FILE | Not a regular file |
| 403 | PATH_OUTSIDE_ROOT | Path escapes root |
| 403 | SYMLINK_NOT_ALLOWED | Symlink in path |
| 403 | FILE_FORBIDDEN | Blocked extension |
| 403 | PERMISSION_DENIED | OS denies write |
| 404 | FILE_NOT_FOUND | File doesn't exist |
| 404 | SESSION_NOT_FOUND | Unknown session |
| 404 | FEATURE_DISABLED | Feature flag off |
| 409 | ETAG_MISMATCH | File changed |
| 413 | FILE_TOO_LARGE | Content >1 MiB |
| 415 | UNSUPPORTED_ENCODING | Non-UTF-8 content |
| 415 | UNSUPPORTED_MEDIA_TYPE | Invalid Content-Type |
| 429 | RATE_LIMITED | Too many requests |
| 500 | INTERNAL_ERROR | Server error |

---

## Data Models

### Client State

```typescript
interface EditorFile {
  path: string
  content: string
  savedContent: string
  mtimeMs: number
  size: number
  etag: string
  encoding: "utf-8"
}

interface EditorState {
  isOpenBySession: Record<string, boolean>
  paneWidthBySession: Record<string, number>
  openFileBySession: Record<string, EditorFile | null>
  lastFileBySession: Record<string, string | null>

  setOpen(sessionId: string, open: boolean): void
  toggleOpen(sessionId: string): void
  setPaneWidth(sessionId: string, width: number): void
  openFile(sessionId: string, file: EditorFile): void
  updateContent(sessionId: string, content: string): void
  markSaved(sessionId: string, etag: string, mtimeMs: number, size: number): void
  closeFile(sessionId: string): void
  isDirty(sessionId: string): boolean
  clearSession(sessionId: string): void
}
```

### Persistence (localStorage)

- Key: `agentboard-editor:v1`
- Fields: `version`, `isOpenBySession`, `paneWidthBySession`, `lastFileBySession`
- On parse failure or version mismatch, discard and reset

### Server Models

```typescript
interface FileEntry {
  path: string
  name: string
  size: number
  mtimeMs: number
  isEditable: boolean
  notEditableReason: "too_large" | "blocked_ext" | null
}
```

---

## Security Considerations

- Enforce session ownership for all endpoints
- Strict path normalization with root confinement and separator boundary enforcement
- Symlink rejection with FD-based open when supported; log residual risk if fallback used
- Block binary extensions and files >1 MiB
- Reject non-UTF-8 content on read/write
- CSRF checks for PUT; allow missing Origin only on loopback
- Same-origin only; no CORS headers
- Rate limiting applied before session validation using fallback session key
- Do not log file contents; log path and sizes only

---

## Error Handling Strategy

| Error | UI Behavior |
|-------|-------------|
| 409 ETAG_MISMATCH | Modal: "File changed on disk" with Reload/Cancel |
| 413 FILE_TOO_LARGE | Banner: "File too large (1 MiB max)"; gray in picker |
| 415 UNSUPPORTED_ENCODING | Banner: "Unsupported encoding (UTF-8 only)" |
| 403 FILE_FORBIDDEN | Banner: "Blocked file type" |
| 403 PERMISSION_DENIED | Banner: "Permission denied" |
| 404 FILE_NOT_FOUND | Toast; clear open file |
| 404 FEATURE_DISABLED | Hide pane; show info tooltip |
| 429 RATE_LIMITED | Toast with retry hint; no auto-retry for saves |
| Session ended while dirty | Toast: "Session ended; unsaved changes were discarded" |
| Network error | Banner: "Save failed" with Retry button |

---

## Performance Requirements

| Metric | Target |
|--------|--------|
| File list p95 (2k files) | < 300ms |
| File list p95 (10k files) | < 800ms |
| File read p95 (≤200KB) | < 150ms |
| File read p95 (≤1MB) | < 400ms |
| File write p95 (≤200KB) | < 200ms |
| CodeMirror init p95 (desktop) | < 500ms |
| CodeMirror init p95 (mobile) | < 900ms |
| Main thread tasks | < 50ms |
| Editor bundle (gzipped) | < 200KB |

### Bundle Optimization

- Lazy-load CodeMirror on first pane open
- Dynamic import language modes by extension:
  - `.md` → `@codemirror/lang-markdown`
  - `.ts`, `.tsx`, `.js`, `.jsx` → `@codemirror/lang-javascript`
  - `.json` → `@codemirror/lang-json`
  - `.css` → `@codemirror/lang-css`
  - `.html` → `@codemirror/lang-html`
  - `.yaml`, `.yml` → `@codemirror/lang-yaml`
  - Others → plain text

---

## Observability

### Backend Logs (structured JSON)
- Fields: `requestId`, `sessionId`, `path`, `status`, `durationMs`, `errorCode`, `remoteIP`

### Backend Metrics
- `editor_requests_total{endpoint,status}`
- `editor_file_read_latency_ms` (p50/p95/p99)
- `editor_file_write_latency_ms` (p50/p95/p99)
- `editor_rate_limited_total`

### Alerting
- 5xx rate > 2% for 5 minutes on any editor endpoint
- p95 read/write latency > 500ms for 10 minutes
- `editor_rate_limited_total` spikes > 100/min

### Client Telemetry
- `editor_save_success`, `editor_save_failure{code}`
- `editor_time_to_first_edit_ms`
- Emit to console in dev; backend sink if available

---

## Testing Strategy

### Backend Tests
- Path normalization: empty segments, `.`/`..`, encoded separators, root prefix collision
- Symlink rejection with FD-based and fallback approaches
- Permission denied on `dir` vs traversal skip+count
- Size limits: exactly 1 MiB, >1 MiB, request body size cap
- UTF-8 decoding: valid, invalid bytes
- ETag mismatch details
- Rate limiting with invalid sessionId
- CSRF rules: Origin mismatch, loopback exception

### Frontend Tests
- editorStore: per-session persistence, dirty tracking, session cleanup
- FilePicker: fuzzy search scoring, disabled entries, cache behavior
- EditorPane: save flow, conflict modal, error banners, session-end toast
- ResizeHandle: mouse drag, touch drag, small-screen disable
- Keyboard: Cmd+E toggle, Cmd+S save

### E2E Tests (Playwright/dev-browser)
- Open pane, pick file, edit, save, verify disk change
- Conflict flow: external change triggers 409 and modal
- Mobile Safari emulation: layout and keyboard behavior

---

## Deployment Strategy

### Feature Flags
- Server: `EDITOR_PANE_ENABLED` env var (default: `false`)
- Client: `VITE_EDITOR_PANE_ENABLED` build var (default: `false`)
- If server disabled: return 404 `FEATURE_DISABLED`

### Rollout
1. Enable in development
2. Enable in staging with monitoring
3. Enable in production

### Rollback
- Set `EDITOR_PANE_ENABLED=false`
- Client hides pane on `FEATURE_DISABLED`

---

## Migration Plan

- No server-side migrations
- localStorage uses versioned key `agentboard-editor:v1`; older data ignored

---

## File Changes Summary

| File | Action |
|------|--------|
| `src/server/fileRoutes.ts` | Create |
| `src/server/pathValidator.ts` | Create |
| `src/server/index.ts` | Mount routes |
| `src/client/stores/editorStore.ts` | Create |
| `src/client/components/EditorPane.tsx` | Create |
| `src/client/components/FilePicker.tsx` | Create |
| `src/client/components/ResizeHandle.tsx` | Create |
| `src/client/App.tsx` | Add pane, shortcut |
| `src/client/styles/editor.css` | Create |
| `package.json` | Add dependencies |

---

## Dependencies

```json
{
  "codemirror": "^6.0.1",
  "@codemirror/lang-markdown": "^6.2.0",
  "@codemirror/lang-javascript": "^6.2.0",
  "@codemirror/lang-json": "^6.0.0",
  "@codemirror/lang-css": "^6.2.0",
  "@codemirror/lang-html": "^6.4.0",
  "@codemirror/lang-yaml": "^6.0.0",
  "@codemirror/state": "^6.4.0",
  "@codemirror/view": "^6.26.0"
}
```

---

## Open Questions / Future Considerations

- WebSocket file change notifications for external edits?
- Multi-file tabs per session?
- LSP integration and autocomplete?
- Optional paging for very large repos?
