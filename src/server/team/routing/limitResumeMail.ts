// The mailbox side of limit-resumes (limit-resume-unheld-sessions D1–D7).
// LimitOutcomes hands every turn end that resolved no delivered mail here;
// the pure decision (limitResume.ts) says whether to schedule, replace, or
// cancel the session's one pending `limit-resume` message, and this class
// writes it. The resume is ordinary scheduled direct mail, so it survives a
// restart, shows under Scheduled in the Mailbox tab, and the dispatcher
// delivers it at the reset. The consecutive-resume cap and the workers lost
// since the last successful human or limit-resume turn are kept in memory;
// the attempt number rides in the message's tags.
import type { Database } from 'bun:sqlite'
import type { ChatWorker } from '../../../shared/chat'
import type { ChatSessionRecord } from '../../db'
import { logger } from '../../logger'
import type { MailboxStore, TeamMessage } from '../mailboxStore'
import {
  isLimitFailure, limitResumeAttempt, limitResumeBody, limitResumeDecision, limitResumeTags, mergeWorkerLines, workerLinesOf,
  type LimitResumeEvent, type LimitResumeTurn, type LostWorker,
} from './limitResume'

const SYSTEM = { kind: 'system' } as const

export interface LimitResumeMailOptions {
  store: MailboxStore
  getRecord: (id: string) => ChatSessionRecord | undefined
  /** The session's team id; undefined while resolving. */
  teamOf: (id: string) => string | undefined
  now: () => number
}

export interface LimitResumeTurnEnd {
  turn: LimitResumeTurn
  success: boolean
  event: LimitResumeEvent
  /** The session holds work that is not a limit-resume (read before any park). */
  held: boolean
  /** The worker lines of the delivered limit-resume this turn ran, carried into the next one across restarts (D5). */
  carried?: readonly string[]
}

export class LimitResumeMail {
  /** Sessions whose third consecutive limit-resume hit the limit again (D7). */
  private readonly capped = new Set<string>()
  /** Session → workers seen failing on a limit in this process (D5). */
  private readonly seenFailed = new Map<string, Set<string>>()
  /** Session → workers lost to a limit since its last successful human or limit-resume turn. */
  private readonly lost = new Map<string, LostWorker[]>()

  constructor(private readonly db: Database, private readonly options: LimitResumeMailOptions) {}

  /** Apply the turn-end decision (D2) to the session's mailbox. */
  turnEnded(sessionId: string, end: LimitResumeTurnEnd): void {
    const record = this.options.getRecord(sessionId)
    if (!record) return
    const store = this.options.store
    const pending = store.pendingLimitResume(sessionId)
    const decision = limitResumeDecision({
      spawned: record.spawned === true, teamResolved: this.options.teamOf(sessionId) !== undefined, held: end.held,
      event: end.event, now: this.options.now(), turn: end.turn, success: end.success, capped: this.capped.has(sessionId),
      pending: pending ? { at: Date.parse(pending.deliverAt ?? ''), attempt: limitResumeAttempt(pending.tags) } : null,
    })
    if (decision.capped === 'set') this.capped.add(sessionId)
    else if (decision.capped === 'clear') this.capped.delete(sessionId)
    const lost = this.lost.get(sessionId) ?? []
    if (decision.kind === 'none' && decision.warn) logger.warn('limit_resume_team_unresolved', { sessionId })
    if (decision.kind === 'cancel' && pending) store.cancel(pending.id, SYSTEM, 'the human continued the session')
    if (decision.kind === 'schedule') this.enqueue(sessionId, record, decision.at, decision.attempt, mergeWorkerLines(end.carried ?? [], lost))
    if (decision.kind === 'supersede' && pending) {
      this.replace(sessionId, record, pending, decision.at, mergeWorkerLines(workerLinesOf(pending.body), lost))
    }
    // The lost workers were told, or the human took over: a new run starts empty.
    if (end.success && end.event.kind === 'none' && end.turn.kind !== 'agent') this.lost.delete(sessionId)
  }

  /**
   * The session's worker roster changed (D5): workers newly seen failing on
   * a limit join the lost list, and a pending limit-resume is replaced to
   * name them, keeping its time and attempt.
   */
  workersChanged(sessionId: string, workers: readonly ChatWorker[]): void {
    let seen = this.seenFailed.get(sessionId)
    const fresh: LostWorker[] = []
    for (const worker of workers) {
      if (worker.status !== 'failed' || !isLimitFailure(worker.summary)) continue
      const key = worker.taskId ?? worker.workerId
      if (seen?.has(key)) continue
      if (!seen) { seen = new Set(); this.seenFailed.set(sessionId, seen) }
      seen.add(key)
      fresh.push({ key, description: worker.description ?? worker.agentType ?? 'agent' })
    }
    if (fresh.length === 0) return
    this.lost.set(sessionId, [...(this.lost.get(sessionId) ?? []), ...fresh])
    const pending = this.options.store.pendingLimitResume(sessionId)
    const record = this.options.getRecord(sessionId)
    if (!pending || !record) return
    const existing = workerLinesOf(pending.body)
    const lines = mergeWorkerLines(existing, fresh)
    if (lines.length === existing.length) return
    this.replace(sessionId, record, pending, Date.parse(pending.deliverAt ?? ''), lines)
  }

  /** Cancel the session's pending limit-resume (D6: archive). */
  cancel(sessionId: string): void {
    const pending = this.options.store.pendingLimitResume(sessionId)
    if (pending) this.options.store.cancel(pending.id, SYSTEM, 'the session was archived')
  }

  private enqueue(sessionId: string, record: ChatSessionRecord, at: number, attempt: number, lines: string[]): TeamMessage | null {
    const teamId = this.options.teamOf(sessionId)
    if (!teamId) return null
    return this.options.store.enqueue({
      teamId, toKind: 'session', toId: sessionId, fromSession: sessionId, fromGroup: record.groupId ?? null,
      originPath: record.projectPath, tags: limitResumeTags(attempt), deliverAt: new Date(at).toISOString(),
      body: limitResumeBody(record.claudeProfileId ?? 'default', lines),
    })
  }

  /**
   * Replace the pending limit-resume in one transaction (D4), keeping its
   * attempt. A resume the dispatcher already claimed cannot be cancelled:
   * nothing is enqueued and the claimed one goes ahead.
   */
  private replace(sessionId: string, record: ChatSessionRecord, old: TeamMessage, at: number, lines: string[]): void {
    this.db.transaction(() => {
      if (!this.options.store.cancel(old.id, SYSTEM, 'superseded by a newer limit-resume')) return
      this.enqueue(sessionId, record, at, limitResumeAttempt(old.tags), lines)
    }).immediate()
  }
}
