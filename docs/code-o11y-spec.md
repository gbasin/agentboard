# code-o11y: Observability for AI Coding Agents

**Status:** Draft
**Created:** 2026-01-27
**Stack:** TypeScript/Bun

---

## Overview

A standalone observability platform/library specifically for AI coding agents (Claude Code, Codex CLI, Cursor, Windsurf, etc.). Unlike general LLM observability tools (Langfuse, Phoenix), this focuses on metrics unique to coding workflows: test pass rates, file modifications, git integration, code acceptance rates.

### Goals

- **Raw-first storage**: Preserve every field from agent logs, never lose data
- **Pluggable parsers**: Support multiple agent formats via adapter plugins
- **Pluggable storage**: SQLite (default), DuckDB, Postgres, etc.
- **Pre-computed analytics**: Normalized tables with schema versioning
- **Coding-specific insights**: File heatmaps, tool success rates, test outcomes
- **Full-text search**: Find conversations across all history
- **Basic dashboard**: Web UI for exploration and analysis

### Non-Goals (MVP)

- Real-time OTLP ingestion (future)
- Multi-user/team support (future)
- Cloud sync (future)
- Integration with external platforms like Langfuse (standalone only)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INGESTION LAYER                               │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │ File Watcher │    │ Import CLI   │    │ OTLP Receiver│          │
│  │ (daemon)     │    │ (historical) │    │ (future)     │          │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘          │
│         │                   │                   │                   │
│         ▼                   ▼                   ▼                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    PARSER PLUGINS                            │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────┐  │   │
│  │  │ Claude  │ │ Codex   │ │ Cursor  │ │Windsurf │ │ etc.  │  │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └───────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      RAW STORAGE (immutable)                        │
│                   raw_records, sessions_raw                         │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   NORMALIZATION SERVICE                             │
│              (pre-computed, schema-versioned)                       │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 NORMALIZED TABLES + FTS INDEX                       │
│          sessions, messages, tool_calls, file_ops, test_runs       │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       STORAGE ADAPTERS                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ SQLite   │  │ DuckDB   │  │ Postgres │  │ClickHouse│            │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘            │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         QUERY LAYER                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ REST API     │  │ Full-Text    │  │ Analytics    │              │
│  │ (Hono)       │  │ Search (FTS5)│  │ Queries      │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        WEB DASHBOARD                                 │
│  Sessions | Search | File Heatmap | Tool Analytics | Cost Tracking  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Layer 1: Raw Storage (Immutable)

Raw records preserve the exact JSONL from each agent, never losing fields.

```sql
CREATE TABLE raw_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,           -- 'claude', 'codex', 'cursor', etc.
  source_file TEXT NOT NULL,          -- Original JSONL file path
  line_number INTEGER NOT NULL,
  ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  raw JSON NOT NULL                   -- THE FULL JSONL LINE, untouched
);

CREATE TABLE sessions_raw (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  file_mtime DATETIME,                -- For change detection
  ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  raw_metadata JSON                   -- First/last record metadata
);

CREATE INDEX idx_raw_session ON raw_records(session_id);
CREATE INDEX idx_raw_agent ON raw_records(agent_type);
CREATE INDEX idx_raw_timestamp ON raw_records(ingested_at);
```

### Layer 2: Normalized Tables (Pre-computed, Versioned)

Normalized tables are materialized from raw records with schema versioning.

