// Limit-resumes of human-created sessions (limit-resume-unheld-sessions)
// through LimitOutcomes and a real MailboxStore: which turn ends schedule,
// replace, or cancel the session's one pending limit-resume, that a delivered
// limit-resume is never parked, released, or forwarded, the 3-resume cap, and
// lost workers named in the body. Row ids are the design's oracle ids.
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ChatWorker } from '../../shared/chat'
import type { ChatSessionRecord } from '../db'
import { logger } from '../logger'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'

const T0 = Date.parse('2026-11-03T20:20:43.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()

let now: number
let db: Database
let store: MailboxStore
let limits: LimitEventStore
let outcomes: LimitOutcomes
let records: Map<string, ChatSessionRecord>
let unresolved: Set<string>

const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  claudeProfileId: 'default', ...extra,
})

beforeEach(() => {
  now = T0
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  limits = new LimitEventStore(db, () => now)
  unresolved = new Set()
  records = new Map([
    ['me', record('me')],
    ['dev', record('dev', { groupId: 'devs', spawned: true })],
  ])
  outcomes = new LimitOutcomes(db, {
    store, limits, rules: { rule: () => undefined },
    getRecord: id => records.get(id),
    teamOf: id => (records.has(id) && !unresolved.has(id) ? 'team' : undefined),
    groupOf: () => undefined,
    taskTitle: () => null,
    onError: error => { throw error },
    now: () => now,
  })
})
afterEach(() => db.close())

function finalLimit(sessionId: string, resetInMs: number | null, extra: { status?: number; window?: string | null } = {}) {
  limits.record({ profileId: 'default', sessionId, groupId: null, kind: 'rate_limit', final: true, status: extra.status ?? 429,
    message: "You've hit your 5-hour limit", resetsAt: resetInMs === null ? null : iso(now + resetInMs), providerId: null,
    window: extra.window ?? 'five_hour' })
}

/** A turn of the given kind; `limitInMs` records a final limit resetting that far ahead. */
async function turn(sessionId: string, kind: 'human' | 'agent', opts: { limitInMs?: number; success?: boolean; credit?: boolean } = {}) {
  outcomes.turnStarted(sessionId, kind === 'agent')
  if (opts.credit) finalLimit(sessionId, null, { status: 402, window: 'credit' })
  else if (opts.limitInMs !== undefined) finalLimit(sessionId, opts.limitInMs)
  await outcomes.turnEnded(sessionId, opts.success ?? true)
}

/** The dispatcher delivers a message as its own turn, which may end after a limit. */
async function deliverTurn(sessionId: string, message: TeamMessage, opts: { limitInMs?: number; success?: boolean } = {}) {
  store.claim(message.id, sessionId); store.markPushed(message.id); store.markDelivered(message.id)
  outcomes.turnStarted(sessionId, false)
  outcomes.delivered(sessionId, store.get(message.id)!)
  if (opts.limitInMs !== undefined) finalLimit(sessionId, opts.limitInMs)
  await outcomes.turnEnded(sessionId, opts.success ?? true)
}

/** Delivered group mail the session still holds. */
async function heldMail(sessionId: string): Promise<TeamMessage> {
  const message = store.enqueue({ teamId: 'team', toKind: 'session', toId: sessionId, fromSession: 'lead', fromGroup: 'lead', originPath: '/repo', body: 'Plan it' })
  await deliverTurn(sessionId, message)
  return store.get(message.id)!
}

const pending = (sessionId = 'me') => store.pendingLimitResume(sessionId)
const limitResumes = (sessionId = 'me') => (db.prepare(`SELECT id, state FROM team_messages WHERE to_id = ? AND tags LIKE '%"limit-resume"%' ORDER BY rowid`)
  .all(sessionId) as Array<{ id: string; state: string }>)
const failedWorker = (taskId: string, description: string, summary: string): ChatWorker => ({
  workerId: `toolu_${taskId}`, taskId, description, status: 'failed', live: false, elapsedMs: 1000, summary,
})
const LIMIT_SUMMARY = "Agent terminated early due to an API error: You've hit your 5-hour limit (error type rate_limit, HTTP 429, request id req_1)"

