/** Window incarnation, not mutable name/status, owns a recovered draft. */
import type { Session } from '@shared/types'
export function recoveryDraftIdentity(session: Session): string {
  const pid = session.agentboardTags?.serverPid
  const serverPid = typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  // Window IDs increase within a tmux server. createdAt can be synthesized
  // anew during backend discovery, so it is only a legacy fallback.
  return JSON.stringify([session.id, session.tmuxWindow, session.host ?? null, session.remote === true,
    serverPid, serverPid === null ? session.createdAt : null])
}
