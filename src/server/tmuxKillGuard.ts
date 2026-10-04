// Defuses a tmux crash when killing the last window of a grouped session.
//
// Killing a session's last window, when that session is in a session group,
// goes through server_kill_window -> server_destroy_session_group. On
// 2026-10-04 tmux 3.7b segfaulted in that path (cmd_find_from_nothing <-
// notify_session <- session_destroy) while a browser client was attached to
// agentboard's grouped mirror (`<base>-ws-<conn>-x-<name>-<hash>`) of the
// external session being killed. The whole tmux server died with every
// unrelated agent pane. A bare repro did not crash, so the exact trigger is
// unknown; the defence is to never let tmux run that path with clients
// attached anywhere in the group.
//
// tmux never dissolves a group: once a session has been grouped it keeps its
// group even after every other member is gone, so the final kill-window
// still takes the group-destroy path. What we can control is that no client
// is attached when it does. Before the kill:
//   - clients on other members are moved away (agentboard proxies go back to
//     their own `<base>-ws-<conn>` session, which is where a normal kill
//     leaves them) or detached;
//   - clients on the target session itself are detached, which is what
//     destroying it would do anyway under the default detach-on-destroy;
//   - the other members are killed, since they share the doomed window set.

import { buildTmuxFormat, splitTmuxFields, splitTmuxLines, withTmuxUtf8Flag } from './tmuxFormat'

export type KillGuardRunner = (args: string[]) => string

const SESSION_GROUP_FORMAT = buildTmuxFormat(['#{session_name}', '#{session_group}'])
const CLIENT_SESSION_FORMAT = buildTmuxFormat(['#{client_name}', '#{client_session}'])
const EXTERNAL_MIRROR_MARKER = '-x-'
// The thing we were removing is already gone: not a failure.
const ALREADY_GONE = /can't find (session|client)|no such (session|client)/i

export interface GroupEvacuation {
  /** Other sessions in the doomed group that were killed. */
  killedSessions: string[]
  /** Clients moved to another session. */
  switchedClients: Array<{ client: string; session: string }>
  /** Clients detached because they had no safe session to move to. */
  detachedClients: string[]
  /** Steps that failed for a reason other than the target being gone. */
  failed: Array<{ command: string; target: string; error: string }>
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
 * Leaves no client attached anywhere in the group of `targetSession` and no
 * other member alive, so killing its last window cannot run tmux's
 * group-destroy path with attached clients. List failures throw; mutation
 * failures are collected in `failed`. The caller kills regardless.
 */
export function evacuateSessionGroup(
  runTmux: KillGuardRunner,
  targetSession: string,
  group: string,
  wsPrefix: string
): GroupEvacuation {
  const result: GroupEvacuation = {
    killedSessions: [],
    switchedClients: [],
    detachedClients: [],
    failed: [],
  }
  const attempt = (args: string[], target: string): boolean => {
    try {
      runTmux(args)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : String(error)
      if (!ALREADY_GONE.test(message)) {
        result.failed.push({ command: args[0] ?? '', target, error: message })
      }
      return false
    }
  }

  const allSessions = new Set<string>()
  const members = new Set<string>()
  for (const line of splitTmuxLines(runTmux(withTmuxUtf8Flag(['list-sessions', '-F', SESSION_GROUP_FORMAT])))) {
    const fields = splitTmuxFields(line, 2)
    if (!fields?.[0]) continue
    allSessions.add(fields[0])
    if (fields[1] === group && fields[0] !== targetSession) members.add(fields[0])
  }

  for (const line of splitTmuxLines(runTmux(withTmuxUtf8Flag(['list-clients', '-F', CLIENT_SESSION_FORMAT])))) {
    const fields = splitTmuxFields(line, 2)
    const client = fields?.[0]
    const session = fields?.[1]
    if (!client || !session) continue
    if (session !== targetSession && !members.has(session)) continue
    const home = proxySessionForMirror(session, wsPrefix)
    if (home && allSessions.has(home) && !members.has(home) && home !== targetSession) {
      if (attempt(['switch-client', '-c', client, '-t', `=${home}`], client)) {
        result.switchedClients.push({ client, session: home })
        continue
      }
    }
    if (attempt(['detach-client', '-t', client], client)) {
      result.detachedClients.push(client)
    }
  }

  for (const session of members) {
    if (attempt(['kill-session', '-t', `=${session}`], session)) {
      result.killedSessions.push(session)
    }
  }
  return result
}
