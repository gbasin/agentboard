// Detects pull requests a session created by scanning its agent JSONL log.
// A `gh pr create` is only counted when it appears inside an actual tool
// call entry (Claude tool_use, Codex function_call) — prose mentioning the
// command is ignored. Resulting github.com/.../pull/N URLs are captured
// from the tool result that references the call's id, with a short
// line-count fallback window for formats without call ids.
// Scans incrementally: results are cached per file offset so polling only
// reads bytes appended since the previous scan.

import fs from 'node:fs'
import type { SessionPullRequest } from '../shared/types'
import { logger } from './logger'

export type { SessionPullRequest }

// After an id-less `gh pr create`, PR URLs in the next N lines are
// attributed to that create. Id-based attribution (the common case for
// Claude and Codex) does not expire within this window.
const PR_URL_LOOKAHEAD_LINES = 10
// Pending tool-call ids expire after this many log lines to bound memory.
const PENDING_ID_TTL_LINES = 2000
const MAX_PENDING_IDS = 100
const READ_CHUNK_BYTES = 4 * 1024 * 1024
// Must exceed the number of scanned log paths or FIFO eviction thrashes:
// the dormant-session sweep touches every path each cycle, so once paths >
// cap, evicted files get fully re-scanned every refresh.
const MAX_CACHE_ENTRIES = 5000

