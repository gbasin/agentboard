// Detects pull requests a session created by scanning its agent JSONL log.
// A `gh pr create` is only counted when it appears inside an actual tool
// call entry (Claude tool_use, Codex function_call, devin toolCalls) —
// prose mentioning the command is ignored. Resulting github.com/.../pull/N
// URLs are captured from the tool result that references the call's id,
// with a short line-count fallback window for formats without call ids.
// Scans incrementally: results are cached per file offset so polling only
// reads bytes appended since the previous scan.

import fs from 'node:fs'
import type { SessionPullRequest } from '../shared/types'
import { logger } from './logger'
import {
  CREATE_BYTES,
  PR_LINK_BYTES,
  hasCreateCandidate,
  hasPrLinkCandidate,
  seamHasCreate,
  seamHasPrLink,
} from './prCreatePrefilter'

export type { SessionPullRequest }

// After an id-less `gh pr create`, PR URLs in the next N lines are
// attributed to that create. Id-based attribution (the common case for
// Claude and Codex) does not expire within this window.
const PR_URL_LOOKAHEAD_LINES = 10
// Pending tool-call ids expire after this many log lines to bound memory.
const PENDING_ID_TTL_LINES = 2000
const MAX_PENDING_IDS = 100
const READ_CHUNK_BYTES = 128 * 1024
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
// A `gh pr create` mention only counts when the line is a tool-call entry.
// Devin mirrors exec calls as message.toolCalls and results as role:'tool'
// lines carrying message.toolCallId, so it uses the same id-based path as
// the other agents — no blanket per-agent match (which would make every
// line in a mirrored devin log qualify, prose and tool output included).
const TOOL_CALL_LINE_RE =
  /"tool_use"|"function_call"|"custom_tool_call"|"toolCalls?"|"tool_calls"/
const PR_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g
// Result markers only — "call_id" alone also appears on function_call lines.
const RESULT_LINE_RE =
  /"tool_result"|"function_call_output"|"custom_tool_call_output"|"tool_use_id"|"toolResult"|"toolCallId"/

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
  // Trailing partial line carried between reads, as copied raw byte pieces.
  // It is decoded once, whole, when its newline arrives: decoding per chunk
  // breaks multi-byte characters at chunk edges, and re-joining a growing
  // string per chunk is quadratic in line length (image results run to MBs).
  partial: Buffer[]
  // True when the partial line contains `create` or `pr-link`, seams
  // between pieces included.
  partialHasCreate: boolean
  partialHasLink: boolean
  // Tool-call ids awaiting their result (id -> expiry in lines).
  pending: PendingCreate[]
  // Fallback lookahead (lines) for create commands that had no ids.
  windowRemaining: number
  seenUrls: Set<string>
  prs: SessionPullRequest[]
}

// One read buffer shared by every scan. The scan is synchronous, so a single
// buffer is never used by two scans at once.
let readBuffer: Buffer | null = null

const scanCache = new Map<string, ScanState>()

const EMPTY_RESULT: SessionPullRequest[] = []

function newScanState(): ScanState {
  return {
    offset: 0,
    mtimeMs: 0,
    partial: [],
    partialHasCreate: false,
    partialHasLink: false,
    pending: [],
    windowRemaining: 0,
    seenUrls: new Set(),
    prs: [],
  }
}