```sql
-- Schema version tracking
CREATE TABLE schema_versions (
  entity TEXT PRIMARY KEY,            -- 'sessions', 'messages', 'tool_calls', etc.
  version INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Normalized sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  project_path TEXT,
  project_name TEXT,
  git_branch TEXT,
  git_commit TEXT,
  cwd TEXT,
  started_at DATETIME,
  ended_at DATETIME,
  status TEXT,                        -- 'active', 'completed', 'error'

  -- Aggregated metrics (denormalized for query speed)
  message_count INTEGER,
  user_message_count INTEGER,
  tool_call_count INTEGER,
  token_input INTEGER,
  token_output INTEGER,
  token_cache_read INTEGER,
  token_cache_write INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,

  -- Schema tracking
  schema_version INTEGER NOT NULL,
  normalized_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (id) REFERENCES sessions_raw(id)
);

-- Normalized messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  raw_record_id TEXT NOT NULL,        -- Link back to raw
  session_id TEXT NOT NULL,

  role TEXT NOT NULL,                 -- 'user', 'assistant', 'system'
  content TEXT,
  thinking_content TEXT,              -- Extended thinking (Claude)
  thinking_summary TEXT,              -- Thinking summary
  timestamp DATETIME,
  token_count INTEGER,
  cost_usd REAL,

  -- Message metadata
  is_tool_result BOOLEAN DEFAULT FALSE,
  is_error BOOLEAN DEFAULT FALSE,

  schema_version INTEGER NOT NULL,
  normalized_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (raw_record_id) REFERENCES raw_records(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Normalized tool calls
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  raw_record_id TEXT NOT NULL,
  message_id TEXT,
  session_id TEXT NOT NULL,

  tool TEXT NOT NULL,                 -- 'Read', 'Write', 'Edit', 'Bash', 'Glob', etc.
  input JSON,                         -- Normalized input structure
  output TEXT,
  output_truncated BOOLEAN DEFAULT FALSE,
  status TEXT,                        -- 'success', 'error', 'rejected', 'pending'
  error_message TEXT,
  duration_ms INTEGER,
  timestamp DATETIME,

  -- Coding-specific fields
  file_path TEXT,
  file_paths JSON,                    -- For multi-file operations
  lines_added INTEGER,
  lines_removed INTEGER,
  language TEXT,
  accepted BOOLEAN,                   -- User accepted the change?

  -- Bash-specific
  command TEXT,
  exit_code INTEGER,

  schema_version INTEGER NOT NULL,
  normalized_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (raw_record_id) REFERENCES raw_records(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- File operations (derived from tool_calls for analysis)
CREATE TABLE file_operations (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  session_id TEXT NOT NULL,

  operation TEXT NOT NULL,            -- 'read', 'write', 'edit', 'delete', 'glob', 'grep'
  file_path TEXT NOT NULL,
  language TEXT,
  lines_added INTEGER,
  lines_removed INTEGER,
  accepted BOOLEAN,
  timestamp DATETIME,

  schema_version INTEGER NOT NULL,

  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id)
);

-- Test runs (extracted from Bash tool calls)
CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT,
  session_id TEXT NOT NULL,

  command TEXT,
  framework TEXT,                     -- 'jest', 'pytest', 'vitest', etc.
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  total INTEGER,
  duration_ms INTEGER,
  success BOOLEAN,
  timestamp DATETIME,

  schema_version INTEGER NOT NULL
);

-- Full-text search index
CREATE VIRTUAL TABLE messages_fts USING fts5(
  session_id,
  content,
  thinking_content,
  tokenize='porter'
);
```

---

## Parser Plugin Interface

```typescript
interface ParserPlugin {
  /** Unique identifier for this parser */
  name: string  // 'claude' | 'codex' | 'cursor' | 'windsurf' | ...

  /** Human-readable display name */
  displayName: string

  /** Default paths to watch for this agent's logs */
  defaultPaths: string[]  // e.g., ['~/.claude/projects']

  /** Check if a file belongs to this parser */
  canParse(filePath: string): boolean

  /** Extract session ID from file path */
  extractSessionId(filePath: string): string

  /** Parse a JSONL file into raw records */
  parseFile(filePath: string): AsyncIterable<{
    lineNumber: number
    timestamp?: Date
    recordType?: string       // Agent-specific type hint
    raw: Record<string, any>  // The full parsed JSON line
  }>

  /** Extract searchable text for FTS indexing */
  extractSearchableText(raw: Record<string, any>): string | null
}

interface Normalizer {
  /** Convert raw record to normalized message */
  toMessage(raw: RawRecord): NormalizedMessage | null

  /** Extract tool calls from raw record */
  toToolCalls(raw: RawRecord): NormalizedToolCall[]

  /** Extract file operations from tool call */
  toFileOperations(toolCall: NormalizedToolCall): FileOperation[]

  /** Detect and parse test run from Bash command */
  toTestRun(toolCall: NormalizedToolCall): TestRun | null

  /** Aggregate session metadata from all raw records */
  toSession(sessionId: string, raws: RawRecord[]): NormalizedSession
}
```

