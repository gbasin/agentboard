import path from 'node:path'
import type { AgentSession } from '../shared/types'
import type { AgentSessionRecord } from './db'

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
