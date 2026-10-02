// Walks the codex sessions tree and extracts subagent linkage from each
// rollout's session_meta first line, for the match worker's periodic index
// rebuild (see subagentLogs.ts).
//
// Results are identical to calling extractCodexSubagentLink per file: the
// same 64 KB head is read and the same first-line parser runs. Two things
// make repeated scans cheap:
// - Only the bytes before the first newline are decoded (rollout first
//   lines are ~13-40 KB; the rest of the head is never looked at), and the
//   head buffer is not zero-filled. A fresh buffer per read is deliberate:
//   reusing one module-level buffer measured ~25 MB higher peak footprint
//   on a 7k-file tree, because the per-read external allocations are what
//   prompt the GC to collect the parsed first lines promptly.
// - A per-file cache keyed by size + mtime. Rollouts are append-only, so an
//   unchanged size + mtime means an unchanged first line and the file is not
//   opened at all. Each scan, complete or not, replaces the cache with the
//   files it saw, so deleted files drop out and a directory that failed to
//   list is re-read cold next time; the entry count is capped.
//
// Module-level state is safe: the scan is synchronous and runs in the match
// worker. With AGENTBOARD_LOG_MATCH_WORKER=false the poller skips worker
// cycles entirely, so this never runs on the main thread there.

import fs from 'node:fs'
import path from 'node:path'
import { LOG_HEAD_BYTE_LIMIT, parseCodexSubagentLinkLine } from './logDiscovery'
import { logger } from './logger'
import type { CodexSubagentLink } from './logMatchWorkerTypes'

const NEWLINE = 0x0a
export const CODEX_LINK_CACHE_MAX_ENTRIES = 50_000

interface CachedHead {
  size: number
  mtimeMs: number
  link: CodexSubagentLink | null
}

let linkCache = new Map<string, CachedHead>()

/**
 * Raw first line (before the first newline) of the file's 64 KB head, or ''
 * when the file is empty or unreadable — the same text
 * readLogHead(p).split('\n')[0] yields.
 */
function readFirstLineOfHead(logPath: string): string {
  let fd: number
  try {
    fd = fs.openSync(logPath, 'r')
  } catch {
    return ''
  }
  try {
    const headBuffer = Buffer.allocUnsafe(LOG_HEAD_BYTE_LIMIT)
    const bytes = fs.readSync(fd, headBuffer, 0, LOG_HEAD_BYTE_LIMIT, 0)
    if (bytes <= 0) return ''
    // 0x0A never occurs inside a UTF-8 multibyte sequence, so decoding only
    // the bytes before it yields the same text as decode-then-split.
    // Search only the bytes read; the unfilled tail holds stale memory.
    const newline = headBuffer.subarray(0, bytes).indexOf(NEWLINE)
    const end = newline >= 0 ? newline : bytes
    return headBuffer.toString('utf8', 0, end)
  } catch {
    return ''
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // ignore: the head (if any) was already read
    }
  }
}

function extractLink(logPath: string): CodexSubagentLink | null {
  const link = parseCodexSubagentLinkLine(readFirstLineOfHead(logPath))
  return link ? { ...link, logPath } : null
}

/**
 * Subagent links for every rollout under `root`, in directory walk order.
 * Synchronous; call from a worker thread.
 */
export function scanCodexSubagentLinksCached(
  root: string,
  maxEntries = CODEX_LINK_CACHE_MAX_ENTRIES
): CodexSubagentLink[] {
  const links: CodexSubagentLink[] = []
  const previous = linkCache
  const next = new Map<string, CachedHead>()
  const walk = (dir: string): void => {
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(p)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      let stat: fs.Stats | undefined
      try {
        stat = fs.statSync(p, { throwIfNoEntry: false })
      } catch {
        stat = undefined
      }
      // Vanished or unstattable since readdir: the head read fails too.
      if (!stat) continue
      const cached = previous.get(p)
      let link: CodexSubagentLink | null
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        link = cached.link
      } else {
        link = extractLink(p)
      }
      if (next.size < maxEntries) {
        next.set(p, { size: stat.size, mtimeMs: stat.mtimeMs, link })
      }
      if (link) links.push(link)
    }
  }
  try {
    walk(root)
  } catch (error) {
    logger.warn('codex_subagent_index_error', {
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    linkCache = next
  }
  return links
}

/** Entries currently cached (for tests and diagnostics). */
export function codexLinkCacheSize(): number {
  return linkCache.size
}

/** Test helper: drop cached heads. */
export function clearCodexLinkCache(): void {
  linkCache = new Map()
}
