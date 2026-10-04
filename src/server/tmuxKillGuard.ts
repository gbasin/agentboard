// Kills the last window of a grouped tmux session without crashing tmux 3.7b.
// Uses only commands and formats available in tmux 3.2+.
//
// Incident (2026-10-04): `kill-window` on the last window of the external
// session `cgl` segfaulted tmux 3.7b and took down the whole server:
//   cmd_find_from_nothing <- notify_session <- session_destroy
//   <- server_destroy_session_group <- server_kill_window
//
// Mechanism (server-fn.c, session.c, cmd-find.c): server_kill_window walks
// the sessions containing the window. The first one in name order has its
// last winlink removed by session_detach, which leaves that session's
// s->curw pointing at the freed winlink. server_destroy_session_group then
// destroys the group members one by one, and each session_destroy runs
// notify_session -> cmd_find_from_nothing -> cmd_find_best_session, which
// picks the session with the most recent activity_time and dereferences its
// curw. The crash needs the damaged member to still be alive and be picked
// while another member is being destroyed. In the incident that was
// agentboard's grouped mirror `agentboard-ws-<conn>-x-cgl-<hash>`: it sorts
// before `cgl`, so it was the damaged member, and it had been active 0.5s
// earlier, so cmd_find_best_session picked it.
//
// Fix: for the last window of a grouped session, agentboard never runs
// kill-window. It destroys the sessions one at a time with plain
// `kill-session` (no flags newer than tmux 3.2): first every other member of
// the group, then the target. session_destroy only unlinks that session's
// own winlinks, so it never leaves another member's curw dangling, and the
// shared window is freed when its last link goes. Even if a member reappears
// (a proxy's `new-session -t`) between the member kills and the target kill,
// destroying the target with that member alive does not go through
// server_kill_window -> session_detach, so it cannot reach the crash. Such a
// late member would be left holding the window, so a best-effort sweep after
// the target kill lists the group again (the group name persists on its
// members) and kills whatever is left.
//
// Semantic difference: kill-window removes the window from every session;
// killing the sessions keeps it alive in sessions outside the group that
// link it (link-window). For the last window of an external session that is
// what we want: we end the session, not someone else's link.
//
// Before the kills, clients on the other members are moved off them:
// browser proxies on a mirror go back to their own `<base>-ws-<conn>`
// session (where a normal kill leaves them), so detach-on-destroy does not
// kill the proxy's attach process; other clients on members are detached.
// Clients on the target session itself are left alone and follow their own
// detach-on-destroy setting. A tmux timeout before the target kill stops all
// further tmux calls and refuses the kill: proceeding would detach a proxy
// that could not be moved and leave it dead. An unparseable listing also
// refuses.

import { buildTmuxFormat, splitTmuxFields, splitTmuxLines, withTmuxUtf8Flag } from './tmuxFormat'
import { isTmuxTimeoutError } from './tmuxTimeout'

export type KillGuardRunner = (args: string[]) => string

const SESSION_GROUP_FORMAT = buildTmuxFormat(['#{session_name}', '#{session_group}'])
const CLIENT_SESSION_FORMAT = buildTmuxFormat(['#{client_name}', '#{client_session}'])
const EXTERNAL_MIRROR_MARKER = '-x-'
// The client or session we were removing is already gone: not a failure.
const ALREADY_GONE = /can't find (client|session)|no such (client|session)/i

export interface GroupEvacuation {
  /** Other members killed before the target. */
  killedSessions: string[]
  /** Members found and killed by the sweep after the target kill. */
  sweptSessions: string[]
  /** Clients moved to another session. */
  switchedClients: Array<{ client: string; session: string }>
  /** Clients detached because they had no safe session to move to. */
  detachedClients: string[]
  /** Steps that failed for a reason other than their target being gone. */
  failed: Array<{ command: string; target: string; error: string }>
}

