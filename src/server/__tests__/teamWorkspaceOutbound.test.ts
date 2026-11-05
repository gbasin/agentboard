// The workspace read's outbound pieces (execution-safety-recovery 4.3 and
// findings-8134cc45 PC1): the attention source's groups, the summary
// bucket, and the 24 h window with a restart reader — split out of
// teamWorkspaceRead.test.ts (findings-0f39baed N3) so the projection file
// stays near its size at base.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OutboundService, type OutboundViolationGroup } from '../outbound/service'
import { OutboundStore, type OutboundCallInsert } from '../outbound/store'
import { initDatabase } from '../db'
import { WorkspaceRead, attentionItems } from '../team/workspaceRead'
import { morningSummary } from '../team/workspaceSummary'

// The outbound window test reads a real store (findings-8134cc45 PC1): a
// stubbed windowCounts cannot catch a mutant on the snapshot's `since`.
const OB_TEAM = 'team-ob'
let obDb: ReturnType<typeof initDatabase> | null = null
let obStore: OutboundStore | null = null
afterEach(() => {
  obDb?.close()
  obDb = null
  obStore = null
})

/** A fresh service over a fresh store on the same database — a restart's reader. */
function realAudit(): OutboundService {
  if (obDb === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-workspace-ob-'))
    obDb = initDatabase({ path: path.join(dir, 'agentboard.db') })
  }
  obStore = new OutboundStore(obDb.db)
  return new OutboundService({
    store: obStore,
    sessionOf: (_teamId, sessionId) => ({ name: sessionId, clickable: false }),
    spawnLive: () => false,
  })
}

