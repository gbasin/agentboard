// Maps a session's log file to the transcript files of subagents it spawned,
// so PRs created by delegated work can be attributed to the parent session.
//
// Per-harness linkage:
// - claude:  <stem>.jsonl -> <stem>/subagents/agent-*.jsonl (dir name = session id)
// - pi/omp:  <stem>.jsonl -> <stem>/<task-id>.jsonl (artifact dir = sessionFile
//            minus .jsonl; subagent sessions carry a session_init entry)
// - codex:   flat rollouts in sessions/YYYY/MM/DD/; linkage only via
//            session_meta.payload.parent_thread_id, so an index is built in
//            the match worker (directory walk + first-line parses map
//            ownId -> parentId) and fed back here. The poller also registers
//            live links observed during enrichment, keeping the index fresh
//            between rebuilds. Depth>1 chains are resolved transitively.
// - devin:   subagents share the parent's message tree — nothing to do.
// - grok:    no subagent transcript format observed — nothing to do.

import fs from 'node:fs'
import path from 'node:path'
import type { AgentType } from '../shared/types'
import { clearCodexLinkCache, scanCodexSubagentLinksCached } from './codexSubagentScan'
import { extractCodexSubagentLink, isPiSubagent } from './logDiscovery'
import type { CodexSubagentLink } from './logMatchWorkerTypes'

// Directory listings are revalidated by dir mtime — subagent files only ever
// get appended alongside, so a changed mtime means a rescan is needed.
const dirListCache = new Map<string, { mtimeMs: number; paths: string[] }>()

function listDirCached(dir: string): string[] {
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(dir).mtimeMs
  } catch {
    return []
  }
  const cached = dirListCache.get(dir)
  if (cached && cached.mtimeMs === mtimeMs) return cached.paths
  let paths: string[] = []
  try {
    paths = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(dir, name))
      .sort()
  } catch {
    return []
  }
  dirListCache.set(dir, { mtimeMs, paths })
  return paths
}

// pi/omp: whether a candidate file is a subagent transcript, keyed by its
// size + mtime. PR-scan freshness keys run this filter for every dormant pi
// row on every re-queue; without the cache each run re-reads every head.
// Bounded; the oldest entry is evicted first.
const PI_SUBAGENT_CACHE_MAX = 5000
const piSubagentCache = new Map<
  string,
  { size: number; mtimeMs: number; isSubagent: boolean }
>()

function isPiSubagentCached(logPath: string): boolean {
  let stat: fs.Stats
  try {
    stat = fs.statSync(logPath)
  } catch {
    piSubagentCache.delete(logPath)
    return false
  }
  const cached = piSubagentCache.get(logPath)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.isSubagent
  }
  const isSubagent = isPiSubagent(logPath)
  piSubagentCache.delete(logPath)
  if (piSubagentCache.size >= PI_SUBAGENT_CACHE_MAX) {
    const oldest = piSubagentCache.keys().next().value
    if (oldest !== undefined) piSubagentCache.delete(oldest)
  }
  piSubagentCache.set(logPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    isSubagent,
  })
  return isSubagent
}

// --- Codex index -----------------------------------------------------------

type CodexSubagentNode = CodexSubagentLink

// ownId -> node. Bulk-refreshed by the match worker's rg backfill and kept
// fresh between rebuilds by poller-fed registerCodexSubagent calls.
let codexIndex = new Map<string, CodexSubagentNode>()
const CODEX_INDEX_MAX_DEPTH = 8
// parentId -> child ownIds for `codexIndex`, built lazily and dropped by
// putCodexNode whenever a link changes. Every dormant codex row walks it per
// PR-scan key, so rebuilding it per call costs rows x index size.
let codexParentMap: Map<string, string[]> | null = null
let codexParentMapBuilds = 0
// Called after the index gains or changes a link, so callers holding PR
// scans keyed on subagent logs can queue a rescan.
let codexIndexListener: (() => void) | null = null

/** Register the single index-change listener (null to clear). */
export function setCodexSubagentIndexListener(listener: (() => void) | null): void {
  codexIndexListener = listener
}

/** Sets a node; returns true when the index did not already hold it. */
function putCodexNode(node: CodexSubagentNode): boolean {
  const current = codexIndex.get(node.ownId)
  codexIndex.set(node.ownId, node)
  const changed =
    !current ||
    current.parentId !== node.parentId ||
    current.logPath !== node.logPath
  if (changed) codexParentMap = null
  return changed
}

function buildCodexParentMap(
  index: Map<string, CodexSubagentNode>
): Map<string, string[]> {
  const byParent = new Map<string, string[]>()
  for (const [ownId, node] of index) {
    if (!node.parentId) continue
    const list = byParent.get(node.parentId)
    if (list) list.push(ownId)
    else byParent.set(node.parentId, [ownId])
  }
  return byParent
}

