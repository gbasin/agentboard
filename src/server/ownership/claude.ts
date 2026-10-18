// Claude's local peer registry supplies identity; never connect to its messaging socket.
import type { ProcessIdentity, PaneIdentity } from './codex'
import { isWithinPane } from './codex'
import path from 'node:path'

export interface ClaudeRecord {
  pid: number
  sessionId: string
  procStart: string
}

export function parseClaudeRecord(text: string, pid: number, platform: string): ClaudeRecord | null {
  try {
    const value = JSON.parse(text)
    if (value.pid !== pid || value.kind !== 'interactive' || value.entrypoint !== 'cli'
      || value.pidDomain !== platform || typeof value.version !== 'string' || !value.version.startsWith('2.')
      || typeof value.procStart !== 'string' || typeof value.sessionId !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.sessionId)) return null
    return { pid, sessionId: value.sessionId, procStart: value.procStart.trim().replace(/\s+/g, ' ') }
  } catch { return null }
}

export function claudeRoots(pane: PaneIdentity, processes: ProcessIdentity[]): ProcessIdentity[] {
  const candidates = processes.filter(process => path.basename(process.command) === 'claude'
    && isWithinPane(process.pid, pane.pid, processes))
  return candidates.filter(process => !candidates.some(other => other.pid !== process.pid
    && isWithinPane(process.pid, other.pid, processes)))
}

export function resolveClaudeRecord(
  process: ProcessIdentity,
  first: ClaudeRecord | null,
  second: ClaudeRecord | null
): { status: 'resolved'; sessionId: string } | { status: 'unresolved'; reason: string } {
  if (!first || !second) return { status: 'unresolved', reason: 'claude_registry_unavailable' }
  if (first.pid !== process.pid || first.procStart !== process.started.trim().replace(/\s+/g, ' ')) {
    return { status: 'unresolved', reason: 'claude_registry_stale_process' }
  }
  if (JSON.stringify(first) !== JSON.stringify(second)) return { status: 'unresolved', reason: 'claude_registry_changed' }
  return { status: 'resolved', sessionId: first.sessionId }
}
