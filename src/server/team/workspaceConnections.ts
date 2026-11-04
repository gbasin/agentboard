// Team workspace subscriptions (team-workspace 5.1). Like every human team
// view, the workspace names the team's directory (`teamPath`,
// team-workspace-pages D1) rather than a chat; the resolved team scopes the
// whole read, so an unknown path is refused with no data and a second
// repository's workspace never sees this team's facts — every id in the
// snapshot comes from the addressed team's own stores, and Phase 1 has no
// action that could name a foreign one (links resolve through the task,
// message, and chat views, which keep their own refusals). Open answers with
// one authoritative snapshot; later pushes are full-set replaces the client
// applies, diffed before sending so an unchanged read stays quiet. Publishes
// coalesce per team on a microtask and share one read, so a dispatch pass's
// burst of mailbox changes costs a single projection.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
import type { TeamWorkspaceSnapshot } from '../../shared/teamWorkspace'
import { logger } from '../logger'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'
import type { TeamIdentity } from './teamIdentity'
import { WorkspaceRead } from './workspaceRead'

type WorkspaceClientMessage = Extract<ClientMessage, { type: `team-workspace-${string}` }>

export class WorkspaceConnections {
  /** Per connection: each open view's `teamPath` and the team it resolved to. */
  private readonly subscriptions = new Map<ChatConnection, Map<string, TeamIdentity>>()
  /** Latest open per connection and teamPath, so a close beats a slow open. */
  private readonly pendingOpen = new Map<ChatConnection, Map<string, object>>()
  /** Last diff key sent per connection and teamPath; an equal read is not re-sent. */
  private readonly lastSent = new Map<ChatConnection, Map<string, string>>()
  /** Teams with a publish waiting for the coalescing microtask. */
  private pendingTeams: Set<string> = new Set()
  private publishScheduled = false
  readonly read: WorkspaceRead

  constructor(
    private readonly manager: ChatSessionManager,
    read: WorkspaceRead = new WorkspaceRead(manager),
  ) {
    this.read = read
  }

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pendingOpen.delete(connection)
    this.lastSent.delete(connection)
  }

  /**
   * A committed change of the team's tasks, mail, waiting reasons, or session
   * facts. The read is deferred to a microtask and deduplicated per team, so
   * several triggers in one tick — one dispatch pass, one turn — project the
   * team once.
   */
  publish(teamId: string): void {
    this.pendingTeams.add(teamId)
    if (this.publishScheduled) return
    this.publishScheduled = true
    queueMicrotask(() => {
      this.publishScheduled = false
      const teams = this.pendingTeams
      this.pendingTeams = new Set()
      for (const teamId of teams) {
        // One team's failed projection must neither wedge the schedule nor
        // escape the microtask — on Bun an uncaught throw here exits the
        // process. Log it; the remaining teams still publish, and the next
        // trigger (or an open) retries.
        try {
          this.publishNow(teamId)
        } catch (error) {
          logger.warn('team_workspace_publish_failed', {
            teamId,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          })
        }
      }
    })
  }

  /** Resolves once every publish scheduled so far has been projected and sent. */
  settled(): Promise<void> {
    return this.publishScheduled
      ? new Promise(resolve => queueMicrotask(() => resolve()))
      : Promise.resolve()
  }

  private publishNow(teamId: string) {
    const targets: Array<[ChatConnection, string, TeamIdentity]> = []
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, team] of views) {
        if (team.teamId === teamId) targets.push([connection, teamPath, team])
      }
    }
    if (targets.length === 0) return
    // One read per resolved identity, shared by every subscriber of it. An
    // ordinary team's paths all resolve to one identity (teamIdentity pins
    // the shared groupsRoot); a bare repository's worktrees share a teamId
    // while carrying different groups roots, so they project separately.
    const byIdentity = new Map<string, { team: TeamIdentity; targets: Array<[ChatConnection, string]> }>()
    for (const [connection, teamPath, team] of targets) {
      const identity = `${team.teamId}\0${team.groupsRoot}`
      const group = byIdentity.get(identity) ?? { team, targets: [] }
      group.targets.push([connection, teamPath])
      byIdentity.set(identity, group)
    }
    for (const { team, targets } of byIdentity.values()) {
      const payload = this.read.snapshot(team)
      const key = this.diffKey(payload)
      for (const [connection, teamPath] of targets) {
        const sent = this.lastSent.get(connection)
        if (sent?.get(teamPath) === key) continue
        if (sent) sent.set(teamPath, key)
        else this.lastSent.set(connection, new Map([[teamPath, key]]))
        connection.send({ type: 'team-workspace', teamPath, teamId, ...payload })
      }
    }
  }

  /**
   * The human's team default approval save (team-approval-default D4): the
   * path resolves to its team (a worktree path keys the same row), the policy
   * is checked, the row upserts, and every open view of the team follows on
   * the publish. Existing chats are never touched; only later spawns read it.
   */
  private async setApprovalDefault(
    connection: ChatConnection,
    message: Extract<WorkspaceClientMessage, { type: 'team-workspace-approval-default-set' }>,
  ) {
    const { teamPath } = message
    const policy: unknown = message.policy
    const refuse = (error: string) => connection.send({ type: 'team-workspace-approval-default-result', teamPath, ok: false, error })
    if (policy !== 'manual' && policy !== 'auto') {
      refuse(`The default approval policy must be manual or auto, got ${JSON.stringify(policy)}`)
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      refuse(unknownTeamError(teamPath))
      return
    }
    this.manager.setTeamApprovalDefault(team.teamId, policy)
    connection.send({ type: 'team-workspace-approval-default-result', teamPath, ok: true, policy })
    this.publish(team.teamId)
  }

  /**
   * The diff key: the payload with read-time-derived fields blanked. The
   * summary's window edge (`since`) moves with every read at millisecond
   * precision; comparing it would push a full snapshot on every trigger, so
   * it is exactly what the diff must ignore.
   */
  private diffKey(payload: TeamWorkspaceSnapshot): string {
    return JSON.stringify({ ...payload, summary: { ...payload.summary, since: '' } })
  }

  async handle(connection: ChatConnection, message: WorkspaceClientMessage) {
    if (message.type === 'team-workspace-approval-default-set') return this.setApprovalDefault(connection, message)
    const { teamPath } = message
    if (message.type === 'team-workspace-close') {
      this.pendingOpen.get(connection)?.delete(teamPath)
      this.subscriptions.get(connection)?.delete(teamPath)
      this.lastSent.get(connection)?.delete(teamPath)
      return
    }
    const token = {}
    const pending = this.pendingOpen.get(connection) ?? new Map<string, object>()
    pending.set(teamPath, token)
    this.pendingOpen.set(connection, pending)
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pendingOpen.get(connection)?.get(teamPath) !== token) return
    this.pendingOpen.get(connection)?.delete(teamPath)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    const views = this.subscriptions.get(connection) ?? new Map<string, TeamIdentity>()
    views.set(teamPath, team)
    this.subscriptions.set(connection, views)
    // An open always sends: the snapshot is authoritative, never assumed.
    const payload = this.read.snapshot(team)
    const sent = this.lastSent.get(connection) ?? new Map<string, string>()
    sent.set(teamPath, this.diffKey(payload))
    this.lastSent.set(connection, sent)
    connection.send({ type: 'team-workspace-snapshot', teamPath, teamId: team.teamId, ...payload })
  }
}
