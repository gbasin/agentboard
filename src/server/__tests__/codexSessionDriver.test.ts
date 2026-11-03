// §5.2 (codex-chat-sessions): the Codex driver against the fake app-server —
// thread persistence (start, then resume of the stored thread), streaming and
// turn completion, activity, interrupt, a failed turn, and the process exit
// that marks the driver dead so the next send respawns and resumes.
import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'
import type { ChatEvent, ChatUsageReport } from '../../shared/chat'
import type { ChatLimitSignal } from '../chat/limitSignals'
import { codexEffort } from '../chat/codex/CodexSessionDriver'
import { eventTypes, ROLLOUT, Script, sentRequest, startHarness, THREAD_ID, until, type Harness } from './codexDriverHarness'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

const completedOf = (events: ChatEvent[]) => events.filter((event): event is Extract<ChatEvent, { type: 'turn_completed' }> => event.type === 'turn_completed')

test('a fresh chat starts a persisted thread and reports its id and rollout path', async () => {
  harness = startHarness(new Script().boot())
  harness.driver.start()
  await until(() => harness!.sessionIds.length === 1)
  expect(harness.sessionIds).toEqual([THREAD_ID])
  expect(harness.transcriptPaths).toEqual([ROLLOUT])
  const params = sentRequest(harness, 'thread/start')!
  expect(params.ephemeral).toBe(false)
  expect(params.approvalPolicy).toBe('on-request')
  expect(params.approvalsReviewer).toBe('user')
  expect(params.sandbox).toBe('workspace-write')
  expect(params.dynamicTools).toBeUndefined()
  // Starting sends no prompt.
  expect(sentRequest(harness, 'turn/start')).toBeUndefined()
  expect(harness.events).toEqual([])
})

test('a stored thread is resumed, never restarted, and its id is not re-reported', async () => {
  harness = startHarness(new Script().boot('thread/resume'), { resumeThreadId: THREAD_ID })
  harness.driver.start()
  await until(() => harness!.transcriptPaths.length === 1)
  const params = sentRequest(harness, 'thread/resume')!
  expect(params.threadId).toBe(THREAD_ID)
  // The history is never read; a long thread's would arrive as one huge line.
  expect(params.excludeTurns).toBe(true)
  expect(params.approvalsReviewer).toBe('user')
  expect(params.ephemeral).toBeUndefined()
  expect(sentRequest(harness, 'thread/start')).toBeUndefined()
  expect(harness.sessionIds).toEqual([])
})

test('a turn streams text, completes with its final text and token usage, and statuses follow', async () => {
  const total1 = { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: '', questions: null })
    .notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'msg-1', delta: 'hel' })
    .notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'msg-1', delta: 'lo' })
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: 'hello', questions: null })
    .notify('thread/tokenUsage/updated', { threadId: THREAD_ID, turnId: 'ct-1', tokenUsage: { total: total1, last: total1, modelContextWindow: 10_000 } })
    .completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'msg-1', text: 'hello' }])
  const activities: Array<string | null> = []
  harness = startHarness(script, { onActivity: activity => activities.push(activity?.phase ?? null) })
  harness.driver.send('hi')
  await until(() => completedOf(harness!.events).length === 1)
  expect(eventTypes(harness.events)).toEqual(['turn_started', 'user_message', 'assistant_delta', 'assistant_delta', 'assistant_text', 'turn_completed'])
  const turnStart = sentRequest(harness, 'turn/start')!
  expect(turnStart.threadId).toBe(THREAD_ID)
  expect(turnStart.input).toEqual([{ type: 'text', text: 'hi', text_elements: [] }])
  const done = completedOf(harness.events)[0]!
  expect(done.subtype).toBe('success')
  expect(done.isError).toBeUndefined()
  expect(done.finalText).toBe('hello')
  expect(done.usage).toEqual({ inputTokens: 800, outputTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 0 })
  expect(harness.statuses).toEqual(['working', 'waiting'])
  expect(activities).toEqual(['requesting', 'responding', null])
  expect(harness.usage.at(-1)).toMatchObject({ usedTokens: 1000, thresholdTokens: 10_000, percentage: 10, thresholdApproximate: true })
})

