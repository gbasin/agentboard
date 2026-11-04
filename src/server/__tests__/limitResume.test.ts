// The limit-resume turn-end decision (limit-resume-unheld-sessions D2): the
// design's decision table O1–O17, committed verbatim as data, run against
// `limitResumeDecision`, plus the completeness claim — every combination of
// the axes matches exactly one row or an unreachable claim — and the
// limit-failure test for agent workers (D5).
import { describe, expect, test } from 'bun:test'
import {
  isLimitFailure, limitResumeAttempt, limitResumeBody, limitResumeDecision, limitResumeTags, mergeWorkerLines, workerLinesOf,
  type LimitResumeDecision, type LimitResumeInput, type LimitResumeTurn,
} from '../team/routing/limitResume'

const NOW = Date.parse('2026-11-03T20:20:43.000Z')
const RESET = Date.parse('2026-11-03T21:50:00.000Z')
const EARLIER = RESET - 60 * 60_000
const LATER = RESET + 60 * 60_000

type Kind = 'human' | 'agent' | 'lr1' | 'lr2' | 'lr3'
type EventAxis = 'none' | 'credit' | 'ahead' | 'passed'
type PendingAxis = 'none' | 'earlier' | 'later'
interface Combo {
  spawned: boolean; held: boolean; event: EventAxis; kind: Kind; pending: PendingAxis; capped: boolean; success: boolean; team: boolean
}

const W = '*' as const
type Cell<T> = T | readonly T[] | typeof W
interface Row {
  id: string
  spawned: Cell<'S' | 'H'>
  held: Cell<boolean>
  event: Cell<EventAxis>
  kind: Cell<Kind>
  pending: Cell<PendingAxis>
  capped: Cell<boolean>
  success: Cell<boolean>
  team: Cell<boolean>
  /** An extra condition the table states in words ("yes with kind human"). */
  also?: (combo: Combo) => boolean
  expected: (combo: Combo) => LimitResumeDecision
}

const LR: Kind[] = ['lr1', 'lr2', 'lr3']
const attemptOf = (kind: Kind) => Number(kind.slice(2))
const none = (capped: 'set' | 'clear' | 'keep' = 'keep'): LimitResumeDecision => ({ kind: 'none', capped })

// The design's table, row for row (design.md "Turn-end decision table").
const TABLE: Row[] = [
  { id: 'O1', spawned: 'S', held: W, event: W, kind: W, pending: W, capped: W, success: W, team: W, expected: () => none() },
  { id: 'O2', spawned: 'H', held: true, event: 'ahead', kind: 'agent', pending: W, capped: W, success: W, team: true, expected: () => none() },
  { id: 'O2a', spawned: 'H', held: true, event: 'ahead', kind: 'human', pending: 'none', capped: W, success: W, team: true,
    expected: () => ({ kind: 'schedule', at: RESET, attempt: 1, capped: 'clear' }) },
  { id: 'O3', spawned: 'H', held: false, event: 'ahead', kind: 'human', pending: 'none', capped: W, success: W, team: true,
    expected: () => ({ kind: 'schedule', at: RESET, attempt: 1, capped: 'clear' }) },
  { id: 'O4', spawned: 'H', held: false, event: 'ahead', kind: 'agent', pending: 'none', capped: false, success: W, team: true,
    expected: () => ({ kind: 'schedule', at: RESET, attempt: 1, capped: 'keep' }) },
  { id: 'O5', spawned: 'H', held: false, event: 'ahead', kind: 'agent', pending: 'none', capped: true, success: W, team: true, expected: () => none() },
  { id: 'O6', spawned: 'H', held: W, event: 'ahead', kind: ['human', 'agent'], pending: 'earlier', capped: W, success: W, team: true,
    also: c => !c.held || c.kind === 'human', expected: () => ({ kind: 'supersede', at: RESET, capped: 'keep' }) },
  { id: 'O7', spawned: 'H', held: W, event: 'ahead', kind: ['human', 'agent'], pending: 'later', capped: W, success: W, team: true,
    also: c => !c.held || c.kind === 'human', expected: () => none() },
  { id: 'O8', spawned: 'H', held: W, event: 'ahead', kind: ['lr1', 'lr2'], pending: 'none', capped: W, success: W, team: true,
    expected: c => ({ kind: 'schedule', at: RESET, attempt: attemptOf(c.kind) + 1, capped: 'keep' }) },
  { id: 'O9', spawned: 'H', held: W, event: 'ahead', kind: 'lr3', pending: 'none', capped: W, success: W, team: true, expected: () => none('set') },
  { id: 'O10', spawned: 'H', held: W, event: 'credit', kind: W, pending: W, capped: W, success: W, team: W, expected: () => none() },
  { id: 'O11', spawned: 'H', held: W, event: 'passed', kind: W, pending: W, capped: W, success: W, team: W, expected: () => none() },
  { id: 'O12', spawned: 'H', held: W, event: 'none', kind: 'human', pending: W, capped: W, success: true, team: W,
    expected: c => (c.pending === 'none' ? none('clear') : { kind: 'cancel', capped: 'clear' }) },
  { id: 'O13', spawned: 'H', held: W, event: 'none', kind: LR, pending: 'none', capped: W, success: true, team: W, expected: () => none('clear') },
  { id: 'O14', spawned: 'H', held: W, event: 'none', kind: 'agent', pending: W, capped: W, success: true, team: W, expected: () => none() },
  { id: 'O15', spawned: 'H', held: W, event: 'none', kind: W, pending: W, capped: W, success: false, team: W, expected: () => none() },
  { id: 'O17', spawned: 'H', held: W, event: 'ahead', kind: W, pending: W, capped: W, success: W, team: false,
    expected: () => ({ kind: 'none', capped: 'keep', warn: 'team-unresolved' }) },
]