---

## Storage Adapter Interface

```typescript
interface StorageAdapter {
  // Initialization
  initialize(): Promise<void>
  close(): Promise<void>

  // Raw record operations
  insertRawRecords(records: RawRecord[]): Promise<void>
  getRawRecords(sessionId: string): Promise<RawRecord[]>
  getRawRecord(id: string): Promise<RawRecord | null>

  // Session operations
  upsertSessionRaw(session: SessionRaw): Promise<void>
  getSessionRaw(sessionId: string): Promise<SessionRaw | null>
  getSessionsByMtime(since: Date): Promise<SessionRaw[]>

  // Normalized operations
  insertSession(session: NormalizedSession): Promise<void>
  insertMessages(messages: NormalizedMessage[]): Promise<void>
  insertToolCalls(toolCalls: NormalizedToolCall[]): Promise<void>
  insertFileOperations(fileOps: FileOperation[]): Promise<void>
  insertTestRuns(testRuns: TestRun[]): Promise<void>

  deleteNormalizedForSession(sessionId: string): Promise<void>

  // Query operations
  getSessions(filter: SessionFilter): Promise<NormalizedSession[]>
  getSession(sessionId: string): Promise<NormalizedSession | null>
  getMessages(sessionId: string): Promise<NormalizedMessage[]>
  getToolCalls(filter: ToolCallFilter): Promise<NormalizedToolCall[]>

  // Search
  searchMessages(query: string, options?: SearchOptions): Promise<SearchResult[]>

  // Schema versioning
  getSchemaVersions(): Promise<Record<string, number>>
  setSchemaVersions(versions: Record<string, number>): Promise<void>
  getOutdatedSessions(entity: string, currentVersion: number): Promise<string[]>

  // Analytics queries
  getMetricsSummary(timeRange: TimeRange): Promise<MetricsSummary>
  getTokenUsage(groupBy: 'day' | 'week' | 'agent', timeRange: TimeRange): Promise<TokenUsage[]>
  getCostBreakdown(groupBy: 'agent' | 'project', timeRange: TimeRange): Promise<CostBreakdown[]>
  getToolStats(timeRange: TimeRange): Promise<ToolStats[]>
  getFileHeatmap(limit: number): Promise<FileHeatmapEntry[]>
  getAcceptanceRate(groupBy: 'language' | 'tool'): Promise<AcceptanceRate[]>
}
```

---

## Ingestion Modes

### 1. Daemon Mode (File Watcher)

Background process that monitors log directories for changes.

```typescript
interface DaemonConfig {
  watchPaths: {
    path: string        // e.g., '~/.claude/projects'
    parser: string      // e.g., 'claude'
  }[]
  storage: StorageAdapter
  pollInterval?: number  // ms, for polling fallback
  useNativeWatch?: boolean  // fs.watch vs polling
}

class CodeO11yDaemon {
  constructor(config: DaemonConfig)

  start(): Promise<void>
  stop(): Promise<void>

  // Events
  on(event: 'session:new', handler: (session: Session) => void): void
  on(event: 'session:updated', handler: (session: Session) => void): void
  on(event: 'error', handler: (error: Error) => void): void
}
```

### 2. Import Mode (Historical)

One-time import of existing logs.

