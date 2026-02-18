# Technical Spec: Initial Message with Attachments in NewSessionModal

## Overview / Context

Add the ability to include an initial prompt and optional image attachments when creating a new session in agentboard. The goal is to mirror CLI flows like `claude "prompt"` and `codex "prompt" --image ./file.png`, while keeping the backend's upload handling centralized and safe.

## Goals

1. Allow users to enter an initial message during session creation
2. Allow users to attach one or more images (via drag-drop or file picker)
3. Generate correct CLI command strings for Claude and Codex with attachments
4. Validate uploads securely and handle errors gracefully

## Non-Goals

- Real-time image editing or preview beyond filename list
- Support for non-image file types (for now)
- Post-creation editing of initial messages or attachments

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      NewSessionModal                            │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐│
│  │ Initial Message  │  │ Attachments                          ││
│  │ ┌──────────────┐ │  │ ┌────────────────────────────────┐  ││
│  │ │ textarea     │ │  │ │ Drop zone / File picker        │  ││
│  │ └──────────────┘ │  │ └────────────────────────────────┘  ││
│  └──────────────────┘  │ [img1.png ✕] [img2.png ✕]           ││
│                        └──────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
         │                              │
         │                              │ POST /api/paste-image
         │                              ▼
         │                    ┌──────────────────┐
         │                    │ Backend          │
         │                    │ - Validate MIME  │
         │                    │ - Store in tmpdir│
         │                    │ - Return path    │
         │                    └──────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ getFullCommand(preset, modifiers, initialMessage, attachments)  │
│                                                                 │
│ Claude: claude "message\n\n/path/img1.png /path/img2.png"       │
│ Codex:  codex "message" --image /path/img1.png --image /path/.. │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
    onCreate(projectPath, name, command)
```

**Rationale:** Reusing `/api/paste-image` centralizes upload validation and avoids direct file handling in the frontend. The CLI expects file paths local to the backend environment, so backend storage is required.

## Component Design

### Backend (`src/server/index.ts`)

- `/api/paste-image` remains the single entry point for image uploads
- Storage directory: `${os.tmpdir()}/agentboard-uploads/`
- Cleanup strategy: On server startup, delete files older than 24h

**Tradeoff:** Startup-only cleanup is simpler than periodic; defers periodic cleanup to future if needed.

### Frontend (`src/client/components/NewSessionModal.tsx`)

**UI additions:**
- Initial Message `<textarea>` (optional, below Display Name)
- Attachments section with drag-drop zone and file picker button
- List of uploaded attachments with remove action

**New state:**
```typescript
interface Attachment {
  id: string       // UUID from server
  name: string     // Original filename
  path: string     // Server-side absolute path
  mime: string     // e.g., "image/png"
  size: number     // Bytes
}

const [initialMessage, setInitialMessage] = useState('')
const [attachments, setAttachments] = useState<Attachment[]>([])
const [uploadError, setUploadError] = useState<string | null>(null)
```

### Command Construction (`src/client/stores/settingsStore.ts`)

Extend `getFullCommand()` signature:

```typescript
function getFullCommand(
  preset: CommandPreset,
  initialMessage?: string,
  attachments?: Attachment[]
): string
```

**Claude format** (paths inside prompt string):
```bash
claude "Fix the bug shown here:

/tmp/agentboard-uploads/abc123.png /tmp/agentboard-uploads/def456.png"
```

**Codex format** (dedicated `--image` flags):
```bash
codex "Fix the bug shown here" --image /tmp/agentboard-uploads/abc123.png --image /tmp/agentboard-uploads/def456.png
```

## API Design

### POST `/api/paste-image`

**Request:**
- Content-Type: `multipart/form-data`
- Field: `image` (binary file)

**Response (200 OK):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "screenshot.png",
  "path": "/tmp/agentboard-uploads/550e8400-e29b-41d4-a716-446655440000.png",
  "mime": "image/png",
  "size": 245832
}
```

