/**
 * Resolve the display name for an externally-discovered tmux window.
 *
 * By default, agentboard uses the tmux session name for external windows,
 * because window names often auto-rename to the running process (e.g. `node`,
 * `zsh`) under tmux `automatic-rename on`, which is rarely meaningful.
 *
 * When `preferWindowName` is enabled (via `AGENTBOARD_PREFER_WINDOW_NAME=true`)
 * and the window name is non-empty and distinct from the session name, the
 * window name is used instead. This is useful for users who explicitly name
 * each window after the project they are working on (so all windows in a
 * shared `dev` session show up as `myapp`, `infra`, ... rather than `dev`).
 */
export function resolveExternalDisplayName(
  sessionName: string,
  windowName: string | undefined,
  preferWindowName: boolean
): string {
  if (!preferWindowName) return sessionName
  const trimmed = (windowName ?? '').trim()
  if (!trimmed || trimmed === sessionName) return sessionName
  return trimmed
}