```typescript
interface ImportOptions {
  /** Only import sessions newer than this */
  since?: Date
  /** Re-import even if already ingested */
  force?: boolean
  /** Progress callback */
  onProgress?: (current: number, total: number) => void
}

class CodeO11yImporter {
  constructor(storage: StorageAdapter, parsers: ParserPlugin[])

  /** Import all logs from a directory */
  importDirectory(path: string, parser: string, options?: ImportOptions): Promise<ImportResult>

  /** Import a single file */
  importFile(path: string, parser: string): Promise<ImportResult>

  /** Auto-detect and import from all known agent paths */
  importAll(options?: ImportOptions): Promise<ImportResult>
}

interface ImportResult {
  sessionsImported: number
  sessionsSkipped: number
  recordsImported: number
  errors: { file: string, error: string }[]
  duration: number
}
```

---

## Normalization Service

Handles pre-computation of normalized tables with schema versioning.

```typescript
const SCHEMA_VERSIONS = {
  sessions: 1,
  messages: 1,
  tool_calls: 1,
  file_operations: 1,
  test_runs: 1,
} as const

class NormalizationService {
  constructor(
    storage: StorageAdapter,
    normalizers: Map<string, Normalizer>
  )

  /** Normalize a newly ingested session */
  normalizeSession(sessionId: string): Promise<void>

  /** Re-normalize all sessions with outdated schema */
  renormalizeOutdated(): Promise<{ updated: number, errors: number }>

  /** Force re-normalize specific sessions */
  renormalizeSessions(sessionIds: string[]): Promise<void>

  /** Check if any schema versions changed */
  hasSchemaChanges(): Promise<boolean>
}
```

### On Startup

```typescript
async function onStartup(
  storage: StorageAdapter,
  normalizer: NormalizationService
) {
  if (await normalizer.hasSchemaChanges()) {
    console.log('Schema version changed, re-normalizing...')
    const { updated, errors } = await normalizer.renormalizeOutdated()
    console.log(`Re-normalized ${updated} sessions (${errors} errors)`)
  }
}
```

---

## API Design

### REST Endpoints

```
# Sessions
GET  /api/sessions                      List sessions (paginated, filterable)
GET  /api/sessions/:id                  Get session details
GET  /api/sessions/:id/messages         Get messages for session
GET  /api/sessions/:id/tool-calls       Get tool calls for session
GET  /api/sessions/:id/raw              Get raw records for session

# Search
GET  /api/search?q=auth&limit=50        Full-text search across messages

# Analytics
GET  /api/metrics/summary               Dashboard summary stats
GET  /api/metrics/tokens                Token usage over time
GET  /api/metrics/costs                 Cost breakdown
GET  /api/metrics/tools                 Tool usage statistics
GET  /api/metrics/files                 Most modified files (heatmap)
GET  /api/metrics/acceptance            Edit acceptance rate
GET  /api/metrics/tests                 Test pass/fail rates

# System
GET  /api/health                        Health check
GET  /api/status                        Ingestion status, schema versions
POST /api/import                        Trigger manual import
POST /api/renormalize                   Force re-normalization
```

### WebSocket (Live Dashboard)

```
WS /api/live
  -> { type: 'session:new', session: Session }
  -> { type: 'session:updated', session: Session }
  -> { type: 'metrics:updated', metrics: Metrics }
```

---

## MVP Analytics

### Summary Metrics

```sql
-- Sessions by agent type
SELECT agent_type, COUNT(*) as count
FROM sessions
WHERE started_at > datetime('now', '-7 days')
GROUP BY agent_type;

-- Total token usage
SELECT
  SUM(token_input) as total_input,
  SUM(token_output) as total_output,
  SUM(cost_usd) as total_cost
FROM sessions
WHERE started_at > datetime('now', '-7 days');
```

### Tool Success Rate

```sql
SELECT
  tool,
  COUNT(*) as total,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as succeeded,
  ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 1) as success_rate
FROM tool_calls
WHERE timestamp > datetime('now', '-7 days')
GROUP BY tool
ORDER BY total DESC;
```

### File Heatmap

```sql
SELECT
  file_path,
  COUNT(*) as modifications,
  SUM(lines_added) as total_added,
  SUM(lines_removed) as total_removed,
  SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) as accepted_count
FROM file_operations
GROUP BY file_path
ORDER BY modifications DESC
LIMIT 50;
```

