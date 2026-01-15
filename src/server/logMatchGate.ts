import type { LogEntrySnapshot } from './logPollData'

export interface SessionSnapshot {
  sessionId: string
  logFilePath: string
  currentWindow: string | null
  lastActivityAt: string
}

export function getEntriesNeedingMatch(
  entries: LogEntrySnapshot[],
  sessions: SessionSnapshot[],
  { minTokens = 0 }: { minTokens?: number } = {}
): LogEntrySnapshot[] {
  if (entries.length === 0) return []
  const sessionsByLogPath = new Map(
    sessions.map((session) => [session.logFilePath, session])
  )
  const sessionsById = new Map(
    sessions.map((session) => [session.sessionId, session])
  )
  const needs: LogEntrySnapshot[] = []

  for (const entry of entries) {
    if (!entry.sessionId) continue
    if (minTokens > 0 && entry.logTokenCount < minTokens) continue
    const session =
      sessionsByLogPath.get(entry.logPath) ??
      sessionsById.get(entry.sessionId)
    if (!session) {
      needs.push(entry)
      continue
    }
    if (!session.currentWindow) {
      const lastActivity = Date.parse(session.lastActivityAt)
      if (!Number.isFinite(lastActivity) || entry.mtime > lastActivity) {
        needs.push(entry)
      }
    }
  }

  return needs
}

export function shouldRunMatching(
  entries: LogEntrySnapshot[],
  sessions: SessionSnapshot[],
  { minTokens = 0 }: { minTokens?: number } = {}
): boolean {
  return getEntriesNeedingMatch(entries, sessions, { minTokens }).length > 0
}
