// The Execution section's component scenarios (plan-execution §15.4, D17):
// the state and waiting explained, flaky CI and attested checks labeled, a
// landing flagged when its tree was not verified, disconnected controls,
// Stop listing what it cancels and keeps, the Start dialog's standing and
// refusal, a lost preview asked again after a reconnect, and the task
// view's Accept note appearing only for a task an execution owns. Renderers are created inside act() so later store updates
// re-render (the bun act trap).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { createElement } from 'react'
import PlanExecutionSection from '../components/team/PlanExecutionSection'
import PlanExecutionStartDialog from '../components/team/PlanExecutionStartDialog'
import PlanExecutionStopDialog from '../components/team/PlanExecutionStopDialog'
import TaskResultsSection from '../components/team/TaskResultsSection'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import type { PlanExecutionView } from '@shared/planExecution'
import type { HumanTaskDetail } from '@shared/teamTasks'

let renderer: TestRenderer.ReactTestRenderer | null = null
const render = (node: ReturnType<typeof createElement>) => {
  renderer = TestRenderer.create(node)
}
const text = () => JSON.stringify(renderer?.toJSON() ?? null)

beforeEach(() => {})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  useTeamPlanStore.getState().close('/repo')
  useTeamPlanStore.getState().close('/other-repo')
})

const FLOOR = { version: 1 as const, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } }
const baseExecution = (changes: PlanExecutionView['changes']): PlanExecutionView => ({
  id: 'exec-1', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
  landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: FLOOR, maxParallel: 2, mergeMethod: 'merge',
  state: 'running', outcome: null, stopReason: null, startedAt: '', finishedAt: null, changes,
})
const changeRow = (over: Partial<PlanExecutionView['changes'][number]> = {}): PlanExecutionView['changes'][number] => ({
  change: 'api', position: 0, state: 'implementing', step: null, waiting: null, stopReason: null, stopDetail: null,
  taskId: 'task-1', worktree: '/w', branch: 'api', baselineCommit: 'b', prNumber: null, prUrl: null,
  fixRounds: 0, generation: 1, passedAt: null, attempts: 1, attempt: null, instruction: null,
  latestRound: null, landing: null, effects: [], ...over,
})
const planSummary: PlanSummary = {
  id: 'plan-1', teamId: 't', title: 'P', lifecycle: 'open', createdAt: '', updatedAt: '', state: 'in-progress',
  creator: { kind: 'human', sessionId: null }, currentApprovedRevision: 1, pin: null, linkedTaskCount: 0,
}
const detailOf = (executions: PlanExecutionView[]): PlanDetail => ({
  plan: planSummary,
  // The section reads only the approved revision's number and hash.
  revisions: [{ revision: 1, contentHash: 'h' }] as unknown as PlanDetail['revisions'],
  drafts: [], events: [], linkedTasks: [], progress: null, executions,
})

const section = (executions: PlanExecutionView['changes'], connected = true) =>
  createElement(PlanExecutionSection, { teamPath: '/repo', plan: planSummary, detail: detailOf([baseExecution(executions)]), connected, onSend: () => undefined })

