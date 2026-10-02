// Kills an e2e run's private tmux server together with every process it
// started.
//
// kill-server alone is not enough. tmux closes each pane's pty and relies on
// the kernel to send SIGHUP; a pane process that started up just as its pane
// went away misses that signal. zsh then blocks forever opening its tty, holds
// a pty, and is reparented to launchd (ppid 1) when the server exits. Repeated
// runs exhausted the system's ptys this way. So: record the server's children
// first, kill the server, then SIGKILL whatever of them is left.
//
// Every tmux call here uses an explicit -S socket inside an e2e temp dir with
// TMUX removed from the environment, so it can never reach a live server.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

const E2E_DIR_PREFIX = 'abe2e-'
// A run without a lock file is only considered dead after this long, so a
// concurrently starting run (lock not written yet) is never touched.
const UNLOCKED_STALE_MS = 60 * 60 * 1000

function tmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.TMUX
  return env
}

function tmux(socket: string, args: string[]): string | null {
  const result = spawnSync('tmux', ['-S', socket, ...args], {
    encoding: 'utf-8',
    env: tmuxEnv(),
    timeout: 5000,
  })
  return result.status === 0 ? result.stdout : null
}

export function socketPath(dir: string): string {
  return join(dir, `tmux-${process.getuid?.() ?? 0}`, 'default')
}

function childPids(parentPid: number): number[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' })
  if (result.status !== 0) return []
  const pids: number[] = []
  for (const line of result.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (ppid === parentPid && Number.isInteger(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    // Already exited
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Time the kernel's hangup gets to end pane processes normally before the
// leftovers are counted as survivors and killed.
const HANGUP_GRACE_MS = 1000

/**
 * kill-server on the private socket, then SIGKILL every process the server
 * had started (and each one's process group: pane processes lead their own)
 * that is still alive after a short grace period. Returns how many that was.
 */
export function reapPrivateTmuxServer(socket: string): number {
  if (!existsSync(socket)) return 0
  const serverPid = Number.parseInt(tmux(socket, ['display-message', '-p', '#{pid}']) ?? '', 10)
  const children = Number.isInteger(serverPid) && serverPid > 0 ? childPids(serverPid) : []
  tmux(socket, ['kill-server'])
  const deadline = Date.now() + HANGUP_GRACE_MS
  let alive = children.filter(isAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(50)
    alive = alive.filter(isAlive)
  }
  for (const pid of alive) {
    signal(-pid, 'SIGKILL')
    signal(pid, 'SIGKILL')
  }
  return alive.length
}

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// tmux records resolved paths (/private/tmp on macOS), so compare real paths.
function isInside(child: string, parent: string): boolean {
  const rel = relative(real(parent), real(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function runIsDead(dir: string, now: number): boolean {
  const lockFile = join(dir, 'server.lock')
  if (!existsSync(lockFile)) {
    return now - statSync(dir).mtimeMs > UNLOCKED_STALE_MS
  }
  try {
    const { pid } = JSON.parse(readFileSync(lockFile, 'utf-8')) as { pid?: number }
    if (!pid) return false
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Reaps private tmux servers left by earlier runs of this checkout that died
 * without teardown (Playwright killed). A server qualifies only if its temp
 * dir is an e2e dir other than the current one, the run's agentboard server
 * is gone, and every session on it was created from inside `repoRoot` — so
 * other checkouts' runs, live or dead, are never touched.
 */
export function reapStaleE2eServers(
  tmpRoot: string,
  currentDir: string,
  repoRoot: string,
  now = Date.now()
): string[] {
  const reaped: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(tmpRoot)
  } catch {
    return reaped
  }
  for (const entry of entries) {
    if (!entry.startsWith(E2E_DIR_PREFIX)) continue
    const dir = join(tmpRoot, entry)
    if (dir === currentDir) continue
    const socket = socketPath(dir)
    if (!existsSync(socket) || !runIsDead(dir, now)) continue
    const paths = tmux(socket, ['list-sessions', '-F', '#{session_path}'])
    if (paths === null) continue
    const sessionPaths = paths.split('\n').map((p) => p.trim()).filter(Boolean)
    if (sessionPaths.length === 0 || !sessionPaths.every((p) => isInside(p, repoRoot))) {
      continue
    }
    reapPrivateTmuxServer(socket)
    rmSync(dir, { recursive: true, force: true })
    reaped.push(dir)
  }
  return reaped
}