test('a failed turn ends as an error with its reason named', async () => {
  const script = new Script().boot().turn('ct-1')
    .completed('ct-1', 'failed', [], { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' })
  harness = startHarness(script)
  harness.driver.send('hi')
  await until(() => completedOf(harness!.events).length === 1)
  const done = completedOf(harness.events)[0]!
  expect(done).toMatchObject({ subtype: 'error_during_execution', isError: true, terminalReason: 'usageLimitExceeded' })
  expect(harness.events.at(-1)).toMatchObject({ type: 'error', message: 'usage limit reached (usageLimitExceeded)' })
})

test('interrupt ends the turn at once, stops the Codex turn, and drops its late frames', async () => {
  const script = new Script().boot().turn('ct-1')
    .request('turn/interrupt', {})
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'late', text: 'too late', questions: null })
    .completed('ct-1', 'interrupted')
  harness = startHarness(script)
  harness.driver.send('long job')
  await until(() => harness!.wire.some(entry => entry.dir === 'in' && entry.raw.includes('turn/started')))
  await harness.driver.interrupt()
  expect(sentRequest(harness, 'turn/interrupt')).toEqual({ threadId: THREAD_ID, turnId: 'ct-1' })
  await until(() => harness!.wire.some(entry => entry.dir === 'in' && entry.raw.includes('"interrupted"')))
  await Bun.sleep(30)
  expect(eventTypes(harness.events)).toEqual(['turn_started', 'user_message', 'turn_interrupted'])
  expect(harness.statuses.at(-1)).toBe('waiting')
})

test('a process exit marks the driver dead; the next send respawns and resumes the thread', async () => {
  // Two runs (the fake splits at each initialize): the first exits once
  // replayed, the second is the respawn, which must resume, not restart.
  const script = new Script().boot().turn('ct-1').completed('ct-1')
  const second = new Script().boot('thread/resume').turn('ct-2').completed('ct-2')
  script.lines.push(...second.lines)
  const ends: number[] = []
  const serverEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_EXIT_AFTER_REPLAY: '1', FAKE_RUN: '1' }
  harness = startHarness(script, { onProcessEnd: () => ends.push(1), serverEnv })
  serverEnv.HOME = harness.dir
  serverEnv.FAKE_TRANSCRIPT = harness.transcript
  harness.driver.send('one')
  await until(() => harness!.driver.isDead)
  expect(completedOf(harness.events)).toHaveLength(1)
  expect(ends).toEqual([1])
  expect(harness.events.at(-1)).toMatchObject({ type: 'error', message: 'The Codex app-server exited with code 0' })
  expect(harness.statuses.at(-1)).toBe('waiting')

  serverEnv.FAKE_RUN = '2'
  harness.driver.send('two')
  expect(harness.driver.isDead).toBe(false)
  await until(() => completedOf(harness!.events).length === 2)
  expect(sentRequest(harness, 'thread/resume')).toMatchObject({ threadId: THREAD_ID })
  expect(harness.sessionIds).toEqual([THREAD_ID])
})

test('a compaction item reports onCompaction and the compacted notice; usage names its threshold source', async () => {
  const last = { totalTokens: 500, inputTokens: 450, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 }
  const script = new Script().boot().turn('ct-1')
    .notify('thread/tokenUsage/updated', { threadId: THREAD_ID, turnId: 'ct-1', tokenUsage: { total: last, last, modelContextWindow: 2_000 } })
    .item('completed', 'ct-1', { type: 'contextCompaction', id: 'cc-1' })
    .completed('ct-1')
  const compactions: Array<{ data: Record<string, unknown>; sourceId?: string }> = []
  const sources: Array<string | undefined> = []
  harness = startHarness(script, {
    onCompaction: (data, sourceId) => compactions.push({ data, sourceId }),
    onContextUsage: (_usage, opts) => sources.push(opts?.thresholdSource),
  })
  harness.driver.send('go')
  await until(() => completedOf(harness!.events).length === 1)
  expect(compactions).toEqual([{ data: expect.objectContaining({ trigger: 'auto', outcome: 'completed' }), sourceId: 'boundary:cc-1' }])
  expect(harness.events.find(event => event.type === 'notice')).toMatchObject({ text: 'Context compacted', kind: 'compacted' })
  expect(sources).toEqual(['model-window-fallback'])
})

test('effort passes through to the Codex levels the models advertise; numbers are dropped', () => {
  expect(codexEffort('low')).toBe('low')
  expect(codexEffort('xhigh')).toBe('xhigh')
  expect(codexEffort('max')).toBe('max')
  expect(codexEffort(3)).toBeUndefined()
  expect(codexEffort(undefined)).toBeUndefined()
})

