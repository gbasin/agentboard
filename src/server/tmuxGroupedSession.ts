// Creates tmux grouped sessions without leaking the pane tmux throws away.
//
// `new-session -t <group>` always spawns an initial window running the
// default shell as a login shell, then replaces the new session's windows
// with the group's in the same command, destroying that pane immediately
// (cmd-new-session.c, tmux 3.7b). tmux refuses a command together with -t, so
// the throwaway shell cannot be swapped for something harmless.
//
// The pane's pty master closes microseconds after the fork. When that happens
// before the forked child has made the pty its controlling terminal (likely
// when the machine is loaded and the child is not scheduled yet), the
// kernel's hangup has no session to signal. The child then execs the shell;
// zsh opens its own tty during startup (init_io), which blocks forever
// waiting for carrier, holding a pty. Under CPU load about a third of
// creations leaked this way on macOS; each one costs one of the system's
// ~1000 ptys until it is killed by hand.
//
// So: snapshot processes before the call, and afterwards kill every new child
// of the tmux server that is not a live pane and either holds a tty or has not
// exec'd yet (still a tmux fork). Real panes are excluded by pid. tmux's other
// children are jobs (run-shell, if-shell, #() status commands, copy-pipe),
// which run without a tty once exec'd; only a popup (display-popup) created in
// the same few milliseconds could also match.

import { timedSpawnSync } from './syncSpawnTiming'

export interface ProcessRow {
  pid: number
  ppid: number
  tty: string
  comm: string
}

export interface GroupedSessionDeps {
  /** Runs `tmux <args>` against the target server; throws on failure. */
  runTmux: (args: string[]) => string
  /** Lists all processes, or null when the listing failed. */
  listProcesses?: () => ProcessRow[] | null
  /** Kills one process. Errors (already gone) are ignored by the caller. */
  killProcess?: (pid: number) => void
}

export interface GroupedSessionResult {
  /** Throwaway pane processes that were killed. */
  reapedPids: number[]
  /** Why reaping was skipped, if it was. */
  skipped?: 'process-list-failed' | 'server-pid-unknown' | 'pane-list-failed'
}

const NO_TTY = new Set(['', '?', '??', '-'])

export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3] ?? '',
      comm: (match[4] ?? '').trim(),
    })
  }
  return rows
}

type PsSpawnSync = (
  command: string[],
  options: { stdout: 'pipe'; stderr: 'pipe'; timeout: number }
) => { exitCode: number | null; stdout?: Buffer | Uint8Array | null }

export const PS_ARGS = ['ps', '-axo', 'pid=,ppid=,tty=,comm=']

export function listProcessesWithPs(
  spawnSync: PsSpawnSync = timedSpawnSync
): ProcessRow[] | null {
  try {
    const result = spawnSync(PS_ARGS, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    })
    if (result.exitCode !== 0 || !result.stdout) return null
    return parseProcessRows(Buffer.from(result.stdout).toString())
  } catch {
    return null
  }
}

export function killProcessHard(pid: number): void {
  process.kill(pid, 'SIGKILL')
}

function isUnexecedTmuxFork(comm: string): boolean {
  const base = comm.replace(/^-/, '').split('/').pop() ?? ''
  return base === 'tmux' || base.startsWith('tmux:')
}

/**
 * Picks the server children that can only be throwaway panes: new since the
 * `before` snapshot, not a live pane, and holding a tty or still a tmux fork.
 */
export function findThrowawayPanePids(
  before: ReadonlySet<number>,
  after: readonly ProcessRow[],
  serverPid: number,
  panePids: ReadonlySet<number>
): number[] {
  return after
    .filter(
      (row) =>
        row.ppid === serverPid &&
        !before.has(row.pid) &&
        !panePids.has(row.pid) &&
        (!NO_TTY.has(row.tty) || isUnexecedTmuxFork(row.comm))
    )
    .map((row) => row.pid)
}

function parsePidLines(output: string): Set<number> {
  const pids = new Set<number>()
  for (const line of output.split('\n')) {
    const pid = Number.parseInt(line.trim(), 10)
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return pids
}

/**
 * `tmux new-session -d -t <groupTarget> -s <sessionName>`, then kills the
 * login shell tmux spawned for the session's discarded initial window if it
 * is still alive. Throws whatever new-session throws.
 */
export function createGroupedSession(
  deps: GroupedSessionDeps,
  groupTarget: string,
  sessionName: string
): GroupedSessionResult {
  const listProcesses = deps.listProcesses ?? listProcessesWithPs
  const killProcess = deps.killProcess ?? killProcessHard

  const beforeRows = listProcesses()
  // -P -F '#{pid}' prints the tmux server pid, saving a separate query.
  const printed = deps.runTmux([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{pid}',
    '-t',
    groupTarget,
    '-s',
    sessionName,
  ])
  if (!beforeRows) {
    return { reapedPids: [], skipped: 'process-list-failed' }
  }
  const serverPid = Number.parseInt(printed.trim(), 10)
  if (!Number.isInteger(serverPid) || serverPid <= 0) {
    return { reapedPids: [], skipped: 'server-pid-unknown' }
  }
  const afterRows = listProcesses()
  if (!afterRows) {
    return { reapedPids: [], skipped: 'process-list-failed' }
  }
  const before = new Set(beforeRows.map((row) => row.pid))
  // Cheap exit: nothing new under the server, so no need to list panes.
  const fresh = afterRows.filter(
    (row) => row.ppid === serverPid && !before.has(row.pid)
  )
  if (fresh.length === 0) {
    return { reapedPids: [] }
  }
  let panePids: Set<number>
  try {
    panePids = parsePidLines(deps.runTmux(['list-panes', '-a', '-F', '#{pane_pid}']))
  } catch {
    return { reapedPids: [], skipped: 'pane-list-failed' }
  }
  const reapedPids = findThrowawayPanePids(before, fresh, serverPid, panePids)
  for (const pid of reapedPids) {
    try {
      killProcess(pid)
    } catch {
      // Already exited
    }
  }
  return { reapedPids }
}