function outboundCall(overrides: Partial<OutboundCallInsert> = {}): OutboundCallInsert {
  return {
    id: 'obc-x', teamId: OB_TEAM, sessionId: 'chat-ob', spawnId: 'sp-ob', tool: 'Bash',
    toolUseId: `tu-${overrides.id ?? 'x'}`, command: 'git push origin main', truncated: false,
    rule: 'git-push', verdict: 'allowed', destination: 'github:origin', matches: '[]',
    classifierVersion: 3, cwd: '/repo', createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('outbound violations (execution-safety-recovery 4.3)', () => {
  const group = (overrides: Partial<OutboundViolationGroup> = {}): OutboundViolationGroup => ({
    rule: 'gh-write', destination: 'github:other/repo', count: 1,
    latestCallId: 'obc-1', latestSessionId: 'chat-1', latestCallAt: '2026-10-14T09:00:00Z',
    ...overrides,
  })
  const itemsFor = (groups: OutboundViolationGroup[]) => attentionItems({
    sessions: [], messages: [], waiting: {}, taskTitle: () => null, nameOf: id => `Name of ${id}`,
    pendingAcceptance: [], outboundViolations: groups,
  })

  test('one item per (rule, destination) group with the D10 shape', () => {
    const items = itemsFor([
      group({ rule: 'gh-write', destination: 'github:other/repo', count: 5, latestCallId: 'obc-9', latestSessionId: 'chat-2' }),
      group({ rule: 'mcp-call', destination: 'mcp:docs-search', latestCallId: 'obc-4' }),
    ])
    expect(items.map(item => item.id)).toEqual([
      'outbound-violation:gh-write:github:other/repo',
      'outbound-violation:mcp-call:mcp:docs-search',
    ])
    expect(items[0]).toEqual({
      id: 'outbound-violation:gh-write:github:other/repo', kind: 'outbound-violation',
      cause: 'gh-write to github:other/repo: 5 unacknowledged, latest by Name of chat-2',
      owner: { kind: 'human', id: null, label: 'Human' }, impact: {},
      nextAction: 'Review and acknowledge', link: { kind: 'audit', id: 'obc-9' }, requiresHuman: true,
    })
  })

  test('repeated calls to one server raise one item — the group carries the count', () => {
    // The service groups the rows; the source maps each group to one item.
    const items = itemsFor([group({ destination: 'mcp:docs-search', count: 5 })])
    expect(items).toHaveLength(1)
    expect(items[0]!.cause).toContain('5 unacknowledged')
  })

  test('unknown destinations and allowed rows raise nothing; an acknowledged state clears', () => {
    // Unknown-destination and allowed rows never reach the input: the
    // service groups violations only, so an empty group list — the state
    // after an acknowledgement covered every violation — yields no item.
    expect(itemsFor([])).toEqual([])
  })

  test('a violation after the group\'s acknowledgement raises it again', () => {
    // The acknowledgement covered the group through an older call, so the
    // snapshot's groups hold the later violation only: the item is back,
    // counted and linked to the newest call.
    const items = itemsFor([group({ count: 1, latestCallId: 'obc-later' })])
    expect(items.map(item => item.id)).toEqual(['outbound-violation:gh-write:github:other/repo'])
    expect(items[0]!.link).toEqual({ kind: 'audit', id: 'obc-later' })
  })
})

describe('the outbound summary bucket (execution-safety-recovery 4.3)', () => {
  const now = '2026-10-14T12:00:00Z'
  const input = (counts: { allowed: number; unknown: number; violations: number }) => ({
    now, sessions: [], messages: [], messageEvents: () => [], waiting: {}, turnEnds: [],
    nameOf: (id: string) => id, hasResult: () => false, results: [], outboundCounts: counts,
  })

  test('the window\'s rows count by class, each item opening the Audit tab', () => {
    const sum = morningSummary(input({ allowed: 2, unknown: 1, violations: 1 }))
    expect(sum.outbound).toEqual({
      items: [
        { id: 'outbound:allowed', label: '2 allowed sends', link: { kind: 'audit', id: '' } },
        { id: 'outbound:unknown', label: '1 unknown destination', link: { kind: 'audit', id: '' } },
        { id: 'outbound:violation', label: '1 violation', link: { kind: 'audit', id: '' } },
      ],
    })
    // An empty window lists nothing; the bucket is durable (never runtimeOnly).
    expect(morningSummary(input({ allowed: 0, unknown: 0, violations: 0 })).outbound).toEqual({ items: [] })
    expect(morningSummary(input({ allowed: 0, unknown: 0, violations: 0 })).outbound.runtimeOnly).toBeUndefined()
  })
})

describe('the outbound window against the real store (findings-8134cc45 PC1)', () => {
  const snapshotFor = (audit: { violationGroups(teamId: string): OutboundViolationGroup[]; windowCounts(teamId: string, from: string, to: string): { allowed: number; unknown: number; violations: number } }) => {
    const manager = {
      tasks: { store: {
        list: () => [], get: () => null,
        results: { get: () => null, outstandingSince: () => [], submittedBy: () => false },
        acknowledgements: { highest: () => null },
      } },
      mailbox: { store: { listForTeam: () => [], eventsFor: () => [] } },
      waitingFor: () => ({}),
      teamRecords: () => [],
      directory: { list: () => [] },
      getPendingRequests: () => [],
      teams: { catalogForTeam: () => ({ groups: new Map() }) },
      groupProfileCounts: () => ({}),
      teamApprovalDefault: () => null,
      turnEnds: { finishedForTeam: () => [] },
      outboundAudit: audit,
      exhaustionEpisodes: () => [],
    }
    return new WorkspaceRead(manager as never).snapshot({ teamId: OB_TEAM } as never)
  }

  test('a 25 h-old send is out of the 24 h bucket; a fresh reader (restart) counts the same', () => {
    const now = Date.now()
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString()
    realAudit() // opens the database
    obStore!.insertCall(outboundCall({ id: 'obc-old', verdict: 'violation', rule: 'gh-write', destination: 'github:old/repo', createdAt: at(25) }))
    obStore!.insertCall(outboundCall({ id: 'obc-new', verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo', createdAt: at(23) }))
    obStore!.insertCall(outboundCall({ id: 'obc-ok', verdict: 'allowed', rule: 'git-push', destination: 'github:origin', createdAt: at(1) }))
    const snapshot = snapshotFor(realAudit())
    const first = snapshot.summary.outbound
    expect(first).toEqual({
      items: [
        { id: 'outbound:allowed', label: '1 allowed send', link: { kind: 'audit', id: '' } },
        { id: 'outbound:violation', label: '1 violation', link: { kind: 'audit', id: '' } },
      ],
    })
    // A restart: a fresh store instance over the same database, no memory.
    const second = snapshotFor(realAudit()).summary.outbound
    expect(second).toEqual(first)
    // And the queue's groups ignore the window: the old violation still raises.
    expect(snapshot.attention.filter(item => item.kind === 'outbound-violation').map(item => item.id).sort())
      .toEqual(['outbound-violation:gh-write:github:old/repo', 'outbound-violation:gh-write:github:other/repo'])
  })
})
