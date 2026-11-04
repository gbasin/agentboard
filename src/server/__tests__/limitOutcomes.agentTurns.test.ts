// Limits in agent-started turns (limit-outcomes-agent-turns): a final limit
// in a turn the agent started itself parks the session's current work on it,
// never releases or forwards it. The setup mirrors limitOutcomes.test.ts.
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ChatSessionRecord } from '../db'
import { logger } from '../logger'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()

let now: number
let db: Database
let store: MailboxStore
let limits: LimitEventStore
let outcomes: LimitOutcomes
let records: Map<string, ChatSessionRecord>
let groups: Map<string, GroupDefinition>

function outcomesFor(): LimitOutcomes {
  return new LimitOutcomes(db, {
    store, limits, rules: { rule: () => undefined },
    getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? 'team' : undefined),
    groupOf: (_sessionId, groupId) => groups.get(groupId),
    taskTitle: () => null,
    onError: error => { throw error },
    now: () => now,
  })
}

beforeEach(() => {
  now = T0
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  limits = new LimitEventStore(db, () => now)
  records = new Map([['dev', {
    sessionId: 'dev', name: 'dev', projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
    // A staffing dev: human-created sessions get a limit-resume instead
    // (limit-resume-unheld-sessions), covered in limitOutcomes.limitResume.test.ts.
    groupId: 'devs', claudeProfileId: 'glm', spawned: true,
  }]])
  const parsed = parseGroupFile('devs', '---\nonLimit: { parkIfResetWithin: 3h, otherwise: forward }\n---\nWork.')
  if (!parsed.ok) throw new Error(parsed.error)
  groups = new Map([['devs', parsed.group]])
  outcomes = outcomesFor()
})
afterEach(() => db.close())

/** Group mail delivered as a turn of its own that ends successfully. */
async function deliveredAndDone(body = 'Build the export'): Promise<TeamMessage> {
  const message = store.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo', body })
  store.claim(message.id, 'dev'); store.markPushed(message.id); store.markDelivered(message.id)
  outcomes.turnStarted('dev', false)
  outcomes.delivered('dev', store.get(message.id)!)
  await outcomes.turnEnded('dev', true)
  now += MIN
  return store.get(message.id)!
}

/** A turn of the given kind ends after a final limit (reported as success, as the CLI has). */
async function limitedTurn(agentStarted: boolean, resetInMs: number) {
  outcomes.turnStarted('dev', agentStarted)
  limits.record({ profileId: 'glm', sessionId: 'dev', groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
    message: 'quota', resetsAt: iso(now + resetInMs), providerId: null, window: null })
  await outcomes.turnEnded('dev', true)
}