### Edit Acceptance Rate

```sql
SELECT
  language,
  COUNT(*) as total,
  SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) as accepted,
  ROUND(100.0 * SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) as acceptance_rate
FROM file_operations
WHERE operation = 'edit'
GROUP BY language
ORDER BY total DESC;
```

### Test Pass Rate

```sql
SELECT
  framework,
  COUNT(*) as runs,
  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as passed_runs,
  SUM(passed) as total_passed,
  SUM(failed) as total_failed,
  ROUND(100.0 * SUM(passed) / NULLIF(SUM(passed) + SUM(failed), 0), 1) as pass_rate
FROM test_runs
WHERE timestamp > datetime('now', '-7 days')
GROUP BY framework;
```

---

## Dashboard Views

| View | Description |
|------|-------------|
| **Overview** | Session count, token usage, cost, active agents (last 7d) |
| **Sessions** | List/search sessions, click to drill into details |
| **Session Detail** | Messages, tool calls, file changes, timeline |
| **Search** | Full-text search across all messages with snippets |
| **Files** | Heatmap of most-modified files, acceptance rates |
| **Tools** | Tool usage breakdown, success rates, duration |
| **Costs** | Cost over time, by agent, by project |
| **Tests** | Test run history, pass/fail trends |

---

## Project Structure

```
code-o11y/
├── packages/
│   ├── core/                     # Main library
│   │   ├── src/
│   │   │   ├── parsers/          # Parser plugins
│   │   │   │   ├── interface.ts  # Parser & Normalizer interfaces
│   │   │   │   ├── claude.ts
│   │   │   │   ├── codex.ts
│   │   │   │   ├── cursor.ts
│   │   │   │   ├── windsurf.ts
│   │   │   │   └── index.ts
│   │   │   ├── storage/          # Storage adapters
│   │   │   │   ├── interface.ts
│   │   │   │   ├── sqlite.ts
│   │   │   │   ├── duckdb.ts
│   │   │   │   └── index.ts
│   │   │   ├── ingestion/        # Daemon + importer
│   │   │   │   ├── daemon.ts
│   │   │   │   ├── importer.ts
│   │   │   │   └── watcher.ts
│   │   │   ├── normalization/    # Normalization service
│   │   │   │   ├── service.ts
│   │   │   │   ├── versions.ts
│   │   │   │   └── index.ts
│   │   │   ├── analytics/        # Computed metrics
│   │   │   │   └── queries.ts
│   │   │   ├── api/              # REST API (Hono)
│   │   │   │   ├── routes.ts
│   │   │   │   └── server.ts
│   │   │   ├── types.ts          # Shared types
│   │   │   └── index.ts          # Public API
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── dashboard/                # Web UI
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   ├── stores/
│       │   └── api/
│       ├── package.json
│       └── vite.config.ts
│
├── apps/
│   └── cli/                      # CLI tool
│       └── src/
│           └── index.ts          # code-o11y serve, import, status
│
├── package.json                  # Monorepo root (workspace)
├── turbo.json
└── README.md
```

---

## Supported Agent Formats

### Agent Format Summary

| Agent | Location | Format | Readable | Priority |
|-------|----------|--------|----------|----------|
| **Claude Code** | `~/.claude/projects/` | JSONL | Yes | P0 (MVP) |
| **Codex CLI** | `~/.codex/sessions/` | JSONL | Yes | P0 (MVP) |
| **Cursor** | `~/.cursor/chats/` | SQLite + JSON | Requires parsing | P1 |
| **Continue.dev** | `~/.continue/dev_data/` | JSONL | Yes | P1 |
| **Aider** | `.aider.chat.history.md` | Markdown | Yes | P2 |
| **Windsurf** | `~/.codeium/windsurf/` | Unknown | No | P2 |
| **Gemini CLI** | `~/.gemini/antigravity/` | Protobuf (.pb) | No (binary) | P2 |
| **OpenCode** | `~/.local/share/opencode/` | SQLite | Requires parsing | P2 |

