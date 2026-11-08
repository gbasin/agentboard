// Creates tmux grouped sessions; the throwaway shell they leak is reaped
// elsewhere, asynchronously (throwawayShellReaper.ts).
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
// creations leaked this way on macOS.
//
// This runs on every WebSocket connection, so it must stay one tmux call.
// 0.23.0 added two synchronous `ps -axo` here to reap inline; on a starved
// machine each took seconds and the server stopped answering. Do not add
// process listing or any other spawn to this path: onCreated only arms the
// reaper's timer.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let throwawayCwd: string | undefined

/** A private cwd identifies discarded shells even after their server exits.
 * macOS SIP hides system-shell environments, so an env marker is insufficient.
 * Only the temporary initial window uses this directory; grouped windows keep
 * their existing processes and working directories.
 */
export function getThrowawayCwd(): string {
  if (throwawayCwd) return throwawayCwd
  const dir = path.join(os.tmpdir(), `agentboard-tmux-throwaway-${process.getuid!()}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
    throw new Error('Unsafe tmux throwaway directory')
  }
  throwawayCwd = fs.realpathSync(dir)
  return throwawayCwd
}

export interface GroupedSessionDeps {
  /** Runs `tmux <args>` against the target server; throws on failure. */
  runTmux: (args: string[]) => string
  /** Called after the session exists; must not block (see above). */
  onCreated?: () => void
}

/** `tmux new-session -d -t <groupTarget> -s <sessionName>`. Throws whatever it throws. */
export function createGroupedSession(
  deps: GroupedSessionDeps,
  groupTarget: string,
  sessionName: string
): void {
  deps.runTmux(['new-session', '-d', '-t', groupTarget, '-s', sessionName, '-c', getThrowawayCwd()])
  deps.onCreated?.()
}