test('per-item state lives one turn: a long session keeps only the open turn’s tool calls', async () => {
  const command = (id: string) => ({ type: 'commandExecution', id, command: 'true', cwd: '', status: 'inProgress', aggregatedOutput: null, exitCode: null })
  const script = new Script().boot()
  for (const n of [1, 2, 3]) {
    script.turn(`ct-${n}`)
      .item('started', `ct-${n}`, command(`cmd-${n}`))
      .item('completed', `ct-${n}`, { ...command(`cmd-${n}`), status: 'completed', aggregatedOutput: '', exitCode: 0 })
      .completed(`ct-${n}`, 'completed', [])
  }
  harness = startHarness(script)
  for (const n of [1, 2, 3]) {
    harness.driver.send(`turn ${n}`)
    await until(() => completedOf(harness!.events).length === n)
    // The just-ended turn's call is still listed until the next turn begins …
    expect([...harness.driver.getSeenToolCallIds()]).toEqual([`cmd-${n}`])
    const held = harness.driver as unknown as { itemInputs: Map<string, unknown> }
    expect([...held.itemInputs.keys()]).toEqual([`cmd-${n}`])
  }
  // … so three turns never accumulate three calls.
  expect(harness.events.filter(event => event.type === 'tool_call')).toHaveLength(3)
})

test('a rejected dynamic-tool registration refuses the start; no turn is asked', async () => {
  // thread/start answered with a JSON-RPC error: the boot fails, the
  // refusal names the server's message, and no turn/start follows.
  const script = new Script().request('initialize', { userAgent: 'fake' })
  script.lines.push({ dir: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} }) })
  script.lines.push({ dir: 'in', line: JSON.stringify({ id: 2, error: { code: -32602, message: 'dynamic tools rejected' } }) })
  // The registration itself carries the namespace: the team table rides the
  // thread/start params even though the server refuses them (N2).
  harness = startHarness(script, {
    teamTools: [{ name: 'send_message', description: 'send', schema: z.object({}), handler: () => ({}) }],
  })
  harness.driver.start()
  await until(() => harness!.events.some(event => event.type === 'error' && event.message.includes('dynamic tools rejected')))
  const startParams = sentRequest(harness, 'thread/start') as { dynamicTools?: Array<Record<string, unknown>> } | undefined
  expect(startParams?.dynamicTools?.[0]).toMatchObject({ type: 'namespace', name: 'kawai-team' })
  // The failed boot's cleanup may add its own exit error after this one.
  const boot = harness.events.find(event => event.type === 'error' && event.message.includes('dynamic tools rejected'))
  expect(boot).toMatchObject({ type: 'error', message: expect.stringContaining('dynamic tools rejected') })
  expect(harness.transcriptPaths).toEqual([])
  expect(harness.sessionIds).toEqual([])
  expect(sentRequest(harness, 'turn/start')).toBeUndefined()
})

test('a second turn reusing a question item id raises the card again', async () => {
  // startTurn clears the per-item state (askedItems among it), so an item
  // id a later turn reuses asks again instead of being swallowed.
  const asking = (id: string) => ({
    type: 'agentMessage', id, text: '', questions: [{ title: 'Proceed?', options: ['yes', 'no'] }],
  })
  const script = new Script().boot()
    .turn('ct-1')
    .item('started', 'ct-1', asking('q-1'))
    .completed('ct-1')
    .turn('ct-2')
    .item('started', 'ct-2', asking('q-1'))
    .completed('ct-2')
  harness = startHarness(script)
  harness.driver.send('one')
  await until(() => completedOf(harness!.events).length === 1)
  expect(harness.events.filter(event => event.type === 'question_request')).toHaveLength(1)
  harness.driver.send('two')
  await until(() => completedOf(harness!.events).length === 2)
  expect(harness.events.filter(event => event.type === 'question_request')).toHaveLength(2)
})

// --- PR E (codex-chat-sessions 7.1): usage wiring ---

const RATE_LIMITS = {
  limitId: 'codex',
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1792337450 },
  secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1792879251 },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: 'plus',
  rateLimitReachedType: null,
}