---

### Claude Code (P0)

**Path:** `~/.claude/projects/<encoded-path>/*.jsonl`
**Session ID:** UUID from filename
**Format:** JSONL (one JSON object per line)

#### Record Types

| Type | Description |
|------|-------------|
| `user` | User input messages |
| `assistant` | Model responses |
| `system` | System events (compaction, etc.) |
| `summary` | Conversation summaries |
| `file-history-snapshot` | File state snapshots |
| `queue-operation` | Message queue events |

#### Top-Level Fields (All Records)

```typescript
interface ClaudeRawRecord {
  type: 'user' | 'assistant' | 'system' | 'summary' | 'file-history-snapshot' | 'queue-operation'
  uuid: string                    // UUIDv4
  parentUuid: string | null       // Parent record UUID
  sessionId: string               // Session identifier
  timestamp: string               // ISO 8601
  cwd: string                     // Working directory
  version: string                 // Claude Code version (e.g., "2.0.63")
  gitBranch?: string              // Git branch name
  slug?: string                   // Human-readable session name
  userType: string                // "external" for normal users
  isSidechain: boolean            // Parallel conversation thread
}
```

#### User Message Structure

```typescript
interface ClaudeUserRecord extends ClaudeRawRecord {
  type: 'user'
  message: {
    role: 'user'
    content: (TextBlock | ToolResultBlock)[]
  }
  isMeta?: boolean                // Metadata/instruction message
  thinkingMetadata?: {
    level: string
    disabled: boolean
    triggers: string[]
  }
  todos?: TodoItem[]              // Task list state
  toolUseResult?: string | object // Tool result summary
}

interface TextBlock {
  type: 'text'
  text: string
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string             // Matches tool_use block
  content: string | object
  is_error?: boolean
}
```

#### Assistant Message Structure

```typescript
interface ClaudeAssistantRecord extends ClaudeRawRecord {
  type: 'assistant'
  requestId: string               // API request ID
  message: {
    id: string                    // Message ID from API
    type: 'message'
    role: 'assistant'
    model: string                 // e.g., "claude-opus-4-5-20251101"
    content: (TextBlock | ToolUseBlock)[]
    stop_reason: 'end_turn' | 'tool_use' | null
    stop_sequence: string | null
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
      cache_creation?: {
        ephemeral_5m_input_tokens: number
        ephemeral_1h_input_tokens: number
      }
      service_tier: string
    }
  }
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string                      // Tool use ID (toolu_XXX)
  name: string                    // Tool name
  input: Record<string, any>      // Tool-specific input
}
```

#### Tool Names (Observed)

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `TodoWrite`, `Task`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `KillShell`

#### Tool Result Structures

```typescript
// File operations
interface FileToolResult {
  filePath: string
  oldString?: string
  newString?: string
  structuredPatch?: object
  userModified?: boolean
  originalFile?: string
}

// Shell operations
interface BashToolResult {
  shellId: string
  command: string
  status: string
  exitCode: number
  stdout: string
  stderr: string
  timestamp: string
  stdoutLines: number
  stderrLines: number
}

// Search operations
interface GlobToolResult {
  filenames: string[]
  durationMs: number
  numFiles: number
  truncated: boolean
}
```

---

### Codex CLI (P0)