describe('PlanExecutionSection', () => {
  test('waiting is explained; the state shows', () => {
    render(section([
      changeRow({ state: 'waiting', waiting: { kind: 'dependency', changes: ['ui'] } }),
      changeRow({ change: 'ui', position: 1, state: 'gating', waiting: { kind: 'ci', pending: ['ci'] }, latestRound: { id: 'r1', number: 1, attemptId: 'a1', resultId: 'res', commit: 'c', fixRound: false, carriedFrom: null, pushedAt: 't', ci: { checks: [{ name: 'ci', source: 'status', conclusion: 'pending', link: null, startedAt: null, completedAt: null }], flaky: [], rerunAt: null, state: 'pending' }, reviewAssignmentId: null, verdict: null, extraChecks: [], outcome: null, decidedAt: null } }),
    ]))
    const tree = text()
    expect(tree).toContain('waiting for ui')
    expect(tree).toContain('CI running: ci')
    expect(tree).toContain('Running')
  })

  test('a flaky check and the attested and CI-verified extra checks are labeled; an unverified tree flags the landing', () => {
    render(section([
      changeRow({
        state: 'landed',
        latestRound: { id: 'r1', number: 2, attemptId: 'a1', resultId: 'res', commit: 'c', fixRound: false, carriedFrom: null, pushedAt: 't',
          ci: { checks: [{ name: 'ci', source: 'actions', conclusion: 'success', link: null, runId: 1, startedAt: null, completedAt: null }], flaky: ['ci'], rerunAt: null, state: 'pass' },
          reviewAssignmentId: 'as', verdict: { findingsId: 'f1', verdict: 'pass', reviewer: 'rev' }, extraChecks: [{ name: 'security', description: 'no secrets', command: null, by: 'reviewer', outcome: 'attested' }, { name: 'bundle-size', description: 'under 2 MiB', command: 'bun run size', by: 'ci', outcome: 'success' }], outcome: 'pass', decidedAt: 't' },
        landing: { planId: 'plan-1', change: 'api', executionId: 'exec-1', mechanism: 'direct', prNumber: 7, prUrl: 'https://example.internal/pr/7', headSha: 'h', baseSha: 'b', mergeSha: 'm', landedAt: 't', treeVerified: false, postCi: null },
      }),
    ]))
    const tree = text()
    expect(tree).toContain('(flaky)')
    expect(tree).toContain('review pass')
    expect(tree).toContain('tree not verified')
    expect(tree).toContain('security · attested by the reviewer (rev)')
    expect(tree).toContain('bundle-size · verified by CI')
  })

  test('Stop opens to list what it cancels and keeps; disconnected disables the control', () => {
    useTeamPlanStore.getState().open('/repo')
    render(section([
      changeRow({ change: 'api', state: 'landed' }),
      changeRow({ change: 'ui', position: 1 }),
    ]))
    const open = renderer!.root.findByProps({ 'data-testid': 'plan-execution-stop-open' })
    act(() => open.props.onClick())
    const tree = text()
    expect(tree).toContain('Cancels')
    expect(tree).toContain('Keeps')
    act(() => renderer!.unmount())
    renderer = null
    render(section([changeRow()], false))
    expect(renderer!.root.findByProps({ 'data-testid': 'plan-execution-stop-open' }).props.disabled).toBe(true)
  })

  test('no execution: the empty state with the Start hint and dialog', () => {
    render(createElement(PlanExecutionSection, { teamPath: '/repo', plan: planSummary, detail: detailOf([]), connected: true, onSend: () => undefined }))
    expect(text()).toContain('No execution has run')
    expect(text()).toContain('Start runs the approved revision')
    expect(renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-button' })).toBeTruthy()
  })
})

describe('PlanExecutionSection after an execution', () => {
  test('a stopped execution offers Start again for the approved revision; a running one does not', () => {
    const stopped = { ...baseExecution([changeRow()]), state: 'finished' as const, outcome: 'stopped' as const, stopReason: 'superseded' }
    render(createElement(PlanExecutionSection, { teamPath: '/repo', plan: planSummary, detail: detailOf([stopped]), connected: true, onSend: () => undefined }))
    expect(renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-button' })).toBeTruthy()
    expect(renderer!.root.findAllByProps({ 'data-testid': 'plan-execution-stop-open' })).toHaveLength(0)
    act(() => renderer!.unmount())
    renderer = null
    render(section([changeRow()]))
    expect(renderer!.root.findAllByProps({ 'data-testid': 'plan-execution-start-button' })).toHaveLength(0)
  })
})

describe('PlanExecutionChangeRow Retry', () => {
  const stoppedRow = changeRow({ state: 'stopped', stopReason: 'task-closed' })
  const running = (rows: PlanExecutionView['changes'], onSend: (message: unknown) => void) =>
    createElement(PlanExecutionSection, { teamPath: '/repo', plan: planSummary, detail: detailOf([baseExecution(rows)]), connected: true, onSend })

  test('a stopped change sends the retry command naming the execution and change; success retires the dialog', () => {
    useTeamPlanStore.getState().open('/repo')
    const sent: Array<{ type: string; requestId: string; executionId: string; change: string; commandId: string }> = []
    act(() => render(running([stoppedRow], message => sent.push(message as (typeof sent)[number]))))
    act(() => renderer!.root.findByProps({ 'data-testid': 'plan-execution-retry-command' }).props.onClick())
    expect(sent).toHaveLength(0)
    act(() => renderer!.root.findByProps({ 'data-testid': 'plan-execution-retry-command-confirm' }).props.onClick())
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'team-plan-execution-retry', teamPath: '/repo', executionId: 'exec-1', change: 'api' })
    expect(sent[0]!.commandId).not.toBe('')
    act(() => useTeamPlanStore.getState().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: sent[0]!.requestId, replayed: false } as never))
    expect(renderer!.root.findAllByProps({ 'data-testid': 'plan-execution-retry-command-dialog' })).toHaveLength(0)
  })

  test('a change that is not stopped, or a finished execution, offers no Retry', () => {
    useTeamPlanStore.getState().open('/repo')
    act(() => render(running([changeRow()], () => undefined)))
    expect(renderer!.root.findAllByProps({ 'data-testid': 'plan-execution-retry' })).toHaveLength(0)
    act(() => renderer!.unmount())
    const finished = { ...baseExecution([stoppedRow]), state: 'finished' as const, outcome: 'stopped' as const, stopReason: 'superseded' }
    act(() => render(createElement(PlanExecutionSection, { teamPath: '/repo', plan: planSummary, detail: detailOf([finished]), connected: true, onSend: () => undefined })))
    expect(renderer!.root.findAllByProps({ 'data-testid': 'plan-execution-retry' })).toHaveLength(0)
  })
})