// Separators cover both `gh pr create` shell text and JSON-escaped argv
// arrays like ["gh","pr","create"] (which appear as gh\",\"pr\",\"create).
// Optional `-R owner/repo`/`--repo` may sit between gh and pr.
const GH_PR_CREATE_RE =
  /\bgh[\s"',\\]+(?:(?:-R|--repo)[\s"',\\]+\S+[\s"',\\]+)?pr[\s"',\\]+create\b/
// Raw-line variant without the \b before gh: inside JSONL the command's
// newlines are escaped, so `...\ngh pr create` arrives as the literal
// characters "ngh" — \b fails between two word chars and the create is
// missed entirely. The parsed-command check in extractToolCallIds still
// applies the strict version, so the loose gate only widens which lines
// get parsed.
const GH_PR_CREATE_LINE_RE =
  /gh[\s"',\\]+(?:(?:-R|--repo)[\s"',\\]+\S+[\s"',\\]+)?pr[\s"',\\]+create\b/
// A `gh pr create` mention only counts when the line is a tool-call entry
// (or a devin mirrored log, where tool calls aren't recorded at all).
const TOOL_CALL_LINE_RE =
  /"tool_use"|"function_call"|"custom_tool_call"|"toolCall"|"tool_calls"|"agent":"devin"/
const PR_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g
// Result markers only — "call_id" alone also appears on function_call lines.
const RESULT_LINE_RE =
  /"tool_result"|"function_call_output"|"tool_use_id"|"toolResult"|"toolCallId"/

interface PendingCreate {
  ids: Set<string>
  ttl: number
}

interface ScanState {
  // Byte offset consumed so far. Log files are append-mostly; a smaller file
  // size than offset, or same size with a changed mtime, means a rewrite and
  // triggers a rescan.
  offset: number
  mtimeMs: number
  // Trailing partial line carried between incremental reads.
  remainder: string
  // Tool-call ids awaiting their result (id -> expiry in lines).
  pending: PendingCreate[]
  // Fallback lookahead (lines) for create commands that had no ids.
  windowRemaining: number
  seenUrls: Set<string>
  prs: SessionPullRequest[]
}

const scanCache = new Map<string, ScanState>()

const EMPTY_RESULT: SessionPullRequest[] = []

function newScanState(): ScanState {
  return {
    offset: 0,
    mtimeMs: 0,
    remainder: '',
    pending: [],
    windowRemaining: 0,
    seenUrls: new Set(),
    prs: [],
  }
}

// Extract tool-call ids from a confirmed `gh pr create` tool-call line so the
// matching tool result can be attributed precisely. Returns [] when the line
// parses as a known tool-call format but contains no create call (proof it is
// NOT a create). Returns null for unparseable/unknown formats — the caller
// falls back to the lookahead window for those.
function extractToolCallIds(line: string): string[] | null {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const ids: string[] = []
  let recognized = false

  // Claude: message.content[] items of type tool_use with input.command
  // Pi: same array, items of type toolCall with arguments.command (the args
  // may also arrive as a partialJson string while streaming).
  const message = entry.message as Record<string, unknown> | undefined
  const content = message?.content
  if (Array.isArray(content)) {
    recognized = true
    for (const item of content) {
      if (!item || typeof item.id !== 'string') continue
      if (
        item.type === 'tool_use' &&
        typeof item.input === 'object' &&
        item.input !== null &&
        GH_PR_CREATE_RE.test(
          String((item.input as Record<string, unknown>).command ?? '')
        )
      ) {
        ids.push(item.id)
        continue
      }
      if (item.type === 'toolCall') {
        const args = item.arguments
        const argsText =
          typeof args === 'string'
            ? args
            : typeof item.partialJson === 'string'
              ? item.partialJson
              : JSON.stringify(args ?? '')
        if (GH_PR_CREATE_RE.test(argsText)) {
          ids.push(item.id)
        }
      }
    }
  }

  // Devin: message.toolCalls[] entries of shape {id, name, arguments}
  // (mirrored from chat_message.tool_calls by devinSync; results arrive as
  // role 'tool' lines carrying message.toolCallId).
  const toolCalls = message?.toolCalls
  if (Array.isArray(toolCalls)) {
    recognized = true
    for (const call of toolCalls) {
      if (!call || typeof call.id !== 'string' || !call.id) continue
      const args = call.arguments
      const argsText =
        typeof args === 'string' ? args : JSON.stringify(args ?? '')
      if (GH_PR_CREATE_RE.test(argsText)) {
        ids.push(call.id)
      }
    }
  }

  // Grok: top-level tool_calls[] entries of shape {id, name, arguments}
  // (arguments is a JSON string; results arrive as type 'tool_result' lines
  // carrying tool_call_id).
  const grokToolCalls = entry.tool_calls
  if (Array.isArray(grokToolCalls)) {
    recognized = true
    for (const call of grokToolCalls) {
      if (!call || typeof call.id !== 'string' || !call.id) continue
      const args = (call as Record<string, unknown>).arguments
      const argsText =
        typeof args === 'string' ? args : JSON.stringify(args ?? '')
      if (GH_PR_CREATE_RE.test(argsText)) {
        ids.push(call.id)
      }
    }
  }

  // Codex: payload.type === 'function_call' with command in arguments
  const payload = entry.payload as Record<string, unknown> | undefined
  if (
    payload &&
    (payload.type === 'function_call' || payload.type === 'custom_tool_call')
  ) {
    recognized = true
    const args = String(payload.arguments ?? '')
    if (GH_PR_CREATE_RE.test(args) || GH_PR_CREATE_LINE_RE.test(line)) {
      const id =
        typeof payload.call_id === 'string'
          ? payload.call_id
          : typeof payload.id === 'string'
            ? payload.id
            : null
      if (id) ids.push(id)
    }
  }

  return recognized ? ids : null
}

function collectUrls(state: ScanState, line: string): void {
  PR_URL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PR_URL_RE.exec(line)) !== null) {
    const url = match[0]
    if (state.seenUrls.has(url)) continue
    state.seenUrls.add(url)
    state.prs.push({
      url,
      repo: match[1],
      number: Number(match[2]),
    })
  }
}

