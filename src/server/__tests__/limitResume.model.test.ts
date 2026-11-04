// Seeded model test of limit-resumes (limit-resume-unheld-sessions P1–P4):
// random command sequences over one human-created session (human and
// agent-started turns, limited or not, credit limits, dispatcher deliveries
// of the pending resume, interrupted turns, workers failing, archives,
// restarts, and a crash injected at either boundary of the D4 replacement)
// through LimitOutcomes and a real MailboxStore, checking the invariants
// after every command.
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { describe, expect, spyOn, test } from 'bun:test'
import type { ChatSessionRecord } from '../db'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'

const SEED = 0x11a7
const CASES = 500
const STEPS = 30
const MIN = 60_000
const LIMIT_SUMMARY = 'Agent terminated early due to an API error: limit (error type rate_limit, HTTP 429)'

/** mulberry32: a small deterministic generator, no dependency. */
function rng(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]! }
}

type Command = 'human' | 'human-limited' | 'agent' | 'agent-limited' | 'credit' | 'deliver' | 'deliver-limited' |
  'interrupted' | 'worker' | 'archive' | 'restart' | 'crash-replace'
const COMMANDS: Command[] = ['human', 'human-limited', 'agent', 'agent-limited', 'credit', 'deliver', 'deliver-limited',
  'interrupted', 'worker', 'archive', 'restart', 'crash-replace']

class World {
  now = Date.parse('2026-11-03T20:00:00.000Z')
  readonly db: Database = schemaDb(':memory:')
  readonly store = new MailboxStore(this.db)
  readonly limits = new LimitEventStore(this.db, () => this.now)
  readonly record: ChatSessionRecord = {
    sessionId: 'me', name: 'me', projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '', claudeProfileId: 'default',
  }
  outcomes = this.build()
  workers = 0
  /** Limit-resumes delivered since the last human turn or successful limit-resume turn (P3). */
  run = 0
  /** Worker keys that failed on a limit while a resume was queued: it must name them (P4). */
  mustName = new Set<string>()
  /** The reset of this step's final limit, if any, checked against the queued resume's time (D4: the later reset). */
  lastReset: number | null = null

  build(): LimitOutcomes {
    return new LimitOutcomes(this.db, {
      store: this.store, limits: this.limits, rules: { rule: () => undefined }, getRecord: id => (id === 'me' ? this.record : undefined),
      teamOf: id => (id === 'me' ? 'team' : undefined), groupOf: () => undefined, taskTitle: () => null,
      onError: error => { throw error }, now: () => this.now,
    })
  }

  limit(resetInMs: number, credit = false) {
    this.lastReset = credit ? null : this.now + resetInMs
    this.limits.record({ profileId: 'default', sessionId: 'me', groupId: null, kind: 'rate_limit', final: true, status: credit ? 402 : 429,
      message: 'limit', resetsAt: credit ? null : new Date(this.now + resetInMs).toISOString(), providerId: null, window: credit ? 'credit' : 'five_hour' })
  }

  async turn(agent: boolean, limited: boolean, r: ReturnType<typeof rng>, credit = false) {
    this.outcomes.turnStarted('me', agent)
    if (credit) this.limit(0, true)
    else if (limited) this.limit((1 + r.int(240)) * MIN)
    await this.outcomes.turnEnded('me', true)
    if (!agent) this.run = 0
  }

  async deliver(limited: boolean, r: ReturnType<typeof rng>) {
    const pending = this.store.pendingLimitResume('me')
    if (!pending) return
    this.now = Math.max(this.now, Date.parse(pending.deliverAt!))
    this.store.claim(pending.id, 'me'); this.store.markPushed(pending.id); this.store.markDelivered(pending.id)
    this.run++
    this.outcomes.turnStarted('me', false)
    this.outcomes.delivered('me', this.store.get(pending.id)!)
    if (limited) this.limit((1 + r.int(240)) * MIN)
    await this.outcomes.turnEnded('me', true)
    if (!limited) this.run = 0
  }

  workerFails(crashing = false) {
    const key = `task-${++this.workers}`
    if (!crashing && this.queued().length === 1) this.mustName.add(key)
    this.outcomes.workersChanged('me', [{ workerId: `toolu-${key}`, taskId: key, description: key, status: 'failed', live: false, elapsedMs: 1, summary: LIMIT_SUMMARY }])
  }

  limitResumes(): TeamMessage[] {
    return (this.db.prepare(`SELECT id FROM team_messages WHERE tags LIKE '%"limit-resume"%'`).all() as Array<{ id: string }>)
      .map(row => this.store.get(row.id)!)
  }

  queued(): TeamMessage[] {
    return this.limitResumes().filter(message => message.state === 'queued')
  }
}