/** Thrown when the last window of a grouped session cannot be killed safely. */
export class GroupKillRefusedError extends Error {
  constructor(
    message: string,
    readonly evacuation: GroupEvacuation
  ) {
    super(message)
    this.name = 'GroupKillRefusedError'
  }
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
 * Moves clients off the other members of `targetSession`'s group, kills
 * those members, then kills the target session, then sweeps the group for
 * late members. Throws
 * GroupKillRefusedError (before any kill) when tmux cannot be read reliably
 * or a client move times out.
 */
export function killGroupedSessionLastWindow(
  runTmux: KillGuardRunner,
  targetSession: string,
  group: string,
  wsPrefix: string
): GroupEvacuation {
  const result: GroupEvacuation = {
    killedSessions: [],
    sweptSessions: [],
    switchedClients: [],
    detachedClients: [],
    failed: [],
  }
  const refuse = (reason: string): never => {
    throw new GroupKillRefusedError(
      `refusing to kill last window of grouped session ${targetSession}: ${reason}`,
      result
    )
  }
  const message = (error: unknown) => (error instanceof Error ? error.message.trim() : String(error))
  const list = (args: string[], fieldCount: number): string[][] => {
    let output = ''
    try {
      output = runTmux(withTmuxUtf8Flag(args))
    } catch (error) {
      refuse(`tmux ${args[0]} failed: ${message(error)}`)
    }
    return splitTmuxLines(output).map((line) => {
      const fields = splitTmuxFields(line, fieldCount)
      if (!fields?.[0]) refuse(`unparseable tmux ${args[0]} row: ${JSON.stringify(line)}`)
      return fields as string[]
    })
  }
  // Returns false when the step failed; a timeout refuses the whole kill.
  const step = (args: string[], target: string): boolean => {
    try {
      runTmux(args)
      return true
    } catch (error) {
      const text = message(error)
      if (isTmuxTimeoutError(error)) {
        result.failed.push({ command: args[0] ?? '', target, error: text })
        refuse('a tmux command timed out')
      }
      if (!ALREADY_GONE.test(text)) {
        result.failed.push({ command: args[0] ?? '', target, error: text })
      }
      return false
    }
  }

  const all = new Set<string>()
  const members = new Set<string>()
  for (const [name, sessionGroup] of list(['list-sessions', '-F', SESSION_GROUP_FORMAT], 2)) {
    all.add(name!)
    if (sessionGroup === group && name !== targetSession) members.add(name!)
  }

  if (members.size > 0) {
    for (const [client, session] of list(['list-clients', '-F', CLIENT_SESSION_FORMAT], 2)) {
      if (!session || !members.has(session)) continue
      const home = proxySessionForMirror(session, wsPrefix)
      if (home && all.has(home) && !members.has(home) && home !== targetSession) {
        if (step(['switch-client', '-c', client!, '-t', `=${home}`], client!)) {
          result.switchedClients.push({ client: client!, session: home })
          continue
        }
      }
      if (step(['detach-client', '-t', client!], client!)) {
        result.detachedClients.push(client!)
      }
    }
  }

  for (const member of members) {
    if (step(['kill-session', '-t', `=${member}`], member)) {
      result.killedSessions.push(member)
    }
  }

  // The kill itself: errors propagate to the caller as a failed kill.
  runTmux(['kill-session', '-t', `=${targetSession}`])

  // Best-effort sweep for a member created after the listing above. The
  // target is already gone, so nothing here may throw.
  try {
    for (const line of splitTmuxLines(runTmux(withTmuxUtf8Flag(['list-sessions', '-F', SESSION_GROUP_FORMAT])))) {
      const [name, sessionGroup] = splitTmuxFields(line, 2) ?? []
      if (!name || sessionGroup !== group) continue
      try {
        runTmux(['kill-session', '-t', `=${name}`])
        result.sweptSessions.push(name)
      } catch (error) {
        const text = message(error)
        if (!ALREADY_GONE.test(text)) result.failed.push({ command: 'kill-session', target: name, error: text })
      }
    }
  } catch (error) {
    result.failed.push({ command: 'list-sessions', target: group, error: message(error) })
  }
  return result
}