describe('PlanExecutionStartDialog', () => {
  test('opening asks the server for the standing; the reply disables or arms Start (15.4)', () => {
    useTeamPlanStore.getState().open('/repo')
    const sent: Array<{ type: string; requestId: string }> = []
    render(createElement(PlanExecutionStartDialog, {
      teamPath: '/repo', planId: 'plan-1', revision: 1, contentHash: 'h', connected: true,
      onSend: message => sent.push(message as { type: string; requestId: string }),
    }))
    const open = renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-button' })
    act(() => open.props.onClick())
    // Open → send: the preview request left with the dialog open and pending.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe('team-plan-execution-preview')
    expect(text()).toContain('Checking the standing')
    // Reply → the standing shows and Start stays disabled while not ready.
    act(() => useTeamPlanStore.getState().applyResult({
      type: 'team-plan-result', teamPath: '/repo', requestId: sent[0]!.requestId,
      preview: { failures: [{ name: 'landing-ready', message: 'No floor map is configured.' }], ready: false },
    }))
    expect(text()).toContain('landing-ready')
    expect(text()).toContain('No floor map')
    expect(renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-confirm' }).props.disabled).toBe(true)
    // Re-opening refreshes the standing; a ready one arms the confirm.
    act(() => open.props.onClick())
    expect(sent).toHaveLength(2)
    act(() => useTeamPlanStore.getState().applyResult({
      type: 'team-plan-result', teamPath: '/repo', requestId: sent[1]!.requestId,
      preview: { failures: [], ready: true },
    }))
    expect(renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-confirm' }).props.disabled).toBe(false)
  })
})

describe('PlanExecutionStartDialog after a reconnect', () => {
  test('a preview answer lost with the connection is asked for again while the dialog is open (N4)', () => {
    useTeamPlanStore.getState().open('/repo')
    const sent: Array<{ type: string; requestId: string }> = []
    act(() => render(createElement(PlanExecutionStartDialog, {
      teamPath: '/repo', planId: 'plan-1', revision: 1, contentHash: 'h', connected: true,
      onSend: message => sent.push(message as { type: string; requestId: string }),
    })))
    act(() => renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-button' }).props.onClick())
    expect(sent).toHaveLength(1)
    act(() => useTeamPlanStore.getState().reconnected('/repo'))
    expect(sent).toHaveLength(2)
    expect(sent[1]!.type).toBe('team-plan-execution-preview')
    act(() => useTeamPlanStore.getState().applyResult({
      type: 'team-plan-result', teamPath: '/repo', requestId: sent[1]!.requestId, preview: { failures: [], ready: true },
    }))
    expect(renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-confirm' }).props.disabled).toBe(false)
  })
})

describe('PlanExecutionStartDialog re-keyed to another team', () => {
  test('an open dialog asks the new team for its standing (review O1)', () => {
    useTeamPlanStore.getState().open('/repo')
    useTeamPlanStore.getState().open('/other-repo')
    const sent: Array<{ type: string; teamPath: string }> = []
    const dialog = (teamPath: string) => createElement(PlanExecutionStartDialog, {
      teamPath, planId: 'plan-1', revision: 1, contentHash: 'h', connected: true,
      onSend: message => sent.push(message as { type: string; teamPath: string }),
    })
    act(() => render(dialog('/repo')))
    act(() => renderer!.root.findByProps({ 'data-testid': 'plan-execution-start-button' }).props.onClick())
    // The team switch keeps the view mounted; the other team's slot is armed as its own open would.
    act(() => useTeamPlanStore.getState().arm('/other-repo', 'start:plan-1:1'))
    act(() => renderer!.update(dialog('/other-repo')))
    expect(sent.filter(message => message.type === 'team-plan-execution-preview').map(message => message.teamPath)).toEqual(['/repo', '/other-repo'])
  })
})

describe('PlanExecutionStopDialog', () => {
  test('the reason is required and the command is armed', () => {
    useTeamPlanStore.getState().open('/repo')
    const sent: unknown[] = []
    render(createElement(PlanExecutionStopDialog, {
      teamPath: '/repo', execution: baseExecution([changeRow()]), connected: true,
      onSend: message => sent.push(message),
    }))
    const open = renderer!.root.findByProps({ 'data-testid': 'plan-execution-stop-open' })
    act(() => open.props.onClick())
    expect(text()).toContain('Reason (required)')
    const confirm = renderer!.root.findByProps({ 'data-testid': 'plan-execution-stop-confirm' })
    expect(confirm.props.disabled).toBe(true)
    const input = renderer!.root.findByProps({ 'aria-label': 'Stop reason' })
    act(() => input.props.onChange({ target: { value: 'enough' } }))
    expect(text()).toContain('Stop this execution?')
  })
})

describe('the task Accept note', () => {
  const result = {
    id: 'res-1', taskId: 'task-1', summary: 'done', commit: 'c', diff: null, worktree: null, tests: [], limitations: null,
    taskRevision: 1, submittedBy: { kind: 'agent' as const, sessionId: 'dev' }, submittedAt: '', supersedesResultId: null,
    supersededBy: null, acceptedBy: null, acceptedAt: null, needsReevaluation: false, reviewVerdict: null, findings: [], createdAt: '',
  }
  const taskDetail = (planId: string | null, planChange: string | null): HumanTaskDetail => ({
    id: 'task-1', title: 'T', status: 'open', revision: 1, direction: 'd', acceptance: null,
    creator: { kind: 'human', sessionId: null }, createdAt: '', updatedAt: '',
    revisions: [], journal: [], subtasks: [], messages: [], draft: null, participants: [], planId, planChange, planTitle: null,
    publications: [], assignments: [], spawned: false,
    task: {
      id: 'task-1', title: 'T', status: 'open', revision: 1, planId, planChange, planTitle: null,
      creator: { kind: 'human' as const, sessionId: null }, participants: [], assignment: null, spawned: false, waitingReason: null,
    },
    outstandingResult: result, results: [result],
  } as unknown as HumanTaskDetail)

  const resultsSection = (planId: string | null, planChange: string | null) => createElement(TaskResultsSection, {
    detail: taskDetail(planId, planChange),
    groups: [], sessions: [], connected: true, disabled: false, host: { teamPath: '/repo', sendMessage: () => {} },
    act: (kind: string) => {
      // The Accept confirm button calls act('accept'); the note is what is
      // under test, so the act itself is a no-op here.
      void kind
    },
  })

  beforeEach(() => {
    useTeamPlanStore.getState().open('/repo')
    useTeamPlanStore.getState().select('/repo', 'plan-1')
  })

  test('appears for a task an execution owns, and not otherwise', () => {
    useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: detailOf([baseExecution([changeRow({ taskId: 'task-1' })])]) })
    render(resultsSection('plan-1', 'api'))
    // The note rides the Accept confirmation, which the Accept button opens.
    act(() => renderer!.root.findByProps({ 'data-testid': 'task-accept' }).props.onClick())
    let tree = text()
    expect(tree).toContain('A running execution owns this change')
    expect(tree).toContain('merges nothing')

    useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: detailOf([]) })
    act(() => renderer?.unmount())
    renderer = null
    render(resultsSection('plan-1', 'api'))
    act(() => renderer!.root.findByProps({ 'data-testid': 'task-accept' }).props.onClick())
    tree = text()
    expect(tree).toContain('task-accept-confirm')
    expect(tree).not.toContain('A running execution owns this change')
  })
})

