// Limit-resumes for human-created sessions (limit-resume-unheld-sessions).
// When a turn of a session the human created ends after a final limit and no
// held work is parked by it, Kawai schedules one direct `limit-resume`
// message to the session at the reset, so the session continues unattended.
// This module holds the pure parts: the turn-end decision (design D2, the
// O-table in design.md is its test table), the limit-failure test for agent
// workers (D5), and the message's tags and body. LimitOutcomes applies the
// decision to the mailbox.
import { LIMIT_ERROR_CLASSES } from '../../chat/limitSignals'

/** The tag every limit-resume message carries. */
export const LIMIT_RESUME_TAG = 'limit-resume'
const ATTEMPT_PREFIX = 'limit-resume-attempt:'
/** Consecutive limit-resumes before Kawai leaves the session to the human. */
export const MAX_LIMIT_RESUMES = 3

/** What the ending turn was. A turn that handled other delivered mail never reaches the decision. */
export type LimitResumeTurn =
  | { kind: 'human' }
  | { kind: 'agent' }
  | { kind: 'limit-resume'; attempt: number }

/** The turn's final limit: none, a credit limit (no reset), or a final event with its reset. */
export type LimitResumeEvent = { kind: 'none' } | { kind: 'credit' } | { kind: 'final'; resetsAt: number }

export interface LimitResumeInput {
  spawned: boolean
  teamResolved: boolean
  /** The session holds a delivered or parked message that is not a limit-resume. */
  held: boolean
  event: LimitResumeEvent
  now: number
  turn: LimitResumeTurn
  success: boolean
  /** The session's pending limit-resume. */
  pending: { at: number; attempt: number } | null
  capped: boolean
}

export type CappedChange = 'set' | 'clear' | 'keep'

export type LimitResumeDecision =
  | { kind: 'none'; capped: CappedChange; warn?: 'team-unresolved' }
  | { kind: 'schedule'; at: number; attempt: number; capped: CappedChange }
  | { kind: 'supersede'; at: number; capped: CappedChange }
  | { kind: 'cancel'; capped: CappedChange }

const none = (capped: CappedChange = 'keep'): LimitResumeDecision => ({ kind: 'none', capped })

/** The turn-end decision (design D2); every row of the design's table maps here. */
export function limitResumeDecision(input: LimitResumeInput): LimitResumeDecision {
  if (input.spawned) return none() // O1
  const { event, turn } = input
  if (event.kind === 'none') {
    if (!input.success) return none() // O15
    if (turn.kind === 'human') return input.pending ? { kind: 'cancel', capped: 'clear' } : none('clear') // O12
    if (turn.kind === 'limit-resume') return none('clear') // O13
    return none() // O14
  }
  if (event.kind === 'credit') return none() // O10
  if (event.resetsAt <= input.now) return none() // O11
  if (!input.teamResolved) return { kind: 'none', capped: 'keep', warn: 'team-unresolved' } // O17
  if (turn.kind === 'agent' && input.held) return none() // O2: parkCurrent parks the held work
  if (input.pending) {
    return input.pending.at < event.resetsAt ? { kind: 'supersede', at: event.resetsAt, capped: 'keep' } : none() // O6, O7
  }
  if (turn.kind === 'human') return { kind: 'schedule', at: event.resetsAt, attempt: 1, capped: 'clear' } // O3, O2a
  if (turn.kind === 'agent') return input.capped ? none() : { kind: 'schedule', at: event.resetsAt, attempt: 1, capped: 'keep' } // O4, O5
  if (turn.attempt < MAX_LIMIT_RESUMES) return { kind: 'schedule', at: event.resetsAt, attempt: turn.attempt + 1, capped: 'keep' } // O8, O16
  return none('set') // O9
}

const LIMIT_CLASS = new RegExp(`error type (${[...LIMIT_ERROR_CLASSES].join('|')})\\b`)

/** Whether a failed worker's summary reports a limit error (D5). */
export function isLimitFailure(summary: string | undefined): boolean {
  if (!summary) return false
  return LIMIT_CLASS.test(summary) || /\bHTTP 429\b/.test(summary)
}

export function limitResumeTags(attempt: number): string[] {
  return [LIMIT_RESUME_TAG, `${ATTEMPT_PREFIX}${attempt}`]
}

export function isLimitResume(tags: readonly string[]): boolean {
  return tags.includes(LIMIT_RESUME_TAG)
}

/** The attempt a limit-resume's tags carry; 1 when absent or malformed. */
export function limitResumeAttempt(tags: readonly string[]): number {
  const tag = tags.find(value => value.startsWith(ATTEMPT_PREFIX))
  const attempt = tag ? Number(tag.slice(ATTEMPT_PREFIX.length)) : NaN
  return Number.isInteger(attempt) && attempt >= 1 ? attempt : 1
}

/** A lost worker as the resume names it. */
export interface LostWorker {
  /** The SDK task id, else the spawning tool call's id. */
  key: string
  description: string
}

export function lostWorkerLine(worker: LostWorker): string {
  return `- "${worker.description}" (task ${worker.key})`
}

const WORKER_LINE = /^- ".*" \(task [^)]+\)$/

/** The worker lines of an earlier limit-resume body, kept when it is replaced. */
export function workerLinesOf(body: string): string[] {
  return body.split('\n').filter(line => WORKER_LINE.test(line))
}

/** The limit-resume body; worker lines are already deduplicated by the caller. */
export function limitResumeBody(profileId: string, workerLines: readonly string[]): string {
  const head = `Your provider limit (${profileId}) has reset. Your last turn stopped on the limit; ` +
    'continue where you left off, checking `git status` first.'
  if (workerLines.length === 0) return head
  return `${head} These background agents failed on the limit and their work was lost; ` +
    `re-dispatch what is still needed:\n${workerLines.join('\n')}`
}

/** Old lines first, then each new line whose task key the body does not already name. */
export function mergeWorkerLines(existing: readonly string[], lost: readonly LostWorker[]): string[] {
  const lines = [...existing]
  for (const worker of lost) {
    if (!lines.some(line => line.endsWith(`(task ${worker.key})`))) lines.push(lostWorkerLine(worker))
  }
  return lines
}