**Path:** `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
**Session ID:** UUID from filename (last 36 chars after `rollout-timestamp-`)
**Format:** JSONL (event-driven architecture)

#### Record Types

| Type | Description |
|------|-------------|
| `session_meta` | Session initialization (once per file) |
| `response_item` | Messages, tool calls, reasoning |
| `event_msg` | Async events (user input, token counts) |
| `turn_context` | Execution context for each turn |

#### Top-Level Structure

```typescript
interface CodexRawRecord {
  timestamp: string               // ISO 8601
  type: 'session_meta' | 'response_item' | 'event_msg' | 'turn_context'
  payload: object                 // Type-specific content
}
```

#### Session Meta

```typescript
interface CodexSessionMeta {
  type: 'session_meta'
  payload: {
    id: string                    // ULID session identifier
    timestamp: string
    cwd: string
    originator: 'codex_cli_rs' | 'codex_vscode'
    cli_version: string
    source: 'cli' | 'vscode'
    model_provider: string
    base_instructions?: { text: string }  // Newer format
    instructions?: string                  // Older format
    git?: {
      commit_hash: string
      branch: string
      repository_url: string
    }
  }
}
```

#### Response Item (Messages)

```typescript
interface CodexResponseItem {
  type: 'response_item'
  payload: {
    type: 'message' | 'function_call' | 'function_call_output' |
          'custom_tool_call' | 'custom_tool_call_output' |
          'reasoning' | 'ghost_snapshot'
    // ... type-specific fields
  }
}

// Message payload
interface CodexMessagePayload {
  type: 'message'
  role: 'user' | 'developer' | 'assistant'
  content: (InputTextBlock | OutputTextBlock | SummaryTextBlock)[]
}

interface InputTextBlock { type: 'input_text'; text: string }
interface OutputTextBlock { type: 'output_text'; text: string }
interface SummaryTextBlock { type: 'summary_text'; text: string }

// Function call payload
interface CodexFunctionCallPayload {
  type: 'function_call'
  name: string                    // Tool name
  arguments: string               // JSON-stringified args
  call_id: string
}

// Function call output
interface CodexFunctionOutputPayload {
  type: 'function_call_output'
  call_id: string
  output: string
}

// Reasoning payload
interface CodexReasoningPayload {
  type: 'reasoning'
  summary: { type: 'summary_text'; text: string }[]
  content: string | null
  encrypted_content?: string      // Privacy-protected
}
```

#### Event Messages

```typescript
interface CodexEventMsg {
  type: 'event_msg'
  payload: {
    type: 'user_message' | 'token_count' | 'agent_reasoning'
    // ... type-specific fields
  }
}

