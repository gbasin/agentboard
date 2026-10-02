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
import { config } from './config'
import { timedSpawnAsync } from './syncSpawnTiming'
import { runTmuxAsync } from './tmuxAsync'
import {
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from './tmuxFormat'
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
async function getProcessTable(): Promise<Map<number, number>> {
  const table = new Map<number, number>()
  // Bounded like the tmux calls: ps can hang under the same memory pressure
  // that stalls tmux. Async so a slow ps never holds the event loop.
  let result: Awaited<ReturnType<typeof timedSpawnAsync>>
  try {
    result = await timedSpawnAsync(['ps', '-eo', 'pid=,ppid='], {
      timeout: config.tmuxTimeoutMs,
    })
  } catch {
    return table
  }
  if (result.exitCode !== 0) return table
  for (const line of result.stdout.split('\n')) {
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

// One list-panes call for every pane's root pid, instead of a display-message
// per window. (It also covers non-active panes, which display-message's
// single #{pane_pid} missed.)
async function getPaneOwners(windows: Session[]): Promise<Map<number, Session>> {
  const owners = new Map<number, Session>()
  const byTmuxWindow = new Map(windows.map((w) => [w.tmuxWindow, w]))
  let stdout: string
  try {
    stdout = await runTmuxAsync(
      withTmuxUtf8Flag([
        'list-panes',
        '-a',
        '-F',
        buildTmuxFormat(['#{session_name}', '#{window_id}', '#{pane_pid}']),
      ])
    )
  } catch {
    // tmux unreachable or failed — no pane owners this cycle
    return owners
  }
  for (const line of splitTmuxLines(stdout)) {
    const parts = splitTmuxFields(line, 3)
    if (!parts) continue
    const [sessionName, windowId, pidRaw] = parts
    const pid = Number.parseInt(pidRaw ?? '', 10)
    if (!Number.isFinite(pid) || pid <= 0) continue
    const window = byTmuxWindow.get(`${sessionName}:${windowId}`)
    if (window) {
      owners.set(pid, window)
    }
  }
  return owners
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
 *
 * ps and tmux list-panes run concurrently and off the event loop (this runs
 * on every log poll that sees a devin entry). Matching starts once both have
 * answered, so the process snapshot can be a few ms older than the pane list.
 */
export async function matchDevinLocksToWindows(
  windows: Session[]
): Promise<Map<string, Session>> {
  const matches = new Map<string, Session>()
  const locks = readDevinSessionLocks()
  if (locks.size === 0 || windows.length === 0) return matches

  const [processTable, paneOwners] = await Promise.all([
    getProcessTable(),
    // panePid -> window (a pane has exactly one root pid)
    getPaneOwners(windows),
  ])
  if (processTable.size === 0 || paneOwners.size === 0) return matches

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
