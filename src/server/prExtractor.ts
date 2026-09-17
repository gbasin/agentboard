// Detects pull requests a session created by scanning its agent JSONL log.
// Looks for `gh pr create` commands and captures github.com/.../pull/N URLs
// that appear within a few subsequent log lines (tool results / shell output).
// Scans incrementally: results are cached per file offset so polling only
// reads bytes appended since the previous scan.

import fs from 'node:fs'
import { logger } from './logger'

export interface SessionPullRequest {
  url: string
  repo: string // "owner/name"
  number: number
}

// After a `gh pr create` command line, PR URLs in the next N lines are
// attributed to that create. Covers Claude tool_result entries and Codex
// function_call_output entries, which land on their own JSONL lines.
const PR_URL_LOOKAHEAD_LINES = 10

// Separators cover both `gh pr create` shell text and JSON-escaped argv
// arrays like ["gh","pr","create"] (which appear as gh\",\"pr\",\"create).
const GH_PR_CREATE_RE = /\bgh[\s"',\\]+pr[\s"',\\]+create\b/
const PR_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g

interface ScanState {
  // Byte offset consumed so far. Log files are append-mostly; a smaller file
  // size than offset means truncation/rotation and triggers a rescan.
  offset: number
  // Trailing partial line carried between incremental reads.
  remainder: string
  // Remaining lookahead lines during which PR URLs are attributed to a create.
  windowRemaining: number
  seenUrls: Set<string>
  prs: SessionPullRequest[]
}

const scanCache = new Map<string, ScanState>()

function newScanState(): ScanState {
  return {
    offset: 0,
    remainder: '',
    windowRemaining: 0,
    seenUrls: new Set(),
    prs: [],
  }
}

function processLine(state: ScanState, line: string): void {
  if (GH_PR_CREATE_RE.test(line)) {
    state.windowRemaining = PR_URL_LOOKAHEAD_LINES
  }

  if (state.windowRemaining > 0) {
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
    state.windowRemaining -= 1
  }
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
 * Incremental: re-reads only bytes appended since the last call; a smaller
 * file size (rotation/truncation) triggers a full rescan.
 */
export function getSessionPullRequests(logPath: string): SessionPullRequest[] {
  let stat: fs.Stats
  try {
    stat = fs.statSync(logPath)
  } catch {
    return []
  }

  let state = scanCache.get(logPath)
  if (state && stat.size < state.offset) {
    state = undefined // truncated or rotated — rescan from scratch
  }
  if (!state) {
    state = newScanState()
    scanCache.set(logPath, state)
  }
  if (stat.size === state.offset) {
    return state.prs
  }

  let fd: number | null = null
  try {
    fd = fs.openSync(logPath, 'r')
    const length = stat.size - state.offset
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(fd, buffer, 0, length, state.offset)
    if (read > 0) {
      processChunk(state, buffer.subarray(0, read).toString('utf8'))
      state.offset += read
    }
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

  return state.prs
}

/** Test helper: drop cached scan state. */
export function clearPrScanCache(): void {
  scanCache.clear()
}