const resumeOf = (id: string) => store.get(store.get(id)!.resumeMessageId!)!
const mailCount = () => (db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n

describe('final limits in agent-started turns', () => {
  test('park the delivered work on the agent with its resume at the reset, without progress', async () => {
    const work = await deliveredAndDone()
    await limitedTurn(true, 2 * HOUR)
    expect(store.get(work.id)).toMatchObject({ state: 'parked', claimedBy: 'dev', parkedUntil: iso(now + 2 * HOUR), parkCount: 1 })
    expect(resumeOf(work.id)).toMatchObject({ state: 'queued', toKind: 'session', toId: 'dev', deliverAt: iso(now + 2 * HOUR), tags: ['resume'] })
  })

  test('a far reset still parks: never forwarded or released', async () => {
    const work = await deliveredAndDone()
    await limitedTurn(true, 5 * HOUR)
    expect(store.get(work.id)).toMatchObject({ state: 'parked', parkedUntil: iso(now + 5 * HOUR) })
    expect(mailCount()).toBe(2) // the work and its resume; no forward
  })

  test('the newest held work is parked, never a delivered resume', async () => {
    const older = await deliveredAndDone('older')
    const newer = await deliveredAndDone('newer')
    await limitedTurn(true, HOUR)
    expect(store.get(newer.id)?.state).toBe('parked')
    expect(store.get(older.id)?.state).toBe('delivered')
  })

  test('with no current work nothing is resolved', async () => {
    await limitedTurn(true, HOUR)
    expect(mailCount()).toBe(0)
  })

  test('a human turn after delivered work resolves nothing, as before', async () => {
    const work = await deliveredAndDone()
    await limitedTurn(false, HOUR)
    expect(store.get(work.id)).toMatchObject({ state: 'delivered', parkCount: 0 })
    expect(mailCount()).toBe(1)
  })

  test('already-parked work keeps its count; only a later reset moves the resume', async () => {
    const work = await deliveredAndDone()
    await limitedTurn(true, HOUR)
    const first = resumeOf(work.id)
    await limitedTurn(true, 30 * MIN) // earlier than the scheduled resume
    expect(store.get(work.id)).toMatchObject({ state: 'parked', parkCount: 1, resumeMessageId: first.id })
    await limitedTurn(true, 2 * HOUR)
    expect(store.get(work.id)).toMatchObject({ state: 'parked', parkCount: 1, parkedUntil: iso(now + 2 * HOUR) })
    expect(store.get(first.id)?.state).toBe('cancelled')
    expect(resumeOf(work.id)).toMatchObject({ state: 'queued', deliverAt: iso(now + 2 * HOUR) })
  })

  test('work at MAX_PARKS is neither parked nor released, and a warning names it', async () => {
    const work = await deliveredAndDone()
    for (let i = 0; i < 3; i++) {
      const resume = store.enqueue({ teamId: 'team', toKind: 'session', toId: 'dev', fromSession: 'dev', fromGroup: 'devs', originPath: '/repo', body: 'r', deliverAt: iso(now + HOUR) })
      store.park(work.id, iso(now + HOUR), resume.id)
      store.replaceResume(work.id)
      store.unpark(work.id)
    }
    const warn = spyOn(logger, 'warn')
    try {
      await limitedTurn(true, HOUR)
      expect(store.get(work.id)).toMatchObject({ state: 'delivered', claimedBy: 'dev', parkCount: 3 })
      expect(warn).toHaveBeenCalledWith('limit_agent_turn_park_cap', { sessionId: 'dev', messageId: work.id, parkCount: 3 })
    } finally { warn.mockRestore() }
  })

  test('a successful resume turn unparks', async () => {
    const work = await deliveredAndDone()
    await limitedTurn(true, HOUR)
    const resume = resumeOf(work.id)
    store.claim(resume.id, 'dev'); store.markPushed(resume.id); store.markDelivered(resume.id)
    outcomes.turnStarted('dev', false)
    outcomes.delivered('dev', store.get(resume.id)!)
    await outcomes.turnEnded('dev', true)
    expect(store.get(work.id)).toMatchObject({ state: 'delivered', resumeMessageId: null })
  })

  test('a successful agent-started turn keeps the park and its resume', async () => {
    const work = await deliveredAndDone()
    await limitedTurn(true, HOUR)
    const resume = resumeOf(work.id)
    outcomes.turnStarted('dev', true)
    await outcomes.turnEnded('dev', true)
    expect(store.get(work.id)).toMatchObject({ state: 'parked', resumeMessageId: resume.id })
    expect(store.get(resume.id)?.state).toBe('queued')
    // A successful human turn still unparks, as before.
    outcomes.turnStarted('dev', false)
    await outcomes.turnEnded('dev', true)
    expect(store.get(work.id)?.state).toBe('delivered')
  })

  test('work of an interrupted turn is never released or forwarded by a later agent-started limit', async () => {
    const message = store.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo', body: 'Build it' })
    store.claim(message.id, 'dev'); store.markPushed(message.id); store.markDelivered(message.id)
    outcomes.turnStarted('dev', false)
    outcomes.delivered('dev', store.get(message.id)!)
    outcomes.toolCall('dev', 'Edit', { file_path: '/repo/a.ts' })
    // Interrupted: no turnEnded. A self-started turn then hits a far reset.
    await limitedTurn(true, 5 * HOUR)
    expect(store.get(message.id)).toMatchObject({ state: 'parked', claimedBy: 'dev', parkedUntil: iso(now + 5 * HOUR) })
    expect(mailCount()).toBe(2) // the work and its resume; no forward
  })

  test('an interrupted resume turn does not let a successful agent-started turn unpark', async () => {
    const work = await deliveredAndDone()
    await limitedTurn(true, HOUR)
    const resume = resumeOf(work.id)
    store.claim(resume.id, 'dev'); store.markPushed(resume.id); store.markDelivered(resume.id)
    outcomes.turnStarted('dev', false)
    outcomes.delivered('dev', store.get(resume.id)!)
    // Interrupted: no turnEnded. A successful self-started turn follows.
    outcomes.turnStarted('dev', true)
    await outcomes.turnEnded('dev', true)
    expect(store.get(work.id)).toMatchObject({ state: 'parked', resumeMessageId: resume.id })
  })

  test('after a restart the current work is derived from the store', async () => {
    const work = await deliveredAndDone()
    outcomes = outcomesFor()
    await limitedTurn(true, HOUR)
    expect(store.get(work.id)?.state).toBe('parked')
  })

  test('remembered work that was released falls back to other held work', async () => {
    const older = await deliveredAndDone('older')
    const newer = await deliveredAndDone('newer')
    store.release(newer.id, 'devs')
    await limitedTurn(true, HOUR)
    expect(store.get(older.id)?.state).toBe('parked')
  })
})