// Extract the shell-command text from a tool call's arguments. Only
// command-bearing calls (exec/bash/shell) can run `gh pr create` — calls
// like edit/write whose *content* mentions the command must not count.
// Returns null when the args carry no command field.
function commandTextFromArgs(args: unknown): string | null {
  if (args == null) return null
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args)
      return commandTextFromArgs(parsed)
    } catch {
      return args // raw command string
    }
  }
  if (typeof args === 'object' && !Array.isArray(args)) {
    const cmd = (args as Record<string, unknown>).command
    if (cmd == null) return null
    return Array.isArray(cmd) ? cmd.join(' ') : String(cmd)
  }
  return String(args)
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
      if (item.type === 'tool_use') {
        const cmd = commandTextFromArgs(item.input)
        if (cmd !== null && GH_PR_CREATE_RE.test(cmd)) {
          ids.push(item.id)
          continue
        }
      }
      if (item.type === 'toolCall') {
        const cmd =
          commandTextFromArgs(item.arguments) ??
          commandTextFromArgs(item.partialJson)
        if (cmd !== null && GH_PR_CREATE_RE.test(cmd)) {
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
      const cmd = commandTextFromArgs(call.arguments)
      if (cmd !== null && GH_PR_CREATE_RE.test(cmd)) {
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
      const cmd = commandTextFromArgs(
        (call as Record<string, unknown>).arguments
      )
      if (cmd !== null && GH_PR_CREATE_RE.test(cmd)) {
        ids.push(call.id)
      }
    }
  }

  // Codex: payload.type === 'function_call' with command in arguments
  // (custom_tool_call carries the raw command in input instead).
  const payload = entry.payload as Record<string, unknown> | undefined
  if (
    payload &&
    (payload.type === 'function_call' || payload.type === 'custom_tool_call')
  ) {
    recognized = true
    const cmd = commandTextFromArgs(payload.arguments ?? payload.input)
    if (
      cmd !== null &&
      (GH_PR_CREATE_RE.test(cmd) || GH_PR_CREATE_LINE_RE.test(cmd))
    ) {
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

// Codex unified exec (cli ~0.150+): the agent runs commands through an
// `exec` custom_tool_call whose input is a JS snippet, and each finished
// command lands as an event_msg item_completed whose item is a
// CommandExecution carrying argv and captured output on the same entry.
// This is the reliable create signal for that format: the create's own
// tool result is a custom_tool_call_output whose call_id is often a later
// write_stdin poll, not the create call — so id attribution misses it.
function collectCommandExecutionUrls(state: ScanState, line: string): void {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  const payload = entry.payload as Record<string, unknown> | undefined
  if (payload?.type !== 'item_completed') return
  const item = payload.item as Record<string, unknown> | undefined
  if (item?.type !== 'CommandExecution') return
  const cmd = item.command
  const cmdText =
    typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd.join(' ') : null
  if (cmdText === null || !GH_PR_CREATE_RE.test(cmdText)) return
  for (const key of ['stdout', 'aggregated_output', 'formatted_output']) {
    const out = item[key]
    if (typeof out === 'string' && out) collectUrls(state, out)
  }
}

// JSC substrings (regex captures, split() pieces) share their parent's
// buffer. Storing one in the scan cache pins the whole decoded text (a chunk
// plus any long line it completes) for as long as the entry lives — hundreds of MB across a
// few hundred sessions. Copy anything that outlives the scan.
function detach(text: string): string {
  return text.length === 0 ? '' : Buffer.from(text, 'utf8').toString('utf8')
}

// Claude Code writes self-contained `{"type":"pr-link",...}` entries when
// it associates the session with a PR (e.g. after pushing to a PR it did
// not create). They carry prUrl/prRepository/prNumber directly, so they
// bypass the create/id machinery entirely.
function collectPrLink(state: ScanState, line: string): void {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (entry.type !== 'pr-link') return
  const url = entry.prUrl
  if (typeof url !== 'string') return
  collectUrls(state, url)
}

function collectUrls(state: ScanState, line: string): void {
  PR_URL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PR_URL_RE.exec(line)) !== null) {
    if (state.seenUrls.has(match[0])) continue
    const url = detach(match[0])
    state.seenUrls.add(url)
    state.prs.push({
      url,
      repo: detach(match[1]),
      number: Number(match[2]),
    })
  }
}

function processLine(state: ScanState, line: string): void {
  // 0. Codex item_completed CommandExecution entries are self-contained
  //    (argv + stdout on one line); they bypass the id/window machinery.
  if (line.includes('"CommandExecution"') && GH_PR_CREATE_LINE_RE.test(line)) {
    collectCommandExecutionUrls(state, line)
  }

  // 0b. pr-link entries declare the session↔PR association outright.
  if (line.includes('"pr-link"')) {
    collectPrLink(state, line)
  }

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

  // 3. Fallback: id-less create — capture PR URLs within the window, but
  //    only on lines that look like tool results. Without this guard the
  //    window vacuums up PR URLs from prose, prompts, and command output
  //    that merely discusses PRs (e.g. grep results over another log).
  if (state.windowRemaining > 0) {
    if (RESULT_LINE_RE.test(line)) {
      collectUrls(state, line)
    }
    state.windowRemaining -= 1
  }

  // 4. Expire pending ids so a missing result doesn't leak forever.
  for (const pending of state.pending) {
    pending.ttl -= 1
  }
  state.pending = state.pending.filter((p) => p.ttl > 0 && p.ids.size > 0)
}

function processLines(state: ScanState, text: string): void {
  for (const line of text.split('\n')) {
    processLine(state, line)
  }
}

// Feeds one read chunk. Decoding dominates scan garbage and CPU, yet most
// lines hold no `gh pr create`, so the lines a chunk completes are decoded
// only when something in them can match: a create is waiting for its result,
// or the carried partial line, the seam, or the chunk holds a create
// candidate. A chunk without a newline completes no line; it is only added
// to the partial line. Lines are decoded whole, from line start to newline,
// so no multi-byte character is ever split.
function consumeChunk(state: ScanState, bytes: Buffer): void {
  const lastNewline = bytes.lastIndexOf(0x0a)
  const seamCreate = seamHasCreate(state.partial, bytes)
  const seamLink = seamHasPrLink(state.partial, bytes)
  if (lastNewline === -1) {
    state.partialHasCreate ||= seamCreate || bytes.includes(CREATE_BYTES)
    state.partialHasLink ||= seamLink || bytes.includes(PR_LINK_BYTES)
    // Copy: `bytes` views the shared read buffer.
    state.partial.push(Buffer.from(bytes))
    return
  }
  if (
    state.pending.length > 0 ||
    state.windowRemaining > 0 ||
    state.partialHasCreate ||
    state.partialHasLink ||
    seamCreate ||
    seamLink ||
    hasCreateCandidate(bytes) ||
    hasPrLinkCandidate(bytes)
  ) {
    const head = bytes.subarray(0, lastNewline)
    const lines =
      state.partial.length > 0 ? Buffer.concat([...state.partial, head]) : head
    processLines(state, lines.toString('utf8'))
  }
  const tail = bytes.subarray(lastNewline + 1)
  state.partial = tail.length > 0 ? [Buffer.from(tail)] : []
  state.partialHasCreate = tail.includes(CREATE_BYTES)
  state.partialHasLink = tail.includes(PR_LINK_BYTES)
}

/** Parse a complete log file (used by tests and full rescans). */
export function extractPullRequests(content: string): SessionPullRequest[] {
  const state = newScanState()
  processLines(state, content)
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
    state.partial = []
    state.partialHasCreate = false
    state.partialHasLink = false
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
      readBuffer ??= Buffer.allocUnsafe(READ_CHUNK_BYTES)
      const read = fs.readSync(fd, readBuffer, 0, length, state.offset)
      if (read <= 0) break
      consumeChunk(state, readBuffer.subarray(0, read))
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
