# File Reference Detection Feature Plan

> Revised after adversarial review by GPT-5.2 Codex (xhigh reasoning)

## Overview

Detect file paths/names in terminal output and allow opening them in a configurable editor. Similar to current URL detection but with server-side validation and search.

## Goals and Non-Goals

**Goals:**
- Fast client hover detection
- Accurate server resolution within project boundaries
- Safe open behavior with editor selection
- Clear UI feedback for no-match and multi-match cases

**Non-Goals:**
- Server-side annotation of stream content
- Indexing the entire repo in advance
- Windows path support (this iteration)
- Editing within the same tmux pane

## Architecture

**Hybrid approach:**
- **Client**: Regex-based link detection (fast, responsive)
- **Server**: Validates on-demand, executes open commands

**Rationale**: Keeps streaming path low-latency while ensuring authoritative filesystem validation and safe command execution.

## How "Open" Would Work

### For GUI Editors (VS Code, Cursor, Zed)
Server spawns command directly via `spawn` with args array (no shell):
```bash
code --goto /path/to/file.ts:42:10
```

### For Terminal Editors (vim, nvim, etc.)
- **New tmux pane** - Split current window (configurable)
- **New tmux window** - Create window in same session

### For "Copy to Clipboard"
Server executes `pbcopy` (macOS), `xclip`, or `wl-copy` (Linux) with the path.

## Detection Patterns

```typescript
const FILE_PATH_REGEX = /(?:
  (?:\/[\w.-]+)+                      // Absolute: /foo/bar/baz.ts
  |~\/[\w./-]+                        // Home-relative: ~/foo/bar.ts
  |(?:\.\.?\/)?[\w.-]+(?:\/[\w.-]+)+  // Relative: ./foo/bar.ts, src/foo.ts
)(?:[:(](\d+)(?:[,:](\d+))?\)?)?/     // Optional :line:col or (line,col)
```

Also detect `a/` and `b/` prefixes from git diff output.

## API Design (WebSocket)

All messages include `requestId` and `sessionId` for correlation and scoping.

### Client → Server: Resolve
```typescript
type FileResolveRequest = {
  type: 'file:resolve'
  requestId: string
  sessionId: string
  text: string  // max 400 chars
}
```

### Server → Client: Resolved
```typescript
type FileResolveResponse = {
  type: 'file:resolved'
  requestId: string
  sessionId: string
  status: 'ok' | 'error'
  matches?: FileMatch[]
  error?: FileError
  warnings?: string[]  // e.g., 'multiple_matches'
}
```

### Client → Server: Open
```typescript
type FileOpenRequest = {
  type: 'file:open'
  requestId: string
  sessionId: string
  path: string  // absolute path from matches
  line?: number
  column?: number
}
```

### Server → Client: Opened
```typescript
type FileOpenResponse = {
  type: 'file:opened'
  requestId: string
  sessionId: string
  status: 'ok' | 'error'
  error?: FileError
}
```

### Error Codes
```typescript
type FileError = {
  code:
    | 'BAD_REQUEST'           // Invalid input
    | 'NOT_FOUND'             // File doesn't exist
    | 'OUT_OF_ROOT'           // Path traversal attempt
    | 'SEARCH_TIMEOUT'        // Glob search too slow
    | 'UNSUPPORTED_EDITOR'    // Editor binary not found
    | 'EXEC_FAILED'           // Command failed
    | 'TMUX_FAILED'           // Tmux command failed
    | 'CLIPBOARD_UNAVAILABLE' // No clipboard utility
  message: string
}
```

## Data Models

```typescript
type FileMatch = {
  absolutePath: string
  relativePath: string      // relative to sessionRoot
  line?: number
  column?: number
  isExactPath: boolean      // true if resolved by explicit path
  score: number             // lower = better (shorter relative path)
}
```

## Security Considerations

1. **Path traversal protection**: Resolve/realpath and reject paths outside `sessionRoot` with `OUT_OF_ROOT`
2. **Input validation**: `text` length <= 400 chars, reject null bytes, normalize Unicode
3. **No shell interpolation**: Use `spawn` with args array; custom command parsed into tokens with safe placeholder substitution
4. **Rate limiting**: 10 requests/sec per session, client debounce >= 200ms on hover
5. **Open validation**: Only allow `file:open` for matches returned by server or absolute paths within root

## Performance Requirements

| Operation | Target | Timeout |
|-----------|--------|---------|
| Client regex scan per line | < 2ms | - |
| Server resolve (explicit path) | < 50ms | - |
| Server resolve (filename search) | < 500ms | 1s |
| Resolution cache TTL | 60s | - |

## Error Handling