**Error Responses:**

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_FILE` | Missing `image` field in form data |
| 413 | `FILE_TOO_LARGE` | File exceeds 10 MB limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not an allowed image type |
| 500 | `UPLOAD_FAILED` | Filesystem write error |

**Error response schema:**
```json
{
  "error": {
    "code": "UNSUPPORTED_MEDIA_TYPE",
    "message": "Only image/png, image/jpeg, image/gif, image/webp are supported."
  }
}
```

**Allowed MIME types:**
- `image/png`
- `image/jpeg`
- `image/gif`
- `image/webp`

## Data Models

No persistent database changes. Temporary upload artifacts only:

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier, used as filename |
| `name` | string | Original filename (sanitized) |
| `path` | string | Absolute server-side path |
| `mime` | string | Validated MIME type |
| `size` | number | File size in bytes |

File naming convention: `{uuid}.{ext}` (e.g., `550e8400-e29b-41d4-a716-446655440000.png`)

## Infrastructure Requirements

- Backend filesystem must allow read/write to `${os.tmpdir()}`
- Cleanup permissions for removing old files
- No external services required

## Security Considerations

| Threat | Mitigation |
|--------|------------|
| Malicious file upload | Validate MIME type AND file extension server-side; reject non-images |
| Oversized uploads causing disk exhaustion | Enforce 10 MB max per file, 5 files max per session |
| Path traversal | Use UUID for filename, ignore client-supplied path components |
| Filename injection | Sanitize original filename; store separately from disk filename |
| Unauthorized access | Same auth/authz as existing API routes |
| Path disclosure | Paths are server-local; only useful for CLI on same machine |

**Future consideration:** Rate-limit uploads per client/session.

## Error Handling Strategy

**Backend:**
- Return structured JSON error with `code` and `message`
- Log errors with context (file size, MIME) but never raw file data

**Frontend:**
- Show inline error message for failed uploads
- Keep attachments list consistent (don't add failed uploads)
- Clear error on next successful upload

**Command construction:**
- If CLI type doesn't support attachments, fall back to base command
- Surface UI warning: "Attachments not supported for this command"

## Performance Requirements

| Metric | Target |
|--------|--------|
| Max file size | 10 MB per file |
| Max files per session | 5 |
| Upload response time | < 500ms for files ≤ 2 MB |
| Startup cleanup duration | < 2 seconds for ≤ 1,000 files |
| Cleanup threshold | Files older than 24 hours |

## Observability

**Logging:**
- Upload success: file ID, size, MIME type
- Upload failure: error code, file size, MIME type (no raw data)
- Cleanup summary on startup: files deleted count, errors count, duration

## Testing Strategy

### Unit Tests

**`src/client/stores/settingsStore.test.ts`:**
- `getFullCommand` with no initial message, no attachments
- `getFullCommand` with initial message only
- `getFullCommand` with 1 attachment (Claude format)
- `getFullCommand` with multiple attachments (Claude format)
- `getFullCommand` with attachments (Codex format with `--image` flags)
- `getFullCommand` escapes quotes in initial message

**`src/server/__tests__/pasteImage.test.ts`:**
- Accepts valid PNG upload
- Accepts valid JPEG upload
- Rejects non-image MIME type (returns 415)
- Rejects oversized file (returns 413)
- Rejects missing file field (returns 400)

### Integration Tests

- Full upload flow: POST file, verify response schema, verify file exists on disk
- Cleanup: create old files, restart server, verify deletion

### UI Tests (dev-browser skill)

- Drag-drop image onto modal uploads successfully
- File picker selection uploads successfully
- Remove button removes attachment from list
- Error state displays for failed upload
- Command preview shows correct format with attachments

## Deployment Strategy

1. **Deploy backend first:** New upload directory + validation + cleanup
2. **Deploy frontend:** UI changes to NewSessionModal
3. **Backward compatible:** Existing sessions unaffected; modal works without attachments

**Rollback:** Remove frontend changes; backend endpoint remains safe and unused.

## Migration Plan

None required. Existing `/tmp/` files from old endpoint are left as-is (will be cleaned by OS eventually). New uploads go to new directory.

## Files Changed

| File | Changes |
|------|---------|
| `src/server/index.ts` | Update `/api/paste-image`: new directory, validation, response schema, cleanup on startup |
| `src/client/components/NewSessionModal.tsx` | Add textarea, drag-drop zone, file picker, attachment list, upload handling |
| `src/client/stores/settingsStore.ts` | Extend `getFullCommand()` to accept initialMessage and attachments |
| `src/server/__tests__/pasteImage.test.ts` | New test file for upload endpoint |
| `src/client/stores/settingsStore.test.ts` | Add tests for command construction with attachments |

## Open Questions / Future Considerations

- Should Claude also support `--image` flag if CLI adds it later? (Monitor CLI updates)
- Periodic cleanup (setInterval) vs startup-only? (Defer unless disk issues arise)
- Support for non-image files (PDFs, text files)?
- Thumbnail previews for attached images?
