// Makes killing the last window of a grouped tmux session safe on tmux 3.7b.
//
// Incident (2026-10-04): `kill-window` on the last window of the external
// session `cgl` segfaulted tmux 3.7b and took down the whole server:
//   cmd_find_from_nothing <- notify_session <- session_destroy
//   <- server_destroy_session_group <- server_kill_window
//
// Mechanism (server-fn.c, session.c, cmd-find.c): server_kill_window walks
// every session containing the window. session_detach on a group member
// whose last winlink is removed leaves that member's s->curw pointing at the
// freed winlink. server_destroy_session_group then destroys the members one
// by one, and each session_destroy runs notify_session ->
// cmd_find_from_nothing -> cmd_find_best_session. That picks the session with
// the most recent activity_time and dereferences its s->curw. If the pick is
// a still-alive member with a dangling curw (here agentboard's grouped mirror
// `<base>-ws-<conn>-x-cgl-<hash>`, active 0.5s earlier), it is a
// use-after-free. The trigger is a second live member of the group with
// recent activity at kill time; attached clients are incidental.
//
// Invariant enforced here: when kill-window runs, no other live session is in
// the target's group. (tmux never dissolves a group, so the target keeps its
// group name and still takes the group-destroy path; with no other member
// there is no dangling curw for cmd_find_best_session to pick.)
//
// Steps:
//   1. Move clients off the other members before they die, so browser
//      proxies land on their own `<base>-ws-<conn>` session (where a normal
//      kill leaves them) instead of being detached. Other clients on those
//      members are detached. Clients on the target session itself are left
//      alone; tmux applies their detach-on-destroy setting as usual.
//   2. Kill the other members. They share the doomed window set.
//   3. Repeat once: a proxy switch in flight can create a new mirror with a
//      synchronous `new-session -t` after the first snapshot.
//   4. Re-list the group immediately before the kill and refuse (throw) if
//      any other member is still alive, if a member kill failed, or if any
//      tmux call timed out. The caller then reports kill_failed instead of
//      running the crash path.
// Residual race: a mirror created between the final check and the
// kill-window spawn is not seen. That window is one synchronous spawn wide.
//
// Mutations stop at the first tmux timeout: each one can block the event
// loop for the mutation timeout, and the kill is refused anyway.

import { buildTmuxFormat, splitTmuxFields, splitTmuxLines, withTmuxUtf8Flag } from './tmuxFormat'
import { isTmuxTimeoutError } from './tmuxTimeout'

export type KillGuardRunner = (args: string[]) => string

const SESSION_GROUP_FORMAT = buildTmuxFormat(['#{session_name}', '#{session_group}'])
const CLIENT_SESSION_FORMAT = buildTmuxFormat(['#{client_name}', '#{client_session}'])
const EXTERNAL_MIRROR_MARKER = '-x-'
const EVACUATION_PASSES = 2
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
  /** A tmux call timed out; no further mutations were issued. */
  timedOut: boolean
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
 * Establishes the invariant above for killing the last window of
 * `targetSession`, or throws GroupKillRefusedError. Never kills the target.
 */
export function prepareGroupedLastWindowKill(
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
    timedOut: false,
  }
  const refuse = (reason: string): never => {
    throw new GroupKillRefusedError(
      `refusing to kill last window of grouped session ${targetSession}: ${reason}`,
      result
    )
  }
  const attempt = (args: string[], target: string): boolean => {
    if (result.timedOut) return false
    try {
      runTmux(args)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : String(error)
      if (isTmuxTimeoutError(error)) result.timedOut = true
      if (result.timedOut || !ALREADY_GONE.test(message)) {
        result.failed.push({ command: args[0] ?? '', target, error: message })
      }
      return false
    }
  }
  const list = (args: string[]): string => {
    try {
      return runTmux(withTmuxUtf8Flag(args))
    } catch (error) {
      if (isTmuxTimeoutError(error)) result.timedOut = true
      return refuse(`tmux ${args[0]} failed: ${error instanceof Error ? error.message.trim() : String(error)}`)
    }
  }

  // An empty read with no mutation after it doubles as the final check.
  let verifiedEmpty = false
  for (let pass = 0; pass < EVACUATION_PASSES && !result.timedOut; pass++) {
    const { all, members } = readGroup(list, targetSession, group)
    if (members.size === 0) {
      verifiedEmpty = true
      break
    }
    for (const line of splitTmuxLines(list(['list-clients', '-F', CLIENT_SESSION_FORMAT]))) {
      const fields = splitTmuxFields(line, 2)
      const client = fields?.[0]
      const session = fields?.[1]
      // Only clients on sessions about to be killed; the target's own
      // clients follow their detach-on-destroy setting.
      if (!client || !session || !members.has(session)) continue
      const home = proxySessionForMirror(session, wsPrefix)
      if (home && all.has(home) && !members.has(home) && home !== targetSession) {
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
  }

  if (result.timedOut) refuse('a tmux command timed out')
  const failedKills = result.failed.filter((entry) => entry.command === 'kill-session')
  if (failedKills.length > 0) {
    refuse(`could not kill ${[...new Set(failedKills.map((entry) => entry.target))].join(', ')}`)
  }
  const survivors = verifiedEmpty ? new Set<string>() : readGroup(list, targetSession, group).members
  if (survivors.size > 0) {
    refuse(`other members still alive: ${[...survivors].join(', ')}`)
  }
  return result
}

function readGroup(
  list: (args: string[]) => string,
  targetSession: string,
  group: string
): { all: Set<string>; members: Set<string> } {
  const all = new Set<string>()
  const members = new Set<string>()
  for (const line of splitTmuxLines(list(['list-sessions', '-F', SESSION_GROUP_FORMAT]))) {
    const fields = splitTmuxFields(line, 2)
    if (!fields?.[0]) continue
    all.add(fields[0])
    if (fields[1] === group && fields[0] !== targetSession) members.add(fields[0])
  }
  return { all, members }
}
