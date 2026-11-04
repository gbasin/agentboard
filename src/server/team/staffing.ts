// Worktree staffing (team-tasks design D4/D6, profile-routing D4/D4a):
// queued group mail whose task targets a worktree may get a new member
// spawned there — never past a cap, never by creating a worktree. Routing
// decides whether and on which profile (a `spawn` candidate); this module
// previews whether spawning is possible at all (`spawnContext`) and performs
// it (`spawnFor`). Caps, checked again in the same transaction that reserves
// the message (state `spawning`) and records a durable `team_spawns` row:
// - the group's `max` live members (every non-archived member, spawned or not);
// - the group's per-profile cap on live members of that profile;
// - the team's live spawned sessions (`~/.kawai/teams.json`, default 5);
// - one live spawned member of any group per resolved worktree.
// Pending reservations count toward all four. A failed spawn drops its
// reservation, requeues the message, and backs off; a restart drops every
// reservation and requeues every reserved message (none was ever pushed, so
// receipt recovery has nothing to say about them). Mail for a worktree that
// no longer exists is dead-lettered.
import type { Database } from 'bun:sqlite'
import type { ChatApprovalPolicy } from '../../shared/chat'
import { resolveSpawnApproval, type SpawnApproval } from '../../shared/spawnApproval'
import { TeamApprovalDefaults } from './teamApprovalDefaults'
import type { TeamWorktreeOccupancy } from '../../shared/team'
import type { ChatSessionRecord } from '../db'
import type { SpawnAssignment } from './dispatcher'
import type { MailboxStore, TeamMessage } from './mailboxStore'
import { DEFAULT_MAX_SPAWNED_SESSIONS, type TeamCaps } from './teamCaps'
import type { GroupDefinition } from './groupFile'
import type { TeamIdentity } from './teamIdentity'
import { teamRoster, worktreeWriters, type PendingSpawnRow } from './teamRoster'
import type { TeamWorktrees } from './worktreeRoots'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_spawns (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  worktree TEXT NOT NULL,
  created_at TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'default'
);
`

/** Create the table; part of the frozen baseline step (execution-safety-recovery D13): the baseline step calls this, never the store. */
export function ensureStaffingSchema(db: Database): void {
  db.exec(CREATE_TABLE_SQL)
  migrateTable(db)
}

/** Columns added after the table first shipped. */
function migrateTable(db: Database) {
  const columns = db.prepare('PRAGMA table_info(team_spawns)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'profile_id')) {
    db.exec("ALTER TABLE team_spawns ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'")
  }
}

/** Whether spawning for a message is possible now, before choosing a profile. */
export interface SpawnContext {
  worktree: string
  /** Team cap, the worktree's writer slot, and failure backoff allow a spawn. */
  allowed: boolean
  /** Profiles of the group's pending reservations (they count toward caps). */
  pendingProfiles: string[]
  /** The staffing facts behind `allowed`, for the waiting reasons (D3/D4). */
  facts: StaffingFacts
}

/** Staffing facts a waiting reason reports: counts, occupants, backoff. */
export interface StaffingFacts {
  teamSpawned: number
  teamCap: number
  /** Spawned sessions holding the target worktree's writer slot. */
  worktreeOccupants: string[]
  /** Pending reservations for the target worktree. */
  worktreePending: number
  /** When a failed spawn for this message retries (epoch ms); null = none. */
  backoffRetryAt: number | null
}

/** Capacity facts behind a waiting reason (D3): the same counts the caps use. */
export interface StaffingCapacity extends StaffingFacts {
  /** Live group members plus the group's pending reservations. */
  groupMembers: number
  /** Live-plus-pending group members per profile. */
  onProfile: Record<string, number>
}

/** A spawn request: where, which group, and the group's member settings. */
export interface SpawnRequest {
  projectPath: string
  groupId: string
  profileId?: string
  approvalPolicy: ChatApprovalPolicy
  taskId: string
}

/** Read-only staffing facts for the dispatch preview (task-assignment D6). */
export interface StaffingPreview {
  /** Live members of the group per profile, pending reservations included. */
  liveOnProfile: Record<string, number>
  /** Profiles of the group's pending reservations, as `spawnContext` states them. */
  pendingProfiles: string[]
  /** Live members plus pending reservations of the group. */
  groupMembers: number
  /** The team's live spawned sessions, pending reservations included. */
  teamSpawned: number
  /** Spawned writers already in the worktree; 0 when no worktree is targeted. */
  worktreeWriters: number
}

export type SpawnResult = { ok: true; sessionId: string } | { ok: false; error: string }

/** A failed spawn is not retried for this long, so a broken profile cannot spin. */
const RETRY_AFTER_MS = 30_000

export class WorktreeStaffing {
  private readonly failedAt = new Map<string, number>()
  /** Per-team default approval policy (team-approval-default D3); read uncached. */
  readonly approvalDefaults: TeamApprovalDefaults
  /** Last-read team spawn caps (team-waiting-reasons D3): sync reads for reasons. */
  private readonly teamCapCache = new Map<string, number>()

  constructor(private readonly db: Database, private readonly store: MailboxStore, private readonly options: {
    /** Every live chat session record (archived ones included; filtered here). */
    records: () => Iterable<ChatSessionRecord>
    /** A session's resolved team; undefined while resolving. */
    teamOf: (sessionId: string) => TeamIdentity | undefined
    caps: TeamCaps
    worktrees: TeamWorktrees
    spawn: (request: SpawnRequest) => Promise<SpawnResult>
    /** A spawn failed: its backoff reason is recorded before the requeue publishes (D3). */
    onSpawnBackoff?: (message: TeamMessage, retryAt: number) => void
    onError?: (error: unknown) => void
    now?: () => number
    /** Failure backoff; overridable so tests can watch a retry happen. */
    retryAfterMs?: number
  }) {
    this.approvalDefaults = new TeamApprovalDefaults(db, options.now)
  }

  /**
   * The policy a member of `group` spawned for `teamId` gets, with its source
   * (team-approval-default D2/D5): the one resolution the spawn, the dispatch
   * preview, and the Members row share.
   */
  approvalFor(teamId: string, group: GroupDefinition): SpawnApproval {
    return resolveSpawnApproval(group.approval, this.approvalDefaults.get(teamId))
  }

  /** The failure backoff duration (D5); tests may shorten it to observe retries. */
  private get retryAfterMs(): number { return this.options.retryAfterMs ?? RETRY_AFTER_MS }

  /** The team cap, cached for the sync reason reads (async callers refresh it). */
  private async teamCapOf(teamId: string): Promise<number> {
    const cap = await this.options.caps.maxSpawnedSessions(teamId)
    this.teamCapCache.set(teamId, cap)
    return cap
  }

  /** Last-read team spawn cap; the default until the first async read lands. */
  cachedTeamCap(teamId: string): number {
    return this.teamCapCache.get(teamId) ?? DEFAULT_MAX_SPAWNED_SESSIONS
  }

  /**
   * Startup reconciliation (before the first dispatch): reservations from an
   * interrupted spawn are dropped and their messages queued again. A member
   * that was created before the crash is an ordinary idle member now and
   * picks the message up through normal dispatch.
   */
  reconcile(): void {
    this.db.exec('DELETE FROM team_spawns')
    for (const message of this.store.spawningRows()) this.store.requeue(message.id)
  }

  /**
   * Preview for routing: null when the message is not worktree task mail;
   * `'worktree-missing'` after dead-lettering mail whose worktree is gone.
   * Group `max` and per-profile caps are applied by the candidate builder;
   * `spawnFor` re-checks everything inside its reservation transaction.
   */
  async spawnContext(message: TeamMessage, worktree: string | null): Promise<SpawnContext | 'worktree-missing' | null> {
    if (message.toKind !== 'group' || message.toId === null || !message.taskId || worktree === null) return null
    if (!(await this.options.worktrees.exists(message.teamId, worktree))) {
      this.store.deadLetter(message.id, `worktree-missing: ${worktree}`)
      return 'worktree-missing'
    }
    const now = this.options.now?.() ?? Date.now()
    const failedAt = this.failedAt.get(message.id) ?? null
    const backingOff = failedAt !== null && now - failedAt < this.retryAfterMs
    const teamCap = await this.teamCapOf(message.teamId)
    const counts = this.counts(message.teamId, message.toId, worktree)
    const writers = worktreeWriters(counts.roster.find(entry => entry.worktree === worktree))
    return {
      worktree,
      allowed: !backingOff && counts.teamSpawned < teamCap && counts.worktreeWriters < 1,
      pendingProfiles: pendingProfilesOf(counts.roster, message.toId),
      facts: {
        teamSpawned: counts.teamSpawned,
        teamCap,
        worktreeOccupants: writers.spawnedIds,
        worktreePending: writers.pending,
        backoffRetryAt: backingOff && failedAt !== null ? failedAt + this.retryAfterMs : null,
      },
    }
  }

  /**
   * Spawn a member of `group` on `profileId` in `worktree` and reserve the
   * message for it as its first turn; null when a cap no longer allows it or
   * the spawn failed (the message is queued again).
   */
  async spawnFor(message: TeamMessage, worktree: string, group: GroupDefinition, profileId: string): Promise<SpawnAssignment | null> {
    if (message.toId !== group.id || !message.taskId) return null
    const teamCap = await this.teamCapOf(message.teamId)
    const cap = group.profiles.find(entry => entry.profileId === profileId)?.cap
    const reservation = `spawn-${crypto.randomUUID()}`
    const reserved = this.db.transaction(() => {
      const counts = this.counts(message.teamId, group.id, worktree)
      const onProfile = counts.groupLive.filter(session => session.profile === profileId).length +
        counts.roster.flatMap(entry => entry.pendingSpawns)
          .filter(pending => pending.group === group.id && pending.profile === profileId).length
      if (counts.groupMembers >= group.max || counts.teamSpawned >= teamCap || counts.worktreeWriters >= 1) return false
      if (cap !== undefined && onProfile >= cap) return false
      // The reservation row is inserted before the message flips to
      // `spawning`, so the store notify inside that flip — the only guaranteed
      // `spawning` snapshot — already sees it (team-waiting-reasons D3). A
      // failed reserve throws *inside this transaction*, rolling the insert
      // back; the error reaches the dispatcher's error path instead of
      // returning quietly (review pin): today's silent `return false` would
      // leave the notify unseen either way, but the throw keeps the persisted
      // end state identical to today's reserve-then-insert on both paths.
      this.db.prepare(`INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at, profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(reservation, message.id, message.teamId, group.id, worktree, new Date().toISOString(), profileId)
      if (!this.store.reserveForSpawn(message.id)) {
        throw new Error(`Reserving ${message.id} for a spawn failed: the message left the queue`)
      }
      return true
    })()
    if (!reserved) return null
    let result: SpawnResult
    try {
      result = await this.options.spawn({
        projectPath: worktree, groupId: group.id, approvalPolicy: this.approvalFor(message.teamId, group).policy, taskId: message.taskId,
        // The default profile is the absence of a choice, as for user-created chats.
        ...(profileId !== 'default' ? { profileId } : {}),
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // The new member (a live spawned record) now holds the slot itself.
    this.db.prepare('DELETE FROM team_spawns WHERE id = ?').run(reservation)
    if (!result.ok) {
      const failedAt = this.options.now?.() ?? Date.now()
      this.failedAt.set(message.id, failedAt)
      // The backoff reason is recorded before the requeue notify publishes,
      // so the failure snapshot already carries it with its retry time (D3).
      // The row is read fresh: it is still `spawning` here.
      this.options.onSpawnBackoff?.(this.store.get(message.id) ?? message, failedAt + this.retryAfterMs)
      this.store.requeue(message.id)
      this.options.onError?.(new Error(`Spawning a ${group.id} member on ${profileId} in ${worktree} failed: ${result.error}`))
      return null
    }
    this.failedAt.delete(message.id)
    return { message: this.store.get(message.id)!, sessionId: result.sessionId }
  }

  /**
   * Earliest unexpired failed-spawn retry (epoch ms), for the dispatcher's
   * timer (D5): the minimum-wins `armTimer` learns the backoff's end, so the
   * retry time a reason shows is the moment the retry runs. Re-read on every
   * re-arm; stale entries are cleared when their message leaves the surface.
   */
  nextRetryAt(): number | null {
    const now = this.options.now?.() ?? Date.now()
    let earliest: number | null = null
    for (const at of this.failedAt.values()) {
      const retry = at + this.retryAfterMs
      if (retry <= now) continue
      if (earliest === null || retry < earliest) earliest = retry
    }
    return earliest
  }

  /** The message's backoff retry time (epoch ms), when one is running. */
  backoffRetryAt(messageId: string): number | null {
    const at = this.failedAt.get(messageId)
    return at === undefined ? null : at + this.retryAfterMs
  }

  /** Drop a message's failure backoff: it left the queued surface (D5). */
  clearBackoff(messageId: string): void {
    this.failedAt.delete(messageId)
  }

  /** Drop every backoff whose message left the waiting surface (D5). */
  pruneBackoffs(keep: ReadonlySet<string>): void {
    for (const id of this.failedAt.keys()) if (!keep.has(id)) this.failedAt.delete(id)
  }

  /**
   * Read-only staffing facts for the dispatch preview (task-assignment D6),
   * in a shape this module owns: the same roster counts `spawnFor` re-checks
   * in its reservation transaction, plus the group's live members per
   * profile. Reserves nothing.
   */
  preview(teamId: string, groupId: string, worktree: string | null): StaffingPreview {
    const counts = this.counts(teamId, groupId, worktree ?? '')
    const liveOnProfile: Record<string, number> = {}
    for (const session of counts.groupLive) {
      liveOnProfile[session.profile] = (liveOnProfile[session.profile] ?? 0) + 1
    }
    const pendingProfiles = pendingProfilesOf(counts.roster, groupId)
    for (const profile of pendingProfiles) liveOnProfile[profile] = (liveOnProfile[profile] ?? 0) + 1
    return {
      liveOnProfile,
      pendingProfiles,
      groupMembers: counts.groupMembers,
      teamSpawned: counts.teamSpawned,
      worktreeWriters: worktree === null ? 0 : counts.worktreeWriters,
    }
  }

  /**
   * Capacity facts for a waiting reason (D3): the same roster counts the caps
   * use, minus `excludeMessageId`'s own pending reservation where the caller
   * needs to see independent occupants separately.
   */
  capacity(teamId: string, groupId: string, worktree: string, excludeMessageId?: string): StaffingCapacity {
    const roster = this.roster(teamId)
    const pending = this.pendingFor(teamId)
    const writers = worktreeWriters(roster.find(entry => entry.worktree === worktree))
    const groupLive = roster.flatMap(entry => entry.sessions).filter(session => session.group === groupId)
    const onProfile: Record<string, number> = {}
    for (const session of groupLive) onProfile[session.profile] = (onProfile[session.profile] ?? 0) + 1
    for (const row of pending.filter(row => row.groupId === groupId)) {
      onProfile[row.profileId] = (onProfile[row.profileId] ?? 0) + 1
    }
    return {
      groupMembers: groupLive.length + pending.filter(row => row.groupId === groupId).length,
      teamSpawned: roster.reduce((count, entry) =>
        count + entry.sessions.filter(session => session.spawned).length, 0) + pending.length,
      teamCap: this.cachedTeamCap(teamId),
      worktreeOccupants: writers.spawnedIds,
      worktreePending: pending.filter(row => row.worktree === worktree && row.messageId !== excludeMessageId).length,
      onProfile,
      backoffRetryAt: null,
    }
  }

  /** Live counts behind every cap, pending reservations included. */
  private counts(teamId: string, groupId: string, worktree: string) {
    const roster = this.roster(teamId)
    const writers = worktreeWriters(roster.find(entry => entry.worktree === worktree))
    const groupLive = roster.flatMap(entry => entry.sessions).filter(session => session.group === groupId)
    const pendingOfGroup = roster.reduce((count, entry) => count + entry.pendingSpawns.filter(pending => pending.group === groupId).length, 0)
    return {
      roster,
      groupLive,
      groupMembers: groupLive.length + pendingOfGroup,
      teamSpawned: roster.reduce((count, entry) =>
        count + entry.sessions.filter(session => session.spawned).length + entry.pendingSpawns.length, 0),
      worktreeWriters: writers.spawnedIds.length + writers.pending,
    }
  }

  /**
   * The team's occupancy read model (team-waiting-reasons D4): live sessions
   * per resolved worktree root plus this module's pending reservations. The
   * worktree-writer count and the `worktree-occupied` reason both read it,
   * so the occupant a reason names is the fact that blocked the spawn.
   */
  roster(teamId: string): TeamWorktreeOccupancy[] {
    return teamRoster(teamId, {
      records: [...this.options.records()],
      teamOf: id => this.options.teamOf(id),
      pendingSpawns: this.pendingFor(teamId),
    })
  }

  /** Pending `team_spawns` reservations of a team. */
  pendingFor(teamId: string): PendingSpawnRow[] {
    return this.db.prepare(`SELECT team_id AS teamId, group_id AS groupId, worktree, profile_id AS profileId,
      message_id AS messageId, created_at AS createdAt FROM team_spawns WHERE team_id = ?`)
      .all(teamId) as PendingSpawnRow[]
  }
}

/** Profiles of a group's pending spawn reservations: the one roster read routing and the preview share. */
function pendingProfilesOf(roster: Array<{ pendingSpawns: Array<{ group: string; profile: string }> }>, groupId: string): string[] {
  return roster.flatMap(entry => entry.pendingSpawns).filter(pending => pending.group === groupId).map(pending => pending.profile)
}
