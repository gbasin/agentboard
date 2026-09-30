// Guard against starting a server inside another tmux server's socket.
//
// Agents frequently run *inside* an agentboard tmux window. When one of them
// starts a second server (dev, e2e, "verify") from that shell, every tmux call
// inherits `$TMUX` and lands on the live server's socket. tmux then groups the
// new instance's sessions with the live `agentboard` session, the live board
// lists every window twice, and killing a duplicate kills the real window.
//
// `TMUX_TMPDIR` is the sanctioned escape hatch: tmux honours it only when
// `$TMUX` is unset, so we unset it here on the instance's behalf. It is also
// ignored when the directory is missing (tmux falls back to /tmp, i.e. the
// live socket), so we create it.

import { mkdirSync } from 'node:fs'

export const ALLOW_NESTED_TMUX_ENV = 'AGENTBOARD_ALLOW_NESTED_TMUX'

export type NestedTmuxDecision =
  | { action: 'none' }
  | { action: 'isolate'; tmuxTmpDir: string; inheritedTmux: string }
  | { action: 'allow'; inheritedTmux: string }
  | { action: 'refuse'; inheritedTmux: string; message: string }

type EnvLike = Record<string, string | undefined>

export function decideNestedTmux(env: EnvLike): NestedTmuxDecision {
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
  return {
    action: 'refuse',
    inheritedTmux,
    message:
      `Refusing to start inside a tmux session (TMUX=${inheritedTmux}). ` +
      'Every tmux command would target that server, so this instance would share ' +
      "the live agentboard's windows and could kill them. " +
      'Set TMUX_TMPDIR to a private directory (the e2e harness does this), ' +
      `or set ${ALLOW_NESTED_TMUX_ENV}=true to share the socket on purpose.`,
  }
}

/**
 * Apply the decision to a mutable env (normally `process.env`). Returns the
 * decision so the caller can log it and exit on `refuse`.
 */
export function applyNestedTmuxDecision(env: EnvLike): NestedTmuxDecision {
  const decision = decideNestedTmux(env)
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