test('a rate-limits push reports the normalized windows through onRateLimit', async () => {
  const script = new Script().boot().turn('ct-1')
    .notify('account/rateLimits/updated', { rateLimits: RATE_LIMITS })
    .completed('ct-1')
  const reports: ChatUsageReport[] = []
  harness = startHarness(script, { onRateLimit: report => reports.push(report) })
  harness.driver.send('hi')
  await until(() => reports.length === 1)
  expect(reports[0]!.source).toBe('push')
  expect(reports[0]!.windows.map(window => window.key)).toEqual(['codex:primary', 'codex:secondary'])
})

test('the boot fill read is claim-gated: a claim reads once and reports as a provider pull', async () => {
  let claims = 0
  const script = new Script().boot()
    .request('account/rateLimits/read', { rateLimits: RATE_LIMITS })
    .turn('ct-1')
    .completed('ct-1')
  const reports: ChatUsageReport[] = []
  harness = startHarness(script, {
    claimRateLimitsRead: () => {
      claims += 1
      return claims === 1
    },
    onRateLimit: report => reports.push(report),
  })
  harness.driver.send('hi')
  await until(() => reports.length === 1)
  expect(reports[0]!.source).toBe('provider')
  expect(reports[0]!.windows).toHaveLength(2)
  expect(sentRequest(harness!, 'account/rateLimits/read')).toEqual({})
  expect(claims).toBe(1)
})

test('without a claim the boot sends no rate-limits read', async () => {
  const script = new Script().boot().turn('ct-1').completed('ct-1')
  harness = startHarness(script, { claimRateLimitsRead: () => false })
  harness.driver.send('hi')
  await until(() => completedOf(harness!.events).length === 1)
  expect(harness!.sent.map(message => message.method)).not.toContain('account/rateLimits/read')
})

test('a read without a usable snapshot reports no data', async () => {
  const script = new Script().boot()
    .request('account/rateLimits/read', {})
    .turn('ct-1')
    .completed('ct-1')
  let noData = 0
  harness = startHarness(script, { claimRateLimitsRead: () => true, onUsageNoData: () => { noData += 1 } })
  harness.driver.send('hi')
  await until(() => noData === 1)
})

// --- PR E (codex-chat-sessions 7.2): limit signals ---

const EXHAUSTED = {
  limitId: 'codex',
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1792337450 },
  secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1792879251 },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: 'plus',
  rateLimitReachedType: 'rate_limit_reached',
}

const turnError = (codexErrorInfo: unknown) =>
  ({ message: 'limit reached', codexErrorInfo, additionalDetails: null, misalignment: null })

test('a failed limit turn reports a final signal through onLimitEvent (PR E 7.2)', async () => {
  const script = new Script().boot().turn('ct-1')
    .notify('account/rateLimits/updated', { rateLimits: EXHAUSTED })
    .completed('ct-1', 'failed', [], turnError('usageLimitExceeded'))
  const signals: ChatLimitSignal[] = []
  harness = startHarness(script, { onLimitEvent: signal => signals.push(signal) })
  harness.driver.send('hi')
  await until(() => signals.length === 1)
  // Both windows exhausted: the weekly 2-day reset decides.
  expect(signals[0]).toMatchObject({
    kind: 'usageLimitExceeded',
    final: true,
    resetsAt: new Date(1792879251 * 1000).toISOString(),
    window: null,
  })
})

test('a retrying error notification reports a non-final signal', async () => {
  const script = new Script().boot().turn('ct-1')
    .notify('error', { error: turnError('rateLimitExceeded'), willRetry: true, threadId: THREAD_ID, turnId: 'ct-1' })
    .completed('ct-1')
  const signals: ChatLimitSignal[] = []
  harness = startHarness(script, { onLimitEvent: signal => signals.push(signal) })
  harness.driver.send('hi')
  await until(() => signals.length === 1)
  expect(signals[0]).toMatchObject({ kind: 'rateLimitExceeded', final: false })
})

test('a not-retrying error and an unrelated failure record no signal', async () => {
  const script = new Script().boot().turn('ct-1')
    .notify('error', { error: turnError('rateLimitExceeded'), willRetry: false, threadId: THREAD_ID, turnId: 'ct-1' })
    .completed('ct-1', 'failed', [], turnError('contextWindowExceeded'))
  const signals: ChatLimitSignal[] = []
  harness = startHarness(script, { onLimitEvent: signal => signals.push(signal) })
  harness.driver.send('hi')
  await until(() => completedOf(harness!.events).length === 1)
  expect(signals).toEqual([])
})
