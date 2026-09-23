import path from 'node:path'
import type { AgentSession, SessionPullRequest } from '../shared/types'
import { config } from './config'
import type { AgentSessionRecord } from './db'
import { getSessionPullRequests } from './prExtractor'
import { getSubagentLogPaths } from './subagentLogs'

export function getMergedPullRequests(
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

export function toAgentSession(record: AgentSessionRecord): AgentSession {
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
    prs: getMergedPullRequests(record),
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
