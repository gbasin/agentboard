// Non-blocking counterpart of SessionManager's runTmux, for read-only probes on
// the periodic refresh path. Bun.spawnSync holds the event loop until tmux
// answers; when the tmux server is slow (memory pressure, swap) that is
// hundreds of ms per call, every refresh tick. Bun.spawn waits off the JS
// thread, so terminal streaming and WebSocket traffic keep flowing.
//
// Same contract as the sync runner: tmuxTimeoutMs bound, TmuxTimeoutError on
// a kill by the timeout, Error(stderr) on a nonzero exit, stdout otherwise.

import { config } from './config'
import { TmuxTimeoutError } from './tmuxTimeout'
import { sanitizedTmuxEnv } from './tmuxEnv'

export type TmuxRunnerAsync = (args: string[]) => Promise<string>

export async function runTmuxAsync(args: string[]): Promise<string> {
  const command = args[0] === '-u' ? args[1] ?? 'command' : args[0] ?? 'command'
  const timeout = config.tmuxTimeoutMs
  const proc = Bun.spawn(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
    // Same reason as the sync runner: if this call boots the tmux server,
    // the daemon keeps this environment for every future pane.
    env: sanitizedTmuxEnv(),
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  // A signal death leaves exitCode null (proc.exited resolves 128+signal).
  if (proc.signalCode === 'SIGTERM' || proc.exitCode === null) {
    throw new TmuxTimeoutError(command, timeout)
  }
  if (proc.exitCode !== 0) {
    throw new Error(stderr || 'tmux command failed')
  }
  return stdout
}