describe('scheduling a limit-resume', () => {
  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Human turn hits the limit
  test('O3: a human turn of a human-created session without mail schedules one at the reset', async () => {
    await turn('me', 'human', { limitInMs: 90 * MIN })
    expect(pending()).toMatchObject({
      state: 'queued', toKind: 'session', toId: 'me', fromSession: 'me', deliverAt: iso(now + 90 * MIN),
      tags: ['limit-resume', 'limit-resume-attempt:1'],
    })
    expect(pending()!.body).toStartWith('Your provider limit (default) has reset.')
  })

  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Agent-started turn hits the limit
  test('O4: an agent-started turn holding nothing schedules one', async () => {
    await turn('me', 'agent', { limitInMs: HOUR })
    expect(pending()).toMatchObject({ deliverAt: iso(now + HOUR), tags: ['limit-resume', 'limit-resume-attempt:1'] })
  })

  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Held work parks instead in an agent-started turn
  test('O2: an agent-started turn holding delivered mail parks it and schedules no limit-resume', async () => {
    const mail = await heldMail('me')
    await turn('me', 'agent', { limitInMs: HOUR })
    expect(store.get(mail.id)?.state).toBe('parked')
    expect(limitResumes()).toEqual([])
  })

  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Human turn while holding mail
  test('O2a: a human turn holding delivered mail schedules one and leaves the mail delivered', async () => {
    const mail = await heldMail('me')
    await turn('me', 'human', { limitInMs: HOUR })
    expect(store.get(mail.id)).toMatchObject({ state: 'delivered', parkCount: 0 })
    expect(pending()?.deliverAt).toBe(iso(now + HOUR))
  })

  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Spawned session
  test('O1: a spawned session schedules nothing', async () => {
    await turn('dev', 'human', { limitInMs: HOUR })
    await turn('dev', 'agent', { limitInMs: HOUR })
    expect(limitResumes('dev')).toEqual([])
  })

  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Credit limit
  test('O10: a credit limit schedules nothing', async () => {
    await turn('me', 'human', { credit: true })
    expect(limitResumes()).toEqual([])
  })

  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Reset already passed
  test('O11: a reset not after the turn end schedules nothing', async () => {
    await turn('me', 'human', { limitInMs: 0 })
    expect(limitResumes()).toEqual([])
  })

  test('O17: an unresolved team schedules nothing and warns', async () => {
    const warn = spyOn(logger, 'warn')
    try {
      unresolved.add('me')
      await turn('me', 'human', { limitInMs: HOUR })
      expect(limitResumes()).toEqual([])
      expect(warn.mock.calls.some(call => call[0] === 'limit_resume_team_unresolved')).toBe(true)
    } finally { warn.mockRestore() }
  })

  // @covers: profile-limit-handling › Limited human sessions resume at the reset › Interrupted turn
  test('O19: an interrupted limited turn leaves nothing for the next human turn', async () => {
    outcomes.turnStarted('me', false)
    finalLimit('me', HOUR) // the human stops this turn: it never reaches turnEnded
    await turn('me', 'human')
    expect(limitResumes()).toEqual([])
  })

  test('O19: a stale limit does not stop the next successful human turn from unparking work', async () => {
    const mail = await heldMail('me')
    await turn('me', 'agent', { limitInMs: HOUR }) // parks the mail
    expect(store.get(mail.id)?.state).toBe('parked')
    outcomes.turnStarted('me', true)
    finalLimit('me', 2 * HOUR) // interrupted
    await turn('me', 'human')
    expect(store.get(mail.id)?.state).toBe('delivered')
  })
})

describe('one pending limit-resume', () => {
  // @covers: profile-limit-handling › A session has at most one pending limit-resume › Second limit with a later reset
  test('O6: a later reset replaces the pending one, which is never delivered', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    await turn('me', 'agent', { limitInMs: 2 * HOUR })
    expect(store.get(first.id)?.state).toBe('cancelled')
    expect(limitResumes().filter(row => row.state === 'queued')).toHaveLength(1)
    expect(pending()).toMatchObject({ deliverAt: iso(now + 2 * HOUR), tags: ['limit-resume', 'limit-resume-attempt:1'] })
  })

  // @covers: profile-limit-handling › A session has at most one pending limit-resume › Second limit with an earlier reset
  test('O7: an earlier reset leaves the pending one as it is', async () => {
    await turn('me', 'human', { limitInMs: 2 * HOUR })
    const first = pending()!
    await turn('me', 'human', { limitInMs: HOUR })
    expect(pending()?.id).toBe(first.id)
    expect(limitResumes()).toHaveLength(1)
  })
})

describe('cancelling a pending limit-resume', () => {
  // @covers: profile-limit-handling › The human's own activity cancels a pending limit-resume › Human continues before the reset
  test('O12: a successful human turn cancels it', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    await turn('me', 'human')
    expect(store.get(first.id)?.state).toBe('cancelled')
    expect(pending()).toBeNull()
  })

  test('O15: a failed human turn without a limit leaves it pending', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    await turn('me', 'human', { success: false })
    expect(pending()).not.toBeNull()
  })

  // @covers: profile-limit-handling › The human's own activity cancels a pending limit-resume › Background task completes while waiting
  test('O14: a successful agent-started turn leaves it pending', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    await turn('me', 'agent')
    expect(pending()?.id).toBe(first.id)
  })

  test('O18: archiving cancels it', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    outcomes.cancelLimitResume('me')
    expect(store.get(first.id)?.state).toBe('cancelled')
  })
})

