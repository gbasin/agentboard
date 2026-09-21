// devinLockMatch.ts - Match devin sessions to tmux windows via session locks
//
// Devin CLI writes ~/.local/share/devin/cli/session_locks/<session-id>.lock
// containing the PID of the devin process holding that session. If that PID
// is a descendant of a pane's root process (#{pane_pid}), the session is
// running in that window. This is deterministic - unlike content matching it
// works even when the user's prompt has scrolled off screen.

import fs from 'node:fs'
import path from 'node:path'
import { getDevinSessionLocksDir } from './devinSync'
import type { Session } from '../shared/types'

/** sessionId -> devin process pid */
export function readDevinSessionLocks(
  locksDir = getDevinSessionLocksDir()
): Map<string, number> {
  const locks = new Map<string, number>()
  let entries: string[]
  try {
    entries = fs.readdirSync(locksDir)
  } catch {
    return locks
  }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue
    try {
      const raw = fs.readFileSync(path.join(locksDir, entry), 'utf8').trim()
      const pid = Number.parseInt(raw, 10)
      if (Number.isFinite(pid) && pid > 0) {
        locks.set(entry.slice(0, -'.lock'.length), pid)
      }
    } catch {
      // unreadable lock file - skip
    }
  }
  return locks
}

/** pid -> ppid for every process on the system */
function getProcessTable(): Map<number, number> {
  const table = new Map<number, number>()
  const result = Bun.spawnSync(['ps', '-eo', 'pid=,ppid='], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return table
  for (const line of result.stdout.toString().split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const pid = Number.parseInt(parts[0], 10)
    const ppid = Number.parseInt(parts[1], 10)
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      table.set(pid, ppid)
    }
  }
  return table
}

function getPanePid(tmuxWindow: string): number | null {
  try {
    const result = Bun.spawnSync(
      ['tmux', 'display-message', '-t', tmuxWindow, '-p', '#{pane_pid}'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    if (result.exitCode !== 0) return null
    const pid = Number.parseInt(result.stdout.toString().trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isDescendantOf(
  pid: number,
  ancestorPid: number,
  processTable: Map<number, number>
): boolean {
  let current: number | undefined = pid
  // Guard against cycles with a bounded walk
  for (let i = 0; i < 64 && current !== undefined && current > 1; i++) {
    if (current === ancestorPid) return true
    current = processTable.get(current)
  }
  return false
}

/**
 * Match devin session ids to tmux windows using session lock PIDs.
 * Returns sessionId -> Session for each devin session whose process is a
 * descendant of a window's pane.
 */
export function matchDevinLocksToWindows(
  windows: Session[]
): Map<string, Session> {
  const matches = new Map<string, Session>()
  const locks = readDevinSessionLocks()
  if (locks.size === 0 || windows.length === 0) return matches

  const processTable = getProcessTable()
  if (processTable.size === 0) return matches

  // panePid -> window (a pane has exactly one root pid)
  const paneOwners = new Map<number, Session>()
  for (const window of windows) {
    const panePid = getPanePid(window.tmuxWindow)
    if (panePid !== null) {
      paneOwners.set(panePid, window)
    }
  }
  if (paneOwners.size === 0) return matches

  for (const [sessionId, pid] of locks) {
    for (const [panePid, window] of paneOwners) {
      if (isDescendantOf(pid, panePid, processTable)) {
        matches.set(sessionId, window)
        break
      }
    }
  }
  return matches
}