| Scenario | Error Code | User Message |
|----------|------------|--------------|
| Invalid input | `BAD_REQUEST` | "Invalid file reference" |
| File not found | `NOT_FOUND` | "File not found" |
| Outside project | `OUT_OF_ROOT` | "File outside project" |
| Search too slow | `SEARCH_TIMEOUT` | "Search timed out" |
| Editor not installed | `UNSUPPORTED_EDITOR` | "Editor not found: {editor}" |
| Command failed | `EXEC_FAILED` | "Failed to open file" |
| Tmux error | `TMUX_FAILED` | "Could not open in tmux" |
| No clipboard | `CLIPBOARD_UNAVAILABLE` | "Clipboard not available" |

## Settings

```typescript
interface Settings {
  fileOpenEditor: 'code' | 'cursor' | 'zed' | 'vim' | 'nvim' | 'emacs' | 'default' | 'copy' | 'custom'
  fileOpenCustomCommand?: string  // Template: {file} {line} {col}
  fileOpenTerminalMode: 'pane' | 'window'
}
```

**Editor commands:**
| Editor | Command |
|--------|---------|
| code | `code --goto {file}:{line}:{col}` |
| cursor | `cursor --goto {file}:{line}:{col}` |
| zed | `zed {file}:{line}` |
| vim | `vim +{line} {file}` |
| nvim | `nvim +{line} {file}` |
| default | `open {file}` (macOS) |
| copy | `pbcopy` / `xclip` / `wl-copy` |

## Server Components

### FileResolver (`src/server/FileResolver.ts`)
```typescript
class FileResolver {
  constructor(private sessionRoot: string) {}

  async resolve(text: string, cwd: string): Promise<FileMatch[]>
  private parseFileReference(text: string): ParsedRef
  private async searchForFile(filename: string, cwd: string): Promise<string[]>
  private isWithinRoot(absolutePath: string): boolean
}
```

**Resolution logic:**
1. Validate input (length, null bytes)
2. Parse into path + line + col
3. If absolute → realpath, check within root, check exists
4. If relative → resolve against cwd, check within root, check exists
5. If bare filename → glob search (honor .gitignore), return up to 10 matches sorted by proximity

### FileOpener (`src/server/FileOpener.ts`)
```typescript
class FileOpener {
  async open(path: string, line?: number, col?: number, settings: Settings, sessionId: string): Promise<void>

  private buildCommand(editor: string, path: string, line?: number, col?: number): string[]
  private isTerminalEditor(editor: string): boolean
  private openInTmuxPane(args: string[], sessionId: string): Promise<void>
  private copyToClipboard(path: string): Promise<void>
}
```

## Client Components

### Custom Link Provider
```typescript
terminal.registerLinkProvider({
  provideLinks(bufferLineNumber, callback) {
    // Scan line with FILE_PATH_REGEX
    // Return ILink objects with hover/activate handlers
    // Handle request cancellation on cursor move
  }
})
```

### Tooltip States
1. **Resolving**: Spinner + "Resolving..."
2. **Single match**: `/full/path/file.ts:42` + "⌘+click to open"
3. **Multiple matches**: Clickable list (max 10)
4. **No matches**: "File not found" (dimmed)
5. **Error**: Error message from server

## Observability

**Logging (debug level):**
- Resolution time
- Match counts
- Open failures with error codes

**Metrics:**
- `file_resolve_duration_ms`
- `file_resolve_errors_total{code}`
- `file_open_errors_total{code}`

## Implementation Steps

1. **FileResolver service** - Path parsing, validation, search with root boundary
2. **FileOpener service** - Safe command execution via spawn
3. **WebSocket handlers** - `file:resolve` and `file:open` with error handling
4. **Client link provider** - Regex detection, debounced hover, request cancellation
5. **Async tooltip** - Loading state, multi-match picker, error display
6. **Settings UI** - Editor selection dropdown

## Files to Modify/Create

**New files:**
- `src/server/FileResolver.ts`
- `src/server/FileOpener.ts`
- `src/shared/fileTypes.ts` (message types, FileMatch, FileError)

**Modify:**
- `src/server/index.ts` - WebSocket handlers
- `src/shared/types.ts` - Settings additions
- `src/client/hooks/useTerminal.ts` - Link provider, tooltip
- `src/client/components/SettingsModal.tsx` - Editor setting

## Testing

**Unit tests:**
- FileResolver parsing: `path:line:col`, `path(line,col)`, `a/`/`b/` prefixes, `~/`, `../`
- Out-of-root rejection
- Search with ignore patterns
- FileOpener command generation (mocked spawn)

**Integration tests:**
- WebSocket flow with concurrent requests
- Request cancellation

**UI tests:**
- Async hover resolution
- Cursor move cancellation
- Multi-match picker
- Error tooltip display

## Migration

- Settings: On first run, default `fileOpenEditor="default"` and `fileOpenTerminalMode="pane"`
- No data migration needed

## Future Considerations

- Directory opening (open folder in editor)
- Windows path support + `clip.exe`
- Server-side repo file list caching for faster searches
- Cache resolved files per session for quick re-access
