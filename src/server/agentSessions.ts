import fs from 'node:fs'
import path from 'node:path'
import type { AgentSession, SessionPullRequest } from '../shared/types'
import { config } from './config'
import type { AgentSessionRecord } from './db'
import { getSessionPullRequests } from './prExtractor'
import { getSubagentLogPaths } from './subagentLogs'

// PRs found by the last full scan per session, keyed with the log sizes the
// scan saw (see `pullRequestScanKey`). Lets dormant lists be built without
// touching any log file.
const DEFAULT_MAX_SCANNED_ENTRIES = 5000
let maxScannedEntries = DEFAULT_MAX_SCANNED_ENTRIES
const scannedPrs = new Map<
  string,
  { key: string; prs: SessionPullRequest[] }
>()

/** Test hook: shrink the remembered-scan cap. Omit to restore the default. */
export function setScannedPrCacheLimitForTests(limit?: number) {
  maxScannedEntries = limit ?? DEFAULT_MAX_SCANNED_ENTRIES
}

function samePullRequests(a: SessionPullRequest[], b: SessionPullRequest[]) {
  return a.length === b.length && a.every((pr, i) => pr.url === b[i].url)
}

/** Stores the scan; returns true when the PR list differs from the last one. */
function rememberScan(
  record: AgentSessionRecord,
  key: string,
  prs: SessionPullRequest[]
): boolean {
  const previous = scannedPrs.get(record.sessionId)?.prs ?? []
  scannedPrs.delete(record.sessionId)
  if (scannedPrs.size >= maxScannedEntries) {
    const oldest = scannedPrs.keys().next().value
    if (oldest !== undefined) scannedPrs.delete(oldest)
  }
  scannedPrs.set(record.sessionId, { key, prs })
  return !samePullRequests(previous, prs)
}

function subagentPaths(record: AgentSessionRecord): string[] {
  return getSubagentLogPaths(
    record.logFilePath,
    record.agentType,
    record.sessionId
  )
}

function keyFor(record: AgentSessionRecord, subagents: string[]): string {
  let total = 0
  for (const logPath of subagents) {
    try {
      total += fs.statSync(logPath).size
    } catch {
      // A missing subagent log contributes nothing.
    }
  }
  return `${record.lastKnownLogSize ?? null}|${subagents.length}:${total}`
}

/**
 * Freshness key for a session's PR scan: the main log size plus the count and
 * total size of its subagent logs. A codex subagent index that arrives after
 * the first scan, or a subagent log that grows, changes the key. Stats the
 * subagent logs; never reads them.
 */
export function pullRequestScanKey(record: AgentSessionRecord): string {
  return keyFor(record, subagentPaths(record))
}

/** Main log first, then subagent logs. These are what a PR scan reads. */
export function pullRequestScanPaths(record: AgentSessionRecord): string[] {
  return [record.logFilePath, ...subagentPaths(record)]
}

/** True when the last remembered scan did not see these log sizes. */
export function needsPullRequestScan(
  record: AgentSessionRecord,
  key: string = pullRequestScanKey(record)
): boolean {
  return scannedPrs.get(record.sessionId)?.key !== key
}

/** Last scanned PRs for the session. Never reads a log file. */
export function getCachedPullRequests(
  record: AgentSessionRecord
): SessionPullRequest[] {
  return scannedPrs.get(record.sessionId)?.prs ?? []
}

export function getMergedPullRequests(
  record: AgentSessionRecord
): SessionPullRequest[] {
  const subagents = subagentPaths(record)
  // Key before reading: growth during the scan then shows up as a new key.
  const key = keyFor(record, subagents)
  const prs = scanMergedPullRequests(record, subagents)
  rememberScan(record, key, prs)
  return prs
}

/**
 * Scans the session's logs and remembers the result under `key` (computed
 * before the scan). Returns true when the PR list changed from the last
 * remembered scan (including becoming empty).
 */
export function rescanPullRequests(
  record: AgentSessionRecord,
  key: string = pullRequestScanKey(record)
): boolean {
  return rememberScan(
    record,
    key,
    scanMergedPullRequests(record, subagentPaths(record))
  )
}

/** Reads one log's new bytes into the PR extractor's per-file cache. */
export function warmPullRequestScan(
  record: AgentSessionRecord,
  logPath: string
): void {
  getSessionPullRequests(
    logPath,
    logPath === record.logFilePath ? record.lastKnownLogSize : undefined
  )
}

function scanMergedPullRequests(
  record: AgentSessionRecord,
  subagents: string[]
): SessionPullRequest[] {
  const paths = [record.logFilePath, ...subagents]
  const seen = new Set<string>()
  const prs: SessionPullRequest[] = []
  for (let i = 0; i < paths.length; i++) {
    // knownSize fast path applies only to the main log (index 0).
    const found = getSessionPullRequests(
      paths[i],
      i === 0 ? record.lastKnownLogSize : undefined
    )
    for (const pr of found) {
      if (seen.has(pr.url)) continue
      seen.add(pr.url)
      prs.push(pr)
    }
  }
  return prs
}

export interface ToAgentSessionOptions {
  /** Use last scanned PRs instead of reading log files (dormant lists). */
  cachedPrsOnly?: boolean
}

export function toAgentSession(
  record: AgentSessionRecord,
  options?: ToAgentSessionOptions
): AgentSession {
  return {
    sessionId: record.sessionId,
    logFilePath: record.logFilePath,
    projectPath: record.projectPath,
    agentType: record.agentType,
    displayName: record.displayName,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    isActive: record.currentWindow !== null,
    host: config.hostLabel,
    lastUserMessage: record.lastUserMessage
      ? record.lastUserMessage.slice(0, 250)
      : undefined,
    isHibernating: record.isHibernating,
    lastResumeError: record.lastResumeError ?? undefined,
    prs: options?.cachedPrsOnly
      ? getCachedPullRequests(record)
      : getMergedPullRequests(record),
  }
}

export function deriveDisplayName(
  projectPath: string,
  sessionId: string,
  fallback?: string
): string {
  if (fallback && fallback.trim()) {
    return fallback.trim()
  }
  if (projectPath) {
    const leaf = path.basename(projectPath)
    if (leaf) return leaf
  }
  return sessionId.slice(0, 8)
}