function codexChildren(): Map<string, string[]> {
  if (!codexParentMap) {
    codexParentMap = buildCodexParentMap(codexIndex)
    codexParentMapBuilds++
  }
  return codexParentMap
}

/** Test hook: how many times the live index's parent map was built. */
export function getCodexParentMapBuildsForTests(): number {
  return codexParentMapBuilds
}

function notifyCodexIndexChanged(): void {
  try {
    codexIndexListener?.()
  } catch {
    // A listener failure must not break index maintenance.
  }
}

function codexSessionsRoot(): string {
  const override = process.env.CODEX_HOME
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return path.join(
    override && override.trim() ? override.trim() : path.join(home, '.codex'),
    'sessions'
  )
}

/**
 * Walk the codex sessions tree and extract subagent linkage from each
 * rollout's session_meta first line. No content pre-filter needed — the
 * linkage lives in line 1, so a head read per file beats an rg scan of
 * full bodies and avoids the external binary. Per-file results are cached
 * by size + mtime (codexSubagentScan.ts), so only new or growing rollouts
 * are read on rebuilds. Synchronous — call from a worker thread.
 */
export function scanCodexSubagentLinks(
  root: string = codexSessionsRoot()
): CodexSubagentLink[] {
  return scanCodexSubagentLinksCached(root)
}

/** Build an ownId -> node map from candidate rollout files. */
export function buildCodexIndex(
  logPaths: string[]
): Map<string, CodexSubagentNode> {
  const next = new Map<string, CodexSubagentNode>()
  for (const logPath of logPaths) {
    const link = extractCodexSubagentLink(logPath)
    if (link) next.set(link.ownId, { ownId: link.ownId, logPath, parentId: link.parentId })
  }
  return next
}

/**
 * Feed a subagent link observed during log enrichment into the index.
 * The poller calls this per batch entry, so live subagents land in the
 * index immediately — no tree rescan and no TTL wait. Entries outside
 * the current maxLogsPerPoll batch simply aren't fed yet; the periodic
 * worker backfill covers cold history.
 */
export function registerCodexSubagent(
  ownId: string,
  parentId: string | null,
  logPath: string
): void {
  if (putCodexNode({ ownId, parentId, logPath })) notifyCodexIndexChanged()
}

/** All descendant transcript paths of `sessionId` in `index`, BFS order. */
export function collectCodexDescendants(
  index: Map<string, CodexSubagentNode>,
  sessionId: string,
  byParent: Map<string, string[]> = buildCodexParentMap(index)
): string[] {
  const results: string[] = []
  let frontier = [sessionId]
  for (let depth = 0; depth < CODEX_INDEX_MAX_DEPTH; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const childId of byParent.get(id) ?? []) {
        const node = index.get(childId)
        if (node) {
          results.push(node.logPath)
          next.push(childId)
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return results
}

/**
 * Merge a worker-built link set into the index. Merges rather than replaces
 * so links registered live since the scan started are not dropped; stale
 * nodes for deleted files are harmless (the PR scanner tolerates missing
 * paths) and get overwritten by the next rebuild.
 */
export function setCodexSubagentIndex(links: CodexSubagentLink[]): void {
  let changed = false
  for (const link of links) {
    if (putCodexNode({ ownId: link.ownId, parentId: link.parentId, logPath: link.logPath })) {
      changed = true
    }
  }
  if (changed) notifyCodexIndexChanged()
}

// ---------------------------------------------------------------------------

/**
 * Transcript paths of subagents spawned by the session whose main log is
 * `logPath`. Never throws; returns [] when the layout has no subagents.
 */
export function getSubagentLogPaths(
  logPath: string,
  agentType: AgentType | null,
  sessionId: string
): string[] {
  if (!logPath) return []
  const stem = logPath.endsWith('.jsonl') ? logPath.slice(0, -6) : logPath

  if (agentType === 'claude') {
    return listDirCached(path.join(stem, 'subagents'))
  }

  if (agentType === 'pi' || agentType === 'omp') {
    // Artifact dir holds <task-id>.jsonl subagent sessions among other files;
    // the session_init marker is the discriminator. Heads are read only for
    // new or changed files.
    return listDirCached(stem).filter(isPiSubagentCached)
  }

  if (agentType === 'codex') {
    // BFS rolls nested subagents (depth > 1) up to the registered session.
    return collectCodexDescendants(codexIndex, sessionId, codexChildren())
  }

  return []
}

/** Test helper: drop cached state. */
export function clearSubagentLogCaches(): void {
  dirListCache.clear()
  piSubagentCache.clear()
  codexIndex = new Map()
  codexParentMap = null
  clearCodexLinkCache()
}
