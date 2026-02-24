/**
 * Rewrites targets that point at the shared base session so each browser
 * connection stays pinned to its own grouped tmux session.
 */
export function resolveGroupedSessionSwitchTarget(
  target: string,
  baseSession: string,
  groupedSession: string
): string {
  if (!baseSession) return target

  if (target === baseSession) {
    return groupedSession
  }

  const colonIndex = target.indexOf(':')
  if (colonIndex <= 0) return target

  const sessionName = target.slice(0, colonIndex)
  if (sessionName !== baseSession) return target

  const windowPart = target.slice(colonIndex + 1)
  return `${groupedSession}:${windowPart}`
}
