// Limit outcomes for claimed work (profile-routing design D8–D10). Kawai
// tracks, per session, the mail its current turn handles (a delivered
// message, or the parked message a resume belongs to) and the tool calls it
// runs for it. A final limit event marks the turn; when that turn ends, the
// message is resolved — park, release, or forward (limitPolicy.ts):
// - park: the message stays on the agent (state `parked`, which keeps the
//   agent out of group pickup) and a resume message to it is scheduled at
//   the provider's reset;
// - release: back to the group queue, or scheduled to the same session
//   after recovery when direct mail's recipient belongs to no group;
// - forward: a new message to a group or session carries the work on with a
//   handoff package and never routes back to the limited profile; the
//   original agent gets a note naming the task and its new owner once its
//   profile has recovered (durable `team_handoff_notes` rows).
// A successful turn of a parked agent — a human message or the resume —
// unparks it and cancels any resume still queued.
// A final limit in a turn the agent started itself (limit-outcomes-agent-turns)
// parks the session's current work — the newest message delivered to, parked
// on, or resumed by it that it still holds — and never releases or forwards
// it: that instruction may already be complete. A credit limit (a 402,
// openrouter-provider D8) never parks: delivered work takes `otherwise`, and
// an agent-started turn's work is left where it is.
// A human-created session's limited turn that parks nothing schedules one
// direct limit-resume at the reset (limit-resume-unheld-sessions, decision in
// limitResume.ts); a delivered limit-resume is never parked, released, or
// forwarded, and never counts as held work.
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../../db'
import type { ChatHandoffPackage } from '../../../shared/team'
import type { ChatWorker } from '../../../shared/chat'
import type { LimitEvent, LimitOutcome, LimitOutcomeContext } from '../../../shared/routing'
import { runGitAsync } from '../../git/gitCommand'
import { logger } from '../../logger'
import type { GroupDefinition } from '../groupFile'
import { DEFAULT_PARK_IF_RESET_WITHIN_MS } from '../groupFile'
import type { MailboxStore, TeamMessage } from '../mailboxStore'
import { ProgressDigest } from './handoff'
import { DEFAULT_COOLDOWN_MS, isModelScoped, type LimitEventStore } from './limitEvents'
import { CREDIT_LIMIT_WINDOW } from '../../chat/limitSignals'
import { providerOf } from '../../chat/profileCatalog'
import { catalogCtx } from '../cooldowns'
import { MAX_PARKS, resolveLimit, type LimitResolution } from './limitPolicy'
import type { RuleRegistry } from './ruleLoader'
import { isLimitResume, limitResumeAttempt, type LimitResumeEvent, type LimitResumeTurn } from './limitResume'
import { LimitResumeMail } from './limitResumeMail'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_handoff_notes (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  forwarded_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT
);
`

const SYSTEM = { kind: 'system' } as const

export type HandoffTarget = { kind: 'group' | 'session'; id: string }

export interface LimitOutcomesOptions {
  store: MailboxStore
  limits: LimitEventStore
  /** The ambient catalog home for provider resolution (D10), as sessionMailbox passes it. */
  homeDir?: string
  rules: Pick<RuleRegistry, 'rule'>
  getRecord: (id: string) => ChatSessionRecord | undefined
  /** The session's team id; undefined while resolving. */
  teamOf: (id: string) => string | undefined
  /** A group of the session's team. */
  groupOf: (sessionId: string, groupId: string) => GroupDefinition | undefined
  taskTitle: (taskId: string) => string | null
  targetWorktree?: (message: TeamMessage) => string | null
  restoreSession?: (id: string) => void
  onError: (error: unknown) => void
  now?: () => number
}

/** Create the table; part of the frozen baseline step (execution-safety-recovery D13): the baseline step calls this, never the store. */
export function ensureLimitOutcomeSchema(db: Database): void {
  db.exec(CREATE_TABLE_SQL)
}

export class LimitOutcomes {
  /** Session → id of the message its current turn works on. */
  private readonly active = new Map<string, string>()
  /** Message id → tool calls since its claim. */
  private readonly digests = new Map<string, ProgressDigest>()
  /** Session → the final limit event of its current turn. */
  private readonly pending = new Map<string, LimitEvent>()
  /** Sessions whose current turn the agent started itself (D1). */
  private readonly agentTurns = new Set<string>()
  /** Session → the work it was last delivered, resumed on, or parked with (D2). */
  private readonly lastWork = new Map<string, string>()
  /** Limit-resumes of human-created sessions (limit-resume-unheld-sessions). */
  private readonly limitResumes: LimitResumeMail

  constructor(private readonly db: Database, private readonly options: LimitOutcomesOptions) {
    this.limitResumes = new LimitResumeMail(db, {
      store: options.store, getRecord: options.getRecord, teamOf: options.teamOf, now: () => this.now(),
    })
    options.limits.subscribe(event => { if (event.final) this.pending.set(event.sessionId, event) })
  }

  private now() { return this.options.now?.() ?? Date.now() }

  /** Mail was claimed: remember the claimant's HEAD for a later handoff. */
  claimed(message: TeamMessage, sessionId: string): void {
    const cwd = this.options.getRecord(sessionId)?.projectPath
    if (!cwd || message.claimCommit) return
    // A `.then` rejection handler does not see a throw from its own
    // fulfillment handler, so the write that follows the git call has to hang
    // off `.catch` — otherwise a store torn down before the call resolves
    // surfaces as an unhandled rejection.
    void runGitAsync(['rev-parse', 'HEAD'], { cwd }).then(result => {
      if (result.ok && result.stdout.trim()) this.options.store.setClaimCommit(message.id, result.stdout.trim())
    }).catch(this.options.onError)
  }

  /** Mail was pushed as the session's next turn. */
  delivered(sessionId: string, message: TeamMessage): void {
    const workId = this.options.store.parkedFor(message.id)?.id ?? message.id
    this.active.set(sessionId, workId)
    this.lastWork.set(sessionId, workId)
    if (!this.digests.has(workId)) this.digests.set(workId, new ProgressDigest())
  }

  /** A tool call in the session's transcript. */
  toolCall(sessionId: string, tool: string, input: unknown): void {
    const workId = this.active.get(sessionId)
    if (workId) this.digests.get(workId)?.record(tool, input)
  }

  /**
   * A turn opened; every start resets the kind and the delivered work, so
   * neither leaks past an interrupted turn (which never reaches turnEnded).
   * A delivery opens its turn before `delivered()` records the work.
   */
  turnStarted(sessionId: string, agentStarted: boolean): void {
    this.active.delete(sessionId)
    // A final limit of an interrupted turn (which never reached turnEnded)
    // must not decide this one (limit-resume D8).
    this.pending.delete(sessionId)
    if (agentStarted) this.agentTurns.add(sessionId)
    else this.agentTurns.delete(sessionId)
  }

  /** The session's turn ended (after its mail was settled). */
  async turnEnded(sessionId: string, success: boolean): Promise<void> {
    const event = this.pending.get(sessionId)
    this.pending.delete(sessionId)
    const workId = this.active.get(sessionId)
    this.active.delete(sessionId)
    const agentTurn = this.agentTurns.delete(sessionId)
    const work = workId ? this.options.store.get(workId) : null
    // A delivered limit-resume is never resolved as work (limit-resume D3).
    const limitResume = work && isLimitResume(work.tags) ? work : null
    if (limitResume) this.digests.delete(limitResume.id)
    if (event && workId && !limitResume) {
      await this.resolve(workId, sessionId, event)
      return
    }
    // Held work decides the limit-resume's O2 row; read before any park.
    const held = this.currentWork(sessionId) !== null
    // The result subtype is ignored: the CLI has reported success after a
    // final limit, so the recorded event decides (D3).
    if (event && agentTurn) {
      this.parkCurrent(sessionId, event)
    } else if (success && !event && !(agentTurn && !workId)) {
      // A successful agent-started turn leaves parked work and its resume (D4).
      // Only a human turn or this work's own resume can complete parked work.
      for (const parked of this.options.store.parkedBy(sessionId)) {
        if (!workId || workId === parked.id) this.unpark(parked)
      }
    }
    if (workId && !limitResume) return
    const turn: LimitResumeTurn = limitResume
      ? { kind: 'limit-resume', attempt: limitResumeAttempt(limitResume.tags) }
      : { kind: agentTurn ? 'agent' : 'human' }
    const limit: LimitResumeEvent = !event ? { kind: 'none' }
      : event.window === CREDIT_LIMIT_WINDOW ? { kind: 'credit' }
        : { kind: 'final', resetsAt: Date.parse(this.resetTime(event)) }
    this.limitResumes.turnEnded(sessionId, { turn, success, event: limit, held })
  }

  /** The session's worker roster changed: limit-failed workers reach its limit-resume (limit-resume D5). */
  workersChanged(sessionId: string, workers: readonly ChatWorker[]): void {
    this.limitResumes.workersChanged(sessionId, workers)
  }

  /** The session was archived: its pending limit-resume must not restore it (limit-resume D6). */
  cancelLimitResume(sessionId: string): void {
    this.limitResumes.cancel(sessionId)
  }

  /**
   * The session's turn ended with its context exhausted
   * (chat-context-exhaustion D4): the exhaustion outcome settles the work, so
   * no limit resolution runs. Ends the turn's bookkeeping and hands back the
   * work it handled (a parked message's id for a resume turn) with the
   * progress recorded since its claim; the digest is dropped with it.
   */
  takeExhaustedWork(sessionId: string): { messageId: string; progress: ChatHandoffPackage['progress'] } | null {
    this.pending.delete(sessionId)
    this.agentTurns.delete(sessionId)
    const workId = this.active.get(sessionId)
    this.active.delete(sessionId)
    if (!workId) return null
    const progress = (this.digests.get(workId) ?? new ProgressDigest()).snapshot()
    this.digests.delete(workId)
    if (this.lastWork.get(sessionId) === workId) this.lastWork.delete(sessionId)
    return { messageId: workId, progress }
  }

  /**
   * The work an agent-started turn's limit parks (D2): the last work while
   * still held, else — after a restart — the newest parked, else the newest
   * held delivered message that is not a resume (a resume points at work).
   */
  private currentWork(sessionId: string): TeamMessage | null {
    // A delivered limit-resume is never work (limit-resume D3).
    const held = this.options.store.heldBy(sessionId).filter(message => !isLimitResume(message.tags))
    const last = this.lastWork.get(sessionId)
    const remembered = last ? held.find(message => message.id === last) : undefined
    if (remembered) return remembered
    const newest = (rows: TeamMessage[], at: (message: TeamMessage) => string | null) =>
      rows.reduce<TeamMessage | null>((best, row) => !best || (at(row) ?? '') >= (at(best) ?? '') ? row : best, null)
    return newest(held.filter(message => message.state === 'parked'), message => message.parkedUntil)
      ?? newest(held.filter(message => message.state === 'delivered' && !message.tags.includes('resume')), message => message.deliveredAt)
  }

  /** A final limit in an agent-started turn parks the current work (D3). */
  private parkCurrent(sessionId: string, event: LimitEvent): void {
    // Waiting creates no credit, and this work is never released or forwarded (D2).
    if (event.window === CREDIT_LIMIT_WINDOW) return
    const work = this.currentWork(sessionId)
    if (!work) return
    const resetsAt = this.resetTime(event)
    if (Date.parse(resetsAt) <= this.now()) return
    const record = this.options.getRecord(sessionId)
    if (work.state === 'parked') {
      // Already parked: only a later reset moves the resume; the count stays.
      if (Date.parse(work.parkedUntil ?? '') < Date.parse(resetsAt)) this.park(work, sessionId, record, resetsAt, false)
      return
    }
    if (work.parkCount >= MAX_PARKS) {
      // Never released: the instruction may be complete. Left as it is.
      logger.warn('limit_agent_turn_park_cap', { sessionId, messageId: work.id, parkCount: work.parkCount })
      return
    }
    this.park(work, sessionId, record, resetsAt)
  }

  /** The human hands a parked message to a group or session (spec: Users can hand off parked work). */
  handOff(messageId: string, target: HandoffTarget): TeamMessage {
    const message = this.options.store.get(messageId)
    if (!message || message.state !== 'parked' || !message.claimedBy) throw new Error('Only parked work can be handed off')
    const holder = this.options.getRecord(message.claimedBy)
    const profileId = holder?.claudeProfileId ?? 'default'
    const lastError = this.options.limits.forProfile(profileId).filter(event => event.final).at(-1)?.message ?? null
    return this.forward(message, message.claimedBy, profileId, lastError, target)
  }

  /** Send due recovery notes; returns nothing, mail goes through the queue. */
  processNotes(): void {
    const rows = this.db.prepare('SELECT * FROM team_handoff_notes WHERE notified_at IS NULL').all() as NoteRow[]
    for (const row of rows) {
      try {
        if (this.cooldownEnd(row.profile_id, row.from_session) !== null) continue
        const forwarded = this.options.store.get(row.forwarded_id)
        const owner = forwarded?.claimedBy
        const recipient = this.options.getRecord(row.from_session)
        if (!recipient || !forwarded) {
          this.markNoted(row.id)
          continue
        }
        if (!owner) continue
        const original = this.options.store.get(row.original_id)
        const task = original?.taskId ? this.options.taskTitle(original.taskId) : null
        const ownerName = this.options.getRecord(owner)?.name ?? owner
        // D15's same case: the note names the provider when the wait it
        // announces was the provider's — the profile's own provider-scoped
        // events — not a model-scoped window's (the profile cools alone).
        // The parked resume keeps naming the limited profile alone.
        const record = this.options.getRecord(row.from_session)
        const provider = providerOf(row.profile_id, catalogCtx(this.options.homeDir, record?.projectPath))
        const providerWaited = this.options.limits.forProfile(row.profile_id)
          .some(event => event.final && !isModelScoped(event.window))
        const namedProvider = providerWaited && provider !== row.profile_id ? ` ${provider}` : ''
        this.options.store.enqueue({
          teamId: row.team_id, toKind: 'session', toId: row.from_session, fromSession: row.from_session,
          fromGroup: recipient.groupId ?? null, originPath: recipient.projectPath, tags: ['handoff-note'],
          taskId: original?.taskId ?? null,
          body: `Your provider${namedProvider} limit has recovered. While it was limited, your work${task ? ` on task "${task}"` : ''} ` +
            `(message ${row.original_id}) was handed to ${ownerName} (session ${owner}). It is theirs now; do not continue it.`,
        })
        this.markNoted(row.id)
      } catch (error) {
        this.options.onError(error)
      }
    }
  }

  /** When the next note could become due (a pending note's cooldown end). */
  nextNoteAt(): number | null {
    const rows = this.db.prepare('SELECT DISTINCT profile_id, from_session FROM team_handoff_notes WHERE notified_at IS NULL').all() as Array<{ profile_id: string; from_session: string }>
    const ends = rows.map(row => this.cooldownEnd(row.profile_id, row.from_session)).filter((end): end is string => end !== null).map(Date.parse)
    return ends.length > 0 ? Math.min(...ends) : null
  }

  /**
   * The profile's effective cooldown end (providers-and-workers D8) with the
   * provider resolved at its session's project path — providerOf falls back
   * to the profile id without a record or catalog entry.
   */
  private cooldownEnd(profileId: string, fromSession: string): string | null {
    const record = this.options.getRecord(fromSession)
    return this.options.limits.cooldownFor(profileId, providerOf(profileId, catalogCtx(this.options.homeDir, record?.projectPath))).until
  }

  private markNoted(id: string) {
    this.db.prepare('UPDATE team_handoff_notes SET notified_at = ? WHERE id = ?').run(new Date(this.now()).toISOString(), id)
  }

  private unpark(message: TeamMessage) {
    this.digests.delete(message.id)
    this.options.store.replaceResume(message.id)
    this.options.store.unpark(message.id)
  }

  private async resolve(workId: string, sessionId: string, event: LimitEvent): Promise<void> {
    const store = this.options.store
    const message = store.get(workId)
    // Work cancelled mid-resume (team-mailbox-management D2) is simply dropped:
    // no park, release, or forward, and no digest left behind.
    if (!message || !['delivered', 'parked'].includes(message.state)) { this.digests.delete(workId); return }
    const record = this.options.getRecord(sessionId)
    const groupId = message.toKind === 'group' ? message.toId : record?.groupId ?? null
    const group = groupId ? this.options.groupOf(sessionId, groupId) : undefined
    const policy = group?.onLimit ?? { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' as const }
    const digest = this.digests.get(workId) ?? new ProgressDigest()
    const now = this.now()
    const resetsAt = this.resetTime(event)
    const ruled = await this.askRule(group, {
      now: new Date(now).toISOString(), profileId: event.profileId,
      providerId: providerOf(event.profileId, catalogCtx(this.options.homeDir, record?.projectPath)),
      sessionId, groupId,
      message: { id: message.id, priority: message.priority, senderGroup: message.fromGroup, tags: message.tags, worktree: this.options.targetWorktree?.(message) ?? null, taskId: message.taskId,
        ...(message.handoff ? { forwardedFromProfile: message.handoff.fromProfile } : {}),
        ...(message.workerChoice ? { worker: message.workerChoice } : {}),
      },
      kind: event.kind, status: event.status, error: event.message, resetsAt, parkCount: message.parkCount,
      progress: { toolCalls: digest.toolCalls, filesTouched: [...digest.files] },
    })
    // A manual handoff or cancel can settle parked work while an async rule is running.
    if (!['delivered', 'parked'].includes(store.get(workId)?.state ?? '')) { this.digests.delete(workId); return }
    const resolution: LimitResolution = resolveLimit({
      toolCalls: digest.toolCalls, resetInMs: Date.parse(resetsAt) - now, parkCount: message.parkCount, policy,
      ...(ruled ? { ruled } : {}),
      ...(event.window === CREDIT_LIMIT_WINDOW ? { credit: true } : {}),
    })
    // If recovery has already happened, retry without briefly pausing the agent.
    if (resolution.type === 'park' && Date.parse(resetsAt) > this.now()) {
      this.park(message, sessionId, record, resetsAt)
    } else if (resolution.type === 'forward') {
      const target = resolution.to ?? this.forwardTarget(sessionId, policy.forwardTo, groupId)
      try {
        if (target) {
          this.forward(message, sessionId, event.profileId, event.message, target)
          return
        }
      } catch (error) {
        this.options.onError(error)
      }
      // A bad explicit destination must not discard the handoff context.
      if (groupId && !(target?.kind === 'group' && target.id === groupId)) {
        try {
          this.forward(message, sessionId, event.profileId, event.message, { kind: 'group', id: groupId })
          return
        } catch (error) { this.options.onError(error) }
      }
      this.release(message, groupId, resetsAt)
    } else {
      this.release(message, groupId, resetsAt)
    }
  }

  /** Without a group, retry direct work on its original session after recovery. */
  private release(message: TeamMessage, groupId: string | null, resetsAt: string) {
    this.options.store.replaceResume(message.id)
    this.options.store.release(message.id, groupId, groupId ? null : resetsAt)
    this.digests.delete(message.id)
  }

  private async askRule(group: GroupDefinition | undefined, ctx: LimitOutcomeContext): Promise<LimitOutcome | undefined> {
    const rule = group ? this.options.rules.rule(group.id) : undefined
    if (!rule?.hasOnLimit) return undefined
    try {
      return await rule.onLimit(ctx)
    } catch (error) {
      this.options.onError(new Error(`onLimit rule for ${group!.id} failed; using the group policy: ${error instanceof Error ? error.message : String(error)}`))
      return undefined
    }
  }

  /** The provider's reset, else the built-in cooldown end. */
  private resetTime(event: LimitEvent): string {
    const reset = event.resetsAt ? Date.parse(event.resetsAt) : NaN
    return new Date(Number.isFinite(reset) ? reset : Date.parse(event.at) + DEFAULT_COOLDOWN_MS).toISOString()
  }

  private park(message: TeamMessage, sessionId: string, record: ChatSessionRecord | undefined, resetsAt: string, countPark = true) {
    const store = this.options.store
    this.lastWork.set(sessionId, message.id)
    store.replaceResume(message.id)
    const resume = store.enqueue({
      teamId: message.teamId, toKind: 'session', toId: sessionId, fromSession: sessionId,
      fromGroup: record?.groupId ?? null, originPath: record?.projectPath ?? message.originPath,
      tags: ['resume'], taskId: message.taskId, deliverAt: resetsAt,
      body: `Your provider limit has reset. Continue the work from message ${message.id}` +
        `${message.taskId ? ` (task ${message.taskId})` : ''} where you left off; check \`git status\` first.`,
    })
    if (!store.park(message.id, resetsAt, resume.id, countPark)) store.cancel(resume.id, SYSTEM)
  }

  /** Resolve a frontmatter `forwardTo`: a team group, else a team session, else the same group. */
  private forwardTarget(sessionId: string, forwardTo: string | undefined, sameGroup: string | null): HandoffTarget | null {
    if (forwardTo) {
      if (this.options.groupOf(sessionId, forwardTo)) return { kind: 'group', id: forwardTo }
      const team = this.options.teamOf(sessionId)
      if (team && this.options.getRecord(forwardTo) && this.options.teamOf(forwardTo) === team) return { kind: 'session', id: forwardTo }
      this.options.onError(new Error(`onLimit.forwardTo "${forwardTo}" is not a group or session of this team; forwarding to the same group`))
    }
    return sameGroup ? { kind: 'group', id: sameGroup } : null
  }

  private forward(message: TeamMessage, fromSession: string, profileId: string, lastError: string | null, target: HandoffTarget): TeamMessage {
    const store = this.options.store
    if (target.kind === 'session') {
      const recipient = this.options.getRecord(target.id)
      if (!recipient || this.options.teamOf(target.id) !== message.teamId) throw new Error('Handoff recipient is not a session of this team')
      if ((recipient.claudeProfileId ?? 'default') === profileId) throw new Error(`Cannot hand off work to its limited profile ${profileId}`)
      // A session on any model of the cooling provider refuses too (D9).
      const fromRecord = this.options.getRecord(fromSession)
      const excludedProvider = providerOf(profileId, catalogCtx(this.options.homeDir, fromRecord?.projectPath))
      if (this.options.limits.providerCooldownUntil(excludedProvider) !== null) {
        const recipientProvider = providerOf(recipient.claudeProfileId ?? 'default', catalogCtx(this.options.homeDir, recipient.projectPath))
        if (recipientProvider === excludedProvider) {
          throw new Error(`Cannot hand off work to ${recipient.claudeProfileId ?? 'default'}: its provider ${excludedProvider}` +
            ` is cooling after the limit on ${profileId}`)
        }
      }
      if (recipient.archivedAt) {
        if (!this.options.restoreSession) throw new Error('Restoring the handoff recipient is not available')
        this.options.restoreSession(target.id)
      }
    } else if (!this.options.groupOf(fromSession, target.id)) {
      throw new Error(`Unknown handoff group: ${target.id}`)
    }
    const digest = this.digests.get(message.id) ?? new ProgressDigest()
    const handoff: ChatHandoffPackage = {
      fromSession, fromProfile: profileId, claimCommit: message.claimCommit, lastError, progress: digest.snapshot(),
    }
    const forwarded = store.enqueue({
      teamId: message.teamId, toKind: target.kind, toId: target.id, fromSession: message.fromSession,
      fromGroup: message.fromGroup, originPath: message.originPath, priority: message.priority, tags: message.tags,
      body: message.body, inReplyTo: message, attachThread: true, taskId: message.taskId,
      handoff, excludedProfile: profileId,
      // The role keeps narrowing the forward, without the limited profile (plan-execution D15).
      allowedProfiles: message.allowedProfiles?.filter(profile => profile !== profileId) ?? null,
      // The sender's worker choice is dropped (dispatch-worker-choice D4): a
      // choice pinned to the limited provider would wait out its reset.
      workerChoice: null,
    })
    store.replaceResume(message.id)
    store.markForwarded(message.id, `forwarded: ${forwarded.id}`)
    this.digests.delete(message.id)
    this.db.prepare(`INSERT INTO team_handoff_notes (id, team_id, from_session, profile_id, original_id, forwarded_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), message.teamId, fromSession, profileId, message.id, forwarded.id,
      new Date(this.now()).toISOString())
    return forwarded
  }
}

interface NoteRow {
  id: string
  team_id: string
  from_session: string
  profile_id: string
  original_id: string
  forwarded_id: string
}