function processLine(state: ScanState, line: string): void {
  // 1. A `gh pr create` inside an actual tool call registers pending ids
  //    (or opens the fallback window when the entry has no ids).
  if (GH_PR_CREATE_LINE_RE.test(line) && TOOL_CALL_LINE_RE.test(line)) {
    const ids = extractToolCallIds(line)
    if (ids === null) {
      // Unparseable or unknown tool-call format — fall back to the window.
      state.windowRemaining = PR_URL_LOOKAHEAD_LINES
    } else if (ids.length > 0) {
      if (state.pending.length < MAX_PENDING_IDS) {
        state.pending.push({
          ids: new Set(ids),
          ttl: PENDING_ID_TTL_LINES,
        })
      }
    }
    // ids === [] means a parsed entry with no create call — not a create.
  }

  // 2. Tool-result lines referencing a pending call id close it and have
  //    their PR URLs attributed to the session.
  if (state.pending.length > 0 && RESULT_LINE_RE.test(line)) {
    for (let i = state.pending.length - 1; i >= 0; i--) {
      const pending = state.pending[i]
      for (const id of pending.ids) {
        if (id && line.includes(id)) {
          collectUrls(state, line)
          pending.ids.delete(id)
          break
        }
      }
      if (pending.ids.size === 0) {
        state.pending.splice(i, 1)
      }
    }
  }

  // 3. Fallback: id-less create — capture PR URLs within the window.
  if (state.windowRemaining > 0) {
    collectUrls(state, line)
    state.windowRemaining -= 1
  }

  // 4. Expire pending ids so a missing result doesn't leak forever.
  for (const pending of state.pending) {
    pending.ttl -= 1
  }
  state.pending = state.pending.filter((p) => p.ttl > 0 && p.ids.size > 0)
}

function processChunk(state: ScanState, chunk: string): void {
  const lines = (state.remainder + chunk).split('\n')
  state.remainder = lines.pop() ?? ''
  for (const line of lines) {
    processLine(state, line)
  }
}

/** Parse a complete log file (used by tests and full rescans). */
export function extractPullRequests(content: string): SessionPullRequest[] {
  const state = newScanState()
  processChunk(state, content)
  processLine(state, state.remainder)
  return state.prs
}

/**
 * Return the PRs created in the given agent log file.
 * Incremental: re-reads only bytes appended since the last call. Pass
 * `knownSize` (e.g. the DB's last_known_log_size) to skip the stat syscall
 * when the caller already knows the size is unchanged.
 */
export function getSessionPullRequests(
  logPath: string,
  knownSize?: number | null
): SessionPullRequest[] {
  let state = scanCache.get(logPath)
  if (
    state &&
    state.offset > 0 &&
    knownSize != null &&
    knownSize === state.offset
  ) {
    return state.prs.length ? state.prs.slice() : EMPTY_RESULT
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(logPath)
  } catch {
    return EMPTY_RESULT
  }

  if (state && (stat.size < state.offset || stat.mtimeMs !== state.mtimeMs)) {
    // Shrinkage is a rewrite; same size with a new mtime likely is too.
    // Growth with a changed mtime is a normal append — only rescan when the
    // file did not grow.
    if (stat.size <= state.offset) {
      state = undefined
    }
  }
  if (!state) {
    if (scanCache.size >= MAX_CACHE_ENTRIES) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldest = scanCache.keys().next().value
      if (oldest) scanCache.delete(oldest)
    }
    state = newScanState()
    scanCache.set(logPath, state)
  }
  if (stat.size === state.offset && stat.mtimeMs === state.mtimeMs) {
    return state.prs.length ? state.prs.slice() : EMPTY_RESULT
  }
  if (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs) {
    // Same-size rewrite — rescan from scratch.
    state.offset = 0
    state.remainder = ''
    state.pending = []
    state.windowRemaining = 0
    state.seenUrls.clear()
    state.prs = []
  }

  let fd: number | null = null
  try {
    fd = fs.openSync(logPath, 'r')
    while (state.offset < stat.size) {
      const length = Math.min(READ_CHUNK_BYTES, stat.size - state.offset)
      const buffer = Buffer.alloc(length)
      const read = fs.readSync(fd, buffer, 0, length, state.offset)
      if (read <= 0) break
      processChunk(state, buffer.subarray(0, read).toString('utf8'))
      state.offset += read
    }
    state.mtimeMs = stat.mtimeMs
  } catch (error) {
    logger.warn('pr_extract_error', {
      logPath,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Ignore close errors
      }
    }
  }

  return state.prs.length ? state.prs.slice() : EMPTY_RESULT
}

/** Test helper: drop cached scan state. */
export function clearPrScanCache(): void {
  scanCache.clear()
}
