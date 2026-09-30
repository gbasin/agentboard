// Guard against starting a server from inside an agentboard-managed pane.
//
// Agents frequently run *inside* an agentboard tmux window. When one of them
// starts a second server (dev, e2e, "verify") from that shell, every tmux call
// inherits `$TMUX` and lands on the live server's socket. The new instance
// lists the live windows as external, attaching to them creates grouped
// sessions the live board cannot recognise, and killing one of those
// duplicates kills the real window.
//
// Running agentboard inside the user's *own* tmux session is fine and common,
// so we only refuse when the inherited pane belongs to a session that holds
// agentboard's bootstrap window.
//
// `TMUX_TMPDIR` is the sanctioned escape hatch: tmux honours it only when
// `$TMUX` is unset, so we unset it here on the instance's behalf. It is also
// ignored when the directory is missing (tmux falls back to /tmp, i.e. the
// live socket), so we create it.

import { mkdirSync } from 'node:fs'
import { BOOTSTRAP_WINDOW_NAME } from './tmuxFormat'
import { timedSpawnSync } from './syncSpawnTiming'

export const ALLOW_NESTED_TMUX_ENV = 'AGENTBOARD_ALLOW_NESTED_TMUX'

export type NestedTmuxDecision =
  | { action: 'none' }
  | { action: 'isolate'; tmuxTmpDir: string; inheritedTmux: string }
  | { action: 'allow'; inheritedTmux: string }
  | { action: 'refuse'; inheritedTmux: string; paneSession: string | null; message: string }

type EnvLike = Record<string, string | undefined>

/**
 * Reports whether `pane` belongs to an agentboard-managed session (one holding
 * the bootstrap window) and that session's name. A missing pane or a failed
 * probe counts as managed, so the guard fails closed.
 */
export type ManagedPaneProbe = (pane: string | undefined) => { managed: boolean; session: string | null }

export function probeManagedPane(pane: string | undefined): { managed: boolean; session: string | null } {
  if (!pane) {
    return { managed: true, session: null }
  }
  const run = (args: string[]) => {
    const result = timedSpawnSync(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 3000 })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr?.toString().trim() || `tmux ${args[0]} failed`)
    }
    return result.stdout.toString()
  }
  try {
    const session = run(['display-message', '-p', '-t', pane, '#{session_name}']).trim()
    const windows = run(['list-windows', '-t', `=${session}`, '-F', '#{window_name}'])
      .split('\n')
      .map((line) => line.trim())
    return { managed: windows.includes(BOOTSTRAP_WINDOW_NAME), session }
  } catch {
    return { managed: true, session: null }
  }
}

export function decideNestedTmux(
  env: EnvLike,
  probe: ManagedPaneProbe = probeManagedPane,
): NestedTmuxDecision {
  const inheritedTmux = env.TMUX?.trim()
  if (!inheritedTmux) {
    return { action: 'none' }
  }
  const tmuxTmpDir = env.TMUX_TMPDIR?.trim()
  if (tmuxTmpDir) {
    return { action: 'isolate', tmuxTmpDir, inheritedTmux }
  }
  if (env[ALLOW_NESTED_TMUX_ENV] === 'true') {
    return { action: 'allow', inheritedTmux }
  }
  const pane = probe(env.TMUX_PANE?.trim() || undefined)
  if (!pane.managed) {
    return { action: 'none' }
  }
  const where = pane.session ? `agentboard session "${pane.session}"` : 'an agentboard-managed tmux session'
  return {
    action: 'refuse',
    inheritedTmux,
    paneSession: pane.session,
    message:
      `Refusing to start from inside ${where} (TMUX=${inheritedTmux}). ` +
      'Every tmux command would target the live server, so this instance would see ' +
      "the live agentboard's windows and could kill them. " +
      'Set TMUX_TMPDIR to a private directory (the e2e harness does this), ' +
      `or set ${ALLOW_NESTED_TMUX_ENV}=true to share the socket on purpose.`,
  }
}

/**
 * Apply the decision to a mutable env (normally `process.env`). Returns the
 * decision so the caller can log it and exit on `refuse`.
 */
export function applyNestedTmuxDecision(
  env: EnvLike,
  probe: ManagedPaneProbe = probeManagedPane,
): NestedTmuxDecision {
  const decision = decideNestedTmux(env, probe)
  const tmuxTmpDir = env.TMUX_TMPDIR?.trim()
  if (tmuxTmpDir) {
    mkdirSync(tmuxTmpDir, { recursive: true, mode: 0o700 })
  }
  if (decision.action === 'isolate') {
    // Unset rather than override: tmux ignores TMUX_TMPDIR while TMUX is set.
    delete env.TMUX
    delete env.TMUX_PANE
  }
  return decision
}