async function step(world: World, command: Command, r: ReturnType<typeof rng>) {
  world.now += r.int(30) * MIN
  world.lastReset = null
  switch (command) {
    case 'human': return world.turn(false, false, r)
    case 'human-limited': return world.turn(false, true, r)
    case 'agent': return world.turn(true, false, r)
    case 'agent-limited': return world.turn(true, true, r)
    case 'credit': return world.turn(r.next() < 0.5, false, r, true)
    case 'deliver': return world.deliver(false, r)
    case 'deliver-limited': return world.deliver(true, r)
    case 'interrupted': {
      // A limited turn interrupted before its end: the next turn must not inherit the limit (D8).
      world.outcomes.turnStarted('me', r.next() < 0.5)
      world.limit((1 + r.int(240)) * MIN)
      world.lastReset = null
      return
    }
    case 'worker': return world.workerFails()
    case 'archive': world.outcomes.cancelLimitResume('me'); return
    case 'restart': world.outcomes = world.build(); world.run = 0; return
    case 'crash-replace': {
      // P4: a crash inside the D4 replacement, at either boundary: on the
      // cancel, or after it on the enqueue.
      const before = world.queued().map(message => ({ id: message.id, body: message.body, deliverAt: message.deliverAt }))
      const target = r.next() < 0.5 ? 'cancel' : 'enqueue'
      const crash = target === 'cancel'
        ? spyOn(world.store, 'cancel').mockImplementation(() => { throw new Error('crash') })
        : spyOn(world.store, 'enqueue').mockImplementation(() => { throw new Error('crash') })
      try { world.workerFails(true) } catch { /* the process died here */ } finally { crash.mockRestore() }
      // Both or neither: whatever was pending is still pending, unchanged.
      expect({ trace: target, queued: world.queued().map(message => ({ id: message.id, body: message.body, deliverAt: message.deliverAt })) })
        .toEqual({ trace: target, queued: before })
      world.outcomes = world.build()
      world.run = 0
      return
    }
  }
}

function checkInvariants(world: World, trace: string[]) {
  const queued = world.queued()
  // P1: at most one pending limit-resume.
  expect({ trace, queued: queued.length }).toEqual({ trace, queued: queued.length === 0 ? 0 : 1 })
  // P2: never parked or forwarded, and always direct to the session itself.
  const rerouted = world.limitResumes()
    .filter(message => message.state === 'parked' || message.state === 'forwarded' || message.toKind !== 'session' || message.toId !== 'me')
    .map(message => `${message.id}:${message.state}:${message.toKind}`)
  expect({ trace, rerouted }).toEqual({ trace, rerouted: [] })
  // P3: at most 3 limit-resumes in a row without the human or a successful resume.
  expect({ trace, run: world.run <= 3 }).toEqual({ trace, run: true })
  // P4: the queued resume names every worker lost while it waited.
  if (queued.length === 0) world.mustName.clear()
  const missing = [...world.mustName].filter(key => !queued[0]?.body.includes(`(task ${key})`))
  if (missing.length) throw new Error(`P4 missing ${missing.join(',')} after ${trace.join(' ')}; body: ${queued[0]?.body}`)
  // D4: a newer limit never moves the queued resume earlier than its reset.
  if (queued.length === 1 && world.lastReset !== null) {
    expect({ trace, early: Date.parse(queued[0]!.deliverAt!) < world.lastReset }).toEqual({ trace, early: false })
  }
}

describe('limit-resume model (design P1–P4)', () => {
  test(`seeded command sequences keep P1–P4 (seed ${SEED.toString(16)}, ${CASES} cases)`, async () => {
    const r = rng(SEED)
    let crashes = 0
    let maxRun = 0
    for (let c = 0; c < CASES; c++) {
      const world = new World()
      const trace: string[] = [`case ${c}`]
      try {
        for (let s = 0; s < STEPS; s++) {
          const command = r.pick(COMMANDS)
          if (command === 'crash-replace' && world.queued().length === 1) crashes++
          trace.push(command)
          const before = world.queued().map(message => message.id)
          await step(world, command, r)
          checkInvariants(world, trace)
          // A successful unlimited human turn cancels the resume (O12); an agent-started one leaves it (O14).
          if (command === 'human') expect({ trace, queued: world.queued().length }).toEqual({ trace, queued: 0 })
          if (command === 'agent') expect({ trace, queued: world.queued().map(message => message.id) }).toEqual({ trace, queued: before })
          maxRun = Math.max(maxRun, world.run)
        }
      } finally { world.db.close() }
    }
    // The generator reaches the interesting states, not just trivial ones.
    expect(crashes).toBeGreaterThan(50)
    expect(maxRun).toBe(3)
  }, 60_000)
})