// Token count event
interface CodexTokenCountPayload {
  type: 'token_count'
  info: {
    total_token_usage: {
      input_tokens: number
      cached_input_tokens: number
      output_tokens: number
      reasoning_output_tokens: number
      total_tokens: number
    }
    last_token_usage: { /* same structure */ }
    model_context_window: number
  } | null
  rate_limits: {
    primary: { window: string; usage_percentage: number }
    secondary: { window: string; usage_percentage: number }
    credits: object
  }
}
```

#### Turn Context

```typescript
interface CodexTurnContext {
  type: 'turn_context'
  payload: {
    cwd: string
    approval_policy: 'never' | 'unless-trusted' | 'always'
    sandbox_policy: { type: string }
    model: string
    effort: string
    summary: string
  }
}
```

---

### Cursor (P1)

**Path:** `~/.cursor/chats/<workspace-id>/<chat-id>/store.db`
**Format:** SQLite with JSON blobs

#### Storage Structure

- Key-value store in `ItemTable`
- Chat data in keys like `workbench.chat.history`, `ai.chat.session`
- Values are JSON serialized chat objects

```typescript
interface CursorChatSession {
  id: string
  title: string
  timestamp: number
  messages: {
    role: 'user' | 'assistant'
    content: string
  }[]
}
```

#### Related Files

- `~/.cursor/cli-config.json` - CLI configuration
- `~/.cursor/prompt_history.json` - Prompt history array
- `~/.cursor/mcp.json` - MCP configuration

---

### Continue.dev (P1)

**Path:** `~/.continue/dev_data/<version>/chatInteraction.jsonl`
**Format:** JSONL

#### Storage Structure

- Versioned directories (e.g., `0.2.0/`)
- JSONL files for each event type

```typescript
interface ContinueChatInteraction {
  // Schema version dependent
  // Events: chatInteraction, autocomplete, quickEdit
}
```

---

### Aider (P2)

**Path:** `.aider.chat.history.md` (project root)
**Format:** Markdown (human-readable)

#### Storage Structure

- Plain Markdown with conversation flow
- `.aider.llm.history` for raw LLM logs
- Configurable via `--chat-history-file`

---

### Windsurf (P2)

**Path:** `~/.codeium/windsurf/`
**Format:** Unknown (proprietary)

Status: Format not publicly documented. Community has requested export functionality (GitHub issue #127).

---

### Gemini CLI (P2)

**Path:** `~/.gemini/antigravity/conversations/*.pb`
**Format:** Protocol Buffers (binary)

Status: Binary format requires protobuf schema (not publicly documented).

#### Related Paths

- `~/.gemini/GEMINI.md` - Global config
- `~/.gemini/antigravity/brain/` - Knowledge storage
- `~/.gemini/antigravity/mcp_config.json` - MCP config

---

### OpenCode (P2)

**Path:** `~/.local/share/opencode/storage/`
**Format:** SQLite

Status: Follows XDG Base Directory spec. Database schema not documented.

---

## Design Considerations

### Raw Field Preservation

Based on format research, each agent has unique fields that must be preserved:

| Agent | Unique Fields |
|-------|---------------|
| **Claude** | `isSidechain`, `thinkingMetadata`, `toolUseResult`, `file-history-snapshot`, `queue-operation` |
| **Codex** | `reasoning.encrypted_content`, `ghost_snapshot`, `turn_context`, `rate_limits` |
| **Cursor** | Workspace-based organization, different chat types |
| **Continue** | Schema versioning in path, event types |

The raw-first design handles this by storing the complete JSON blob, making the system resilient to format changes and undocumented fields.

### Format Detection

Parsers should auto-detect based on path patterns:

```typescript
const FORMAT_PATTERNS = {
  claude: /\.claude\/projects\/.*\.jsonl$/,
  codex: /\.codex\/sessions\/\d{4}\/\d{2}\/\d{2}\/.*\.jsonl$/,
  cursor: /\.cursor\/chats\/.*\/store\.db$/,
  continue: /\.continue\/dev_data\/.*\.jsonl$/,
  aider: /\.aider\.chat\.history\.md$/,
}
```

### Non-JSONL Formats

Some agents require specialized parsing:

| Format | Approach |
|--------|----------|
| **SQLite** (Cursor, OpenCode) | Query tables, extract JSON from blobs |
| **Protobuf** (Gemini) | Requires schema discovery or reverse engineering |
| **Markdown** (Aider) | Regex-based parsing of conversation blocks |

MVP focuses on JSONL formats (Claude, Codex) with SQLite support in P1.

### Schema Evolution

Both Claude and Codex have evolved their formats:
- Claude: Added `cache_creation` fields, `file-history-snapshot` type
- Codex: Changed `instructions` to `base_instructions` object

The schema versioning in normalized tables allows re-normalization when we improve parsers.

---

## Open Questions

1. ~~**Cursor/Windsurf formats:**~~ ✅ Researched - Cursor uses SQLite, Windsurf is undocumented
2. **Test detection:** Heuristics for detecting test runs from Bash output (regex for pytest, jest, vitest, etc.)
3. **Acceptance tracking:** Claude's `file-history-snapshot` may help track actual file state
4. **Git integration:** Should we correlate with git log for commit attribution?
5. **Sub-agent tracing:** Claude's `isSidechain` and `parentUuid` provide linking; Codex has `ghost_snapshot`
6. **Protobuf parsing:** Gemini uses binary format - investigate schema extraction
7. **Cross-session search:** How to handle sessions split across multiple files (trimmed, rollover)?

---

## References

- [ai-data-extraction](https://github.com/0xSero/ai-data-extraction) - Multi-format parser
- [AI Observer](https://github.com/tobilg/ai-observer) - Self-hosted observability
- [claude-code-tools](https://github.com/pchalasani/claude-code-tools) - aichat-search
- [claude-code-log](https://github.com/daaain/claude-code-log) - JSONL to HTML converter
