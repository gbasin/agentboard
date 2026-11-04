// The context-exhausted attention item (chat-context-exhaustion D8): its
// identity, owner, cause, impact, link, and each read-time resolution path.
import { describe, expect, test } from 'bun:test'
import type { ExhaustionEpisode } from '../team/exhaustionNotes'
import { attentionItems, WorkspaceRead, type AttentionInput } from '../team/workspaceRead'
import type { ExhaustionFact } from '../team/workspaceExhaustion'

const FLAGGED = '2026-10-18T09:00:00.000Z'

const episode = (patch: Partial<ExhaustionEpisode> = {}): ExhaustionEpisode => ({
  sessionId: 'dev-1', flaggedAt: FLAGGED, teamId: 'team', reason: 'blocking_limit', taskId: 't-1',
  droppedId: 'msg-12345678abc', recipientSession: 'lead', noteId: 'note-1', createdAt: FLAGGED, ...patch,
})

const fact = (patch: Partial<ExhaustionFact> = {}, episodePatch: Partial<ExhaustionEpisode> = {}): ExhaustionFact => ({
  episode: episode(episodePatch), sessionName: 'Dev one', currentFlagAt: FLAGGED, droppedState: 'dead',
  taskStatus: 'active', newestDispatchAt: '2026-10-18T08:00:00.000Z', ...patch,
})

const names: Record<string, string> = { lead: 'Lead', 'dev-1': 'Dev one' }
const input = (exhaustion: ExhaustionFact[]): AttentionInput => ({
  sessions: [], messages: [], waiting: {}, pendingAcceptance: [], outboundViolations: [],
  taskTitle: id => (id === 't-1' ? 'Export' : null),
  nameOf: id => names[id] ?? id,
  exhaustion,
})

const items = (...facts: ExhaustionFact[]) => attentionItems(input(facts)).filter(item => item.kind === 'context-exhausted')

describe('the context-exhausted attention item', () => {
  test('a noted episode waits on the dispatcher and opens the dropped message', () => {
    expect(items(fact())).toEqual([{
      id: `context-exhausted:dev-1:${FLAGGED}`,
      kind: 'context-exhausted',
      cause: 'Dev one stopped: context exhausted (blocking_limit); dropped message msg-1234',
      owner: { kind: 'session', id: 'lead', label: 'Lead' },
      impact: { taskId: 't-1', taskTitle: 'Export' },
      nextAction: 'Wait for a dispatch decision',
      link: { kind: 'message', id: 'msg-12345678abc' },
      requiresHuman: false,
    }])
  })

  test('a human-created session flagged with no task needs the human and opens the chat', () => {
    expect(items(fact({ taskStatus: null, newestDispatchAt: null, droppedState: null },
      { taskId: null, droppedId: null, recipientSession: null, noteId: null }))).toEqual([{
      id: `context-exhausted:dev-1:${FLAGGED}`,
      kind: 'context-exhausted',
      cause: 'Dev one stopped: context exhausted (blocking_limit)',
      owner: { kind: 'human', id: null, label: 'Human' },
      impact: {},
      nextAction: 'Compact, redispatch, or kill',
      link: { kind: 'chat', id: 'dev-1' },
      requiresHuman: true,
    }])
  })

  test('a recipient with no note sent (none eligible) leaves the item with the human', () => {
    expect(items(fact({}, { recipientSession: null, noteId: null }))[0]).toMatchObject({
      owner: { kind: 'human' }, requiresHuman: true, link: { kind: 'message' },
    })
  })

  test.each<[string, Partial<ExhaustionFact>]>([
    ['a newer dispatch on the task', { newestDispatchAt: '2026-10-18T09:30:00.000Z' }],
    ['the task done', { taskStatus: 'done' }],
    ['the task cancelled', { taskStatus: 'cancelled' }],
    ['the dropped message retried', { droppedState: 'queued' }],
    ['the dropped message discarded', { droppedState: 'discarded' }],
    ['the flag cleared', { currentFlagAt: null }],
    ['a later episode flagged', { currentFlagAt: '2026-10-18T11:00:00.000Z' }],
    ['the session killed', { sessionName: null }],
  ])('resolves on %s', (_label, patch) => {
    expect(items(fact(patch))).toEqual([])
  })

  test('a dispatch older than the flag, an open task, and a still-dead message keep it', () => {
    expect(items(fact({ newestDispatchAt: FLAGGED, taskStatus: 'open' }))).toHaveLength(1)
  })

  test('each episode is its own identity, so a later one toasts again', () => {
    const later = '2026-10-18T12:00:00.000Z'
    const ids = items(fact({ currentFlagAt: later }), fact({ currentFlagAt: later }, { sessionId: 'dev-1', flaggedAt: later }))
    // The earlier episode resolved when the flag moved on; only the later one shows.
    expect(ids.map(item => item.id)).toEqual([`context-exhausted:dev-1:${later}`])
  })
})

describe('the read model gathers each episode\'s facts', () => {
  type State = { flagAt: string | null; killed?: boolean; dropped: string; status: string; dispatches: string[] }
  const snapshotWith = (state: State) => {
    const records = state.killed ? [] : [
      { sessionId: 'dev-1', name: 'Dev one', archivedAt: '2026-10-18T09:01:00.000Z', contextExhausted: state.flagAt ? { at: state.flagAt, reason: 'blocking_limit' } : null },
      { sessionId: 'lead', name: 'Lead', archivedAt: null },
    ]
    const manager = {
      tasks: { store: {
        list: () => [], get: (id: string) => (id === 't-1' ? { id, title: 'Export', status: state.status } : null),
        assignmentsOf: () => state.dispatches.map(createdAt => ({ createdAt })),
        results: { get: () => null, outstandingSince: () => [], submittedBy: () => false },
        acknowledgements: { highest: () => null },
      } },
      mailbox: { store: { listForTeam: () => [], eventsFor: () => [], get: () => ({ state: state.dropped }) } },
      waitingFor: () => ({}),
      teamRecords: () => records,
      directory: { list: () => [] },
      getPendingRequests: () => [],
      teams: { catalogForTeam: () => ({ groups: new Map() }) },
      groupProfileCounts: () => ({}),
      teamApprovalDefault: () => null,
      turnEnds: { finishedForTeam: () => [] },
      outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
      exhaustionEpisodes: () => [episode()],
    }
    return new WorkspaceRead(manager as never).snapshot({ teamId: 'team' } as never)
      .attention.filter(item => item.kind === 'context-exhausted').map(item => item.id)
  }
  const open: State = { flagAt: FLAGGED, dropped: 'dead', status: 'active', dispatches: ['2026-10-18T08:00:00.000Z'] }

  test('a released (archived) flagged member still shows until a decision', () => {
    expect(snapshotWith(open)).toEqual([`context-exhausted:dev-1:${FLAGGED}`])
  })

  test.each<[string, Partial<State>]>([
    ['a newer dispatch', { dispatches: ['2026-10-18T08:00:00.000Z', '2026-10-18T09:05:00.000Z'] }],
    ['the task closed', { status: 'done' }],
    ['a retry', { dropped: 'queued' }],
    ['the flag cleared', { flagAt: null }],
    ['the kill', { killed: true }],
  ])('resolves on %s', (_label, patch) => {
    expect(snapshotWith({ ...open, ...patch })).toEqual([])
  })
})