/** The design's unreachable claims (the `mail` kind never reaches the decision). */
function unreachable(combo: Combo): boolean {
  const lr = combo.kind.startsWith('lr')
  return (lr && combo.pending !== 'none') || (combo.spawned && lr)
}

const cellMatches = <T>(cell: Cell<T>, value: T) =>
  cell === W || (Array.isArray(cell) ? (cell as readonly T[]).includes(value) : cell === value)

function rowMatches(row: Row, combo: Combo): boolean {
  return cellMatches(row.spawned, combo.spawned ? 'S' : 'H') && cellMatches(row.held, combo.held) &&
    cellMatches(row.event, combo.event) && cellMatches(row.kind, combo.kind) && cellMatches(row.pending, combo.pending) &&
    cellMatches(row.capped, combo.capped) && cellMatches(row.success, combo.success) && cellMatches(row.team, combo.team) &&
    (row.also?.(combo) ?? true)
}

function inputOf(combo: Combo): LimitResumeInput {
  const turn: LimitResumeTurn = combo.kind.startsWith('lr')
    ? { kind: 'limit-resume', attempt: attemptOf(combo.kind) }
    : { kind: combo.kind as 'human' | 'agent' }
  return {
    spawned: combo.spawned, teamResolved: combo.team, held: combo.held, now: NOW, turn, success: combo.success, capped: combo.capped,
    event: combo.event === 'none' ? { kind: 'none' } : combo.event === 'credit' ? { kind: 'credit' }
      : { kind: 'final', resetsAt: combo.event === 'ahead' ? RESET : NOW },
    pending: combo.pending === 'none' ? null : { at: combo.pending === 'earlier' ? EARLIER : LATER, attempt: 1 },
  }
}

function* combos(): Generator<Combo> {
  const bools = [false, true]
  for (const spawned of bools) for (const held of bools) for (const event of ['none', 'credit', 'ahead', 'passed'] as const)
    for (const kind of ['human', 'agent', 'lr1', 'lr2', 'lr3'] as const) for (const pending of ['none', 'earlier', 'later'] as const)
      for (const capped of bools) for (const success of bools) for (const team of bools)
        yield { spawned, held, event, kind, pending, capped, success, team }
}

