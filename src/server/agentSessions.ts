import path from 'node:path'
import type { AgentSession, SessionPullRequest } from '../shared/types'
import { config } from './config'
import type { AgentSessionRecord } from './db'
import { getSessionPullRequests } from './prExtractor'
import { getSubagentLogPaths } from './subagentLogs'

// PRs found by the last full scan per session, keyed with the log size the
// scan saw. Lets dormant lists be built without touching any log file.
const MAX_SCANNED_ENTRIES = 5000
const scannedPrs = new Map<
  string,
  { size: number | null; prs: SessionPullRequest[] }
>()

function rememberScan(record: AgentSessionRecord, prs: SessionPullRequest[]) {
  scannedPrs.delete(record.sessionId)
  if (scannedPrs.size >= MAX_SCANNED_ENTRIES) {
    const oldest = scannedPrs.keys().next().value
    if (oldest !== undefined) scannedPrs.delete(oldest)
  }
  scannedPrs.set(record.sessionId, { size: record.lastKnownLogSize ?? null, prs })
}

/** True when `getMergedPullRequests` has not yet covered this log size. */
export function needsPullRequestScan(record: AgentSessionRecord): boolean {
  const hit = scannedPrs.get(record.sessionId)
  return !hit || hit.size !== (record.lastKnownLogSize ?? null)
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
  const prs = scanMergedPullRequests(record)
  rememberScan(record, prs)
  return prs
}

function scanMergedPullRequests(
  record: AgentSessionRecord
): SessionPullRequest[] {
  const paths = [
    record.logFilePath,
    ...getSubagentLogPaths(
      record.logFilePath,
      record.agentType,
      record.sessionId
    ),
  ]
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