describe('a delivered limit-resume', () => {
  // @covers: profile-limit-handling › Limit-resumes are bounded and never re-routed › Resume hits the limit again
  test('O8: a limited resume turn schedules the next attempt and is not parked or released', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    now += HOUR
    await deliverTurn('me', first, { limitInMs: HOUR })
    expect(store.get(first.id)?.state).toBe('delivered')
    expect(pending()).toMatchObject({ deliverAt: iso(now + HOUR), tags: ['limit-resume', 'limit-resume-attempt:2'] })
  })

  test('O8: after a restart, the next attempt still names the workers of the delivered resume', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    outcomes.workersChanged('me', [failedWorker('a1b9e4ba4fc743796', 'Budget task_get and task_text_read', LIMIT_SUMMARY)])
    const first = pending()!
    // A fresh process: the lost list in memory is gone; the delivered body carries it.
    outcomes = new LimitOutcomes(db, {
      store, limits, rules: { rule: () => undefined }, getRecord: id => records.get(id), teamOf: () => 'team',
      groupOf: () => undefined, taskTitle: () => null, onError: error => { throw error }, now: () => now,
    })
    now += HOUR
    await deliverTurn('me', first, { limitInMs: HOUR })
    expect(pending()?.body).toContain('- "Budget task_get and task_text_read" (task a1b9e4ba4fc743796)')
  })

  // @covers: profile-limit-handling › Limit-resumes are bounded and never re-routed › Cap reached
  test('O9, O5: after the third limited resume none is scheduled, not even by an agent-started turn', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    for (let attempt = 1; attempt <= 3; attempt++) {
      const next = pending()!
      expect(next.tags).toContain(`limit-resume-attempt:${attempt}`)
      now += HOUR
      await deliverTurn('me', next, { limitInMs: HOUR })
    }
    expect(pending()).toBeNull()
    await turn('me', 'agent', { limitInMs: HOUR })
    expect(pending()).toBeNull()
    expect(limitResumes()).toHaveLength(3)
  })

  // @covers: profile-limit-handling › Limit-resumes are bounded and never re-routed › Count restarts after success
  test('O13: a successful resume turn ends the run; the next limit starts at attempt 1', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    now += HOUR
    await deliverTurn('me', pending()!, { limitInMs: HOUR }) // attempt 2 pending
    now += HOUR
    await deliverTurn('me', pending()!) // success
    expect(pending()).toBeNull()
    await turn('me', 'agent', { limitInMs: HOUR })
    expect(pending()?.tags).toContain('limit-resume-attempt:1')
  })

  test('O13: a successful resume turn clears the cap', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    for (let attempt = 1; attempt <= 3; attempt++) { now += HOUR; await deliverTurn('me', pending()!, { limitInMs: HOUR }) }
    await turn('me', 'human', { limitInMs: HOUR }) // the human tries again: a new run
    now += HOUR
    await deliverTurn('me', pending()!) // succeeds
    await turn('me', 'agent', { limitInMs: HOUR })
    expect(pending()?.tags).toContain('limit-resume-attempt:1')
  })

  // @covers: profile-limit-handling › Limit-resumes are bounded and never re-routed › Delivered resume is not held work
  test('a delivered limit-resume is not held work for a later agent-started limit', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    now += HOUR
    await deliverTurn('me', first) // success; the resume stays delivered
    await turn('me', 'agent', { limitInMs: HOUR })
    expect(store.get(first.id)?.state).toBe('delivered')
    expect(store.parkedBy('me')).toEqual([])
    expect(pending()).not.toBeNull()
  })

  test('O16: a limited resume turn of a session holding mail leaves the mail delivered', async () => {
    const mail = await heldMail('me')
    await turn('me', 'human', { limitInMs: HOUR })
    now += HOUR
    await deliverTurn('me', pending()!, { limitInMs: HOUR })
    expect(store.get(mail.id)).toMatchObject({ state: 'delivered', parkCount: 0 })
    expect(pending()?.tags).toContain('limit-resume-attempt:2')
  })
})