describe('limit-resume decision table (design D2)', () => {
  test('completeness: every reachable combination matches exactly one row', () => {
    const counts = new Map<string, number>()
    for (const combo of combos()) {
      if (unreachable(combo)) continue
      const matched = TABLE.filter(row => rowMatches(row, combo)).map(row => row.id)
      expect({ combo, matched: matched.length }).toEqual({ combo, matched: 1 })
      counts.set(matched[0]!, (counts.get(matched[0]!) ?? 0) + 1)
    }
    // Every row is reachable: no dead row hides behind another.
    expect([...counts.keys()].sort()).toEqual(TABLE.map(row => row.id).sort())
  })

  for (const row of TABLE) {
    test(`${row.id}: the decision matches the table`, () => {
      let cases = 0
      for (const combo of combos()) {
        if (unreachable(combo) || !rowMatches(row, combo)) continue
        expect({ combo, decision: limitResumeDecision(inputOf(combo)) }).toEqual({ combo, decision: row.expected(combo) })
        cases++
      }
      expect(cases).toBeGreaterThan(0)
    })
  }
})

// The captured incident summary (chat-4178b0cc, 2026-11-03T20:20:42Z).
const INCIDENT = "Agent terminated early due to an API error: You've hit your 5-hour limit · resets 1:50am (Asia/Yerevan) " +
  '(error type rate_limit, HTTP 429, request id req_011CggcfJfFwPm77jAjMXqYj, model sent to the API: claude-opus-5-5)'

describe('worker limit failures (design D5)', () => {
  test('the incident summary is a limit failure', () => {
    expect(isLimitFailure(INCIDENT)).toBe(true)
  })

  test('billing and overloaded classes and a bare HTTP 429 are limit failures', () => {
    expect(isLimitFailure('Agent terminated early due to an API error: x (error type billing_error, HTTP 400)')).toBe(true)
    expect(isLimitFailure('Agent terminated early due to an API error: x (error type overloaded, HTTP 529)')).toBe(true)
    expect(isLimitFailure('Gateway said HTTP 429 Too Many Requests')).toBe(true)
  })

  test('other failures are not limit failures', () => {
    expect(isLimitFailure(undefined)).toBe(false)
    expect(isLimitFailure('Agent terminated early due to an API error: bad input (error type invalid_request_error, HTTP 400)')).toBe(false)
    expect(isLimitFailure('Agent terminated early due to an API error: x (error type authentication_error, HTTP 401)')).toBe(false)
    expect(isLimitFailure('Tool failed: HTTP 4290 bytes written')).toBe(false)
    expect(isLimitFailure('Agent failed: (error type rate_limited_custom, HTTP 400)')).toBe(false)
  })
})

describe('limit-resume tags and body', () => {
  test('the attempt rides in the tags and defaults to 1', () => {
    expect(limitResumeTags(2)).toEqual(['limit-resume', 'limit-resume-attempt:2'])
    expect(limitResumeAttempt(limitResumeTags(3))).toBe(3)
    expect(limitResumeAttempt(['limit-resume'])).toBe(1)
    expect(limitResumeAttempt(['limit-resume', 'limit-resume-attempt:x'])).toBe(1)
  })

  test('worker lines survive a replacement and dedupe by task key', () => {
    const first = limitResumeBody('default', mergeWorkerLines([], [{ key: 'ae109e7e514ff68c5', description: 'Budget metrics and report tools' }]))
    expect(first).toContain('- "Budget metrics and report tools" (task ae109e7e514ff68c5)')
    const lines = mergeWorkerLines(workerLinesOf(first), [
      { key: 'ae109e7e514ff68c5', description: 'Budget metrics and report tools' },
      { key: 'a1b9e4ba4fc743796', description: 'Budget task_get and task_text_read' },
    ])
    expect(lines).toEqual([
      '- "Budget metrics and report tools" (task ae109e7e514ff68c5)',
      '- "Budget task_get and task_text_read" (task a1b9e4ba4fc743796)',
    ])
  })

  test('a body without lost workers names only the reset and the instruction', () => {
    const body = limitResumeBody('opus', [])
    expect(body).toStartWith('Your provider limit (opus) has reset.')
    expect(body).not.toContain('re-dispatch')
  })
})
