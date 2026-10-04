// Defuses a tmux crash when killing the last window of a grouped session.
//
// Killing a session's last window destroys every session in its group
// (server_kill_window -> server_destroy_session_group). On 2026-10-04 tmux
// 3.7b segfaulted in that path (cmd_find_from_nothing <- notify_session <-
// session_destroy) while a browser client was attached to agentboard's
// grouped mirror (`<base>-ws-<conn>-x-<name>-<hash>`) of the external session
// being killed. The whole tmux server died with every unrelated agent pane.
// A bare repro did not crash, so the exact trigger is unknown; the defence is
// to never let tmux run that path with a populated group.
//
// Before the kill, each other session in the group loses its clients
// (agentboard proxies are switched back to their own `<base>-ws-<conn>`
// session, which is where they land after a normal kill; any other client is
// detached, as destroying its session would do anyway) and is then killed.
// The final kill-window then destroys a lone, ungrouped session. The killed
// sessions share the doomed window set, so nothing survivable is lost.

import { buildTmuxFormat, splitTmuxFields, splitTmuxLines, withTmuxUtf8Flag } from './tmuxFormat'

export type KillGuardRunner = (args: string[]) => string

const SESSION_GROUP_FORMAT = buildTmuxFormat(['#{session_name}', '#{session_group}'])
const CLIENT_SESSION_FORMAT = buildTmuxFormat(['#{client_name}', '#{client_session}'])
const EXTERNAL_MIRROR_MARKER = '-x-'

export interface GroupEvacuation {
  /** Other sessions in the doomed group that were killed. */
  killedSessions: string[]
  /** Clients moved to `<client>` -> `<session>`. */
  switchedClients: Array<{ client: string; session: string }>
  /** Clients detached because they had no safe session to move to. */
  detachedClients: string[]
}

/**
 * For a grouped `<base>-ws-<conn>-x-...` mirror, returns `<base>-ws-<conn>`.
 * Connection ids are UUIDs (hex and hyphens), so the first `-x-` after the
 * prefix always ends the proxy's own session name.
 */
export function proxySessionForMirror(session: string, wsPrefix: string): string | null {
  if (!session.startsWith(wsPrefix)) return null
  const marker = session.indexOf(EXTERNAL_MIRROR_MARKER, wsPrefix.length)
  if (marker <= wsPrefix.length) return null
  return session.slice(0, marker)
}

/**
 * Empties the session group of `targetSession` (except the target itself) so
 * that killing its last window cannot run tmux's group-destroy path with
 * attached clients. Every step is best-effort; the caller kills regardless.
 */
export function evacuateSessionGroup(
  runTmux: KillGuardRunner,
  targetSession: string,
  group: string,
  wsPrefix: string
): GroupEvacuation {
  const result: GroupEvacuation = { killedSessions: [], switchedClients: [], detachedClients: [] }

  const allSessions = new Set<string>()
  const members = new Set<string>()
  for (const line of splitTmuxLines(runTmux(withTmuxUtf8Flag(['list-sessions', '-F', SESSION_GROUP_FORMAT])))) {
    const fields = splitTmuxFields(line, 2)
    if (!fields?.[0]) continue
    allSessions.add(fields[0])
    if (fields[1] === group && fields[0] !== targetSession) members.add(fields[0])
  }
  if (members.size === 0) return result

  for (const line of splitTmuxLines(runTmux(withTmuxUtf8Flag(['list-clients', '-F', CLIENT_SESSION_FORMAT])))) {
    const fields = splitTmuxFields(line, 2)
    const client = fields?.[0]
    const session = fields?.[1]
    if (!client || !session || !members.has(session)) continue
    const home = proxySessionForMirror(session, wsPrefix)
    try {
      if (home && allSessions.has(home) && !members.has(home) && home !== targetSession) {
        runTmux(['switch-client', '-c', client, '-t', `=${home}`])
        result.switchedClients.push({ client, session: home })
      } else {
        runTmux(['detach-client', '-t', client])
        result.detachedClients.push(client)
      }
    } catch {
      // The client may have gone away meanwhile.
    }
  }

  for (const session of members) {
    try {
      runTmux(['kill-session', '-t', `=${session}`])
      result.killedSessions.push(session)
    } catch {
      // Already gone.
    }
  }
  return result
}