describe('lost workers', () => {
  // @covers: profile-limit-handling › Limit-resumes name the workers lost to the limit › Two background agents lost
  test('workers that failed on the limit before the turn ended are named', async () => {
    outcomes.workersChanged('me', [failedWorker('ae109e7e514ff68c5', 'Budget metrics and report tools', LIMIT_SUMMARY)])
    outcomes.workersChanged('me', [
      failedWorker('ae109e7e514ff68c5', 'Budget metrics and report tools', LIMIT_SUMMARY),
      failedWorker('a1b9e4ba4fc743796', 'Budget task_get and task_text_read', LIMIT_SUMMARY),
    ])
    await turn('me', 'agent', { limitInMs: HOUR })
    const body = pending()!.body
    expect(body).toContain('- "Budget metrics and report tools" (task ae109e7e514ff68c5)')
    expect(body).toContain('- "Budget task_get and task_text_read" (task a1b9e4ba4fc743796)')
    expect(body).toContain('re-dispatch what is still needed')
  })

  // @covers: profile-limit-handling › Limit-resumes name the workers lost to the limit › Worker fails after scheduling
  test('O15a: a worker failing while a resume is pending is added at the same time and attempt', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    outcomes.workersChanged('me', [failedWorker('a1b9e4ba4fc743796', 'Budget task_get and task_text_read', LIMIT_SUMMARY)])
    expect(store.get(first.id)?.state).toBe('cancelled')
    expect(pending()).toMatchObject({ deliverAt: first.deliverAt, tags: first.tags })
    expect(pending()!.body).toContain('(task a1b9e4ba4fc743796)')
    expect(limitResumes().filter(row => row.state === 'queued')).toHaveLength(1)
  })

  test('O15c: a repeated roster push changes nothing', async () => {
    const worker = failedWorker('a1b9e4ba4fc743796', 'Budget task_get and task_text_read', LIMIT_SUMMARY)
    await turn('me', 'human', { limitInMs: HOUR })
    outcomes.workersChanged('me', [worker])
    const named = pending()!
    outcomes.workersChanged('me', [worker])
    expect(pending()?.id).toBe(named.id)
  })

  test('O15c: after a restart, a worker the pending body already names changes nothing', async () => {
    const worker = failedWorker('a1b9e4ba4fc743796', 'Budget task_get and task_text_read', LIMIT_SUMMARY)
    await turn('me', 'human', { limitInMs: HOUR })
    outcomes.workersChanged('me', [worker])
    const named = pending()!
    // A fresh process: nothing in memory, the pending resume in the database.
    const restarted = new LimitOutcomes(db, {
      store, limits, rules: { rule: () => undefined }, getRecord: id => records.get(id), teamOf: () => 'team',
      groupOf: () => undefined, taskTitle: () => null, onError: error => { throw error }, now: () => now,
    })
    restarted.workersChanged('me', [worker])
    expect(pending()?.id).toBe(named.id)
    expect(limitResumes().filter(row => row.state === 'queued')).toHaveLength(1)
  })

  test('O15b: a resume the dispatcher already claimed is left as it is', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    store.claim(first.id, 'me')
    outcomes.workersChanged('me', [failedWorker('a1b9e4ba4fc743796', 'Budget task_get and task_text_read', LIMIT_SUMMARY)])
    expect(store.get(first.id)?.state).toBe('claimed')
    expect(limitResumes()).toHaveLength(1)
  })

  test('O15b: a resume claimed between the read and the cancel is left as it is, with nothing enqueued', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    // The dispatcher claims the resume just before Kawai cancels it.
    const cancel = store.cancel.bind(store)
    const raced = spyOn(store, 'cancel').mockImplementation((id, actor, reason) => {
      if (id === first.id) store.claim(first.id, 'me')
      return cancel(id, actor, reason)
    })
    try {
      outcomes.workersChanged('me', [failedWorker('a1b9e4ba4fc743796', 'Budget task_get and task_text_read', LIMIT_SUMMARY)])
    } finally { raced.mockRestore() }
    expect(store.get(first.id)?.state).toBe('claimed')
    expect(limitResumes()).toEqual([{ id: first.id, state: 'claimed' }])
  })

  // @covers: profile-limit-handling › Limit-resumes name the workers lost to the limit › Worker failing for another reason
  test('O15d: a worker failing for another reason is not named', async () => {
    await turn('me', 'human', { limitInMs: HOUR })
    const first = pending()!
    outcomes.workersChanged('me', [failedWorker('x1', 'Broken tool', 'Agent terminated early due to an API error: bad (error type invalid_request_error, HTTP 400)')])
    expect(pending()?.id).toBe(first.id)
    expect(pending()!.body).not.toContain('Broken tool')
  })

  test('a successful human turn forgets workers that were already reported', async () => {
    outcomes.workersChanged('me', [failedWorker('old', 'Old agent', LIMIT_SUMMARY)])
    await turn('me', 'human')
    await turn('me', 'human', { limitInMs: HOUR })
    expect(pending()!.body).not.toContain('Old agent')
  })
})
