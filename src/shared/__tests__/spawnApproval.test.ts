// team-approval-default design table O1–O9, verbatim: the resolver's contract.
import { describe, expect, test } from 'bun:test'
import type { ChatApprovalPolicy } from '../chat'
import { resolveSpawnApproval, spawnApprovalSourceLabel, type SpawnApprovalSource } from '../spawnApproval'

type Row = [id: string, group: ChatApprovalPolicy | undefined, team: ChatApprovalPolicy | null, policy: ChatApprovalPolicy, source: SpawnApprovalSource]

// | id | group key | team default | policy | source   |
const TABLE: Row[] = [
  ['O1', undefined, null, 'manual', 'built-in'],
  ['O2', undefined, 'manual', 'manual', 'team'],
  ['O3', undefined, 'auto', 'auto', 'team'],
  ['O4', 'manual', null, 'manual', 'group'],
  ['O5', 'manual', 'manual', 'manual', 'group'],
  ['O6', 'manual', 'auto', 'manual', 'group'],
  ['O7', 'auto', null, 'auto', 'group'],
  ['O8', 'auto', 'manual', 'auto', 'group'],
  ['O9', 'auto', 'auto', 'auto', 'group'],
]

describe('resolveSpawnApproval', () => {
  for (const [id, group, team, policy, source] of TABLE) {
    test(`${id}: group ${group ?? 'absent'} × team ${team ?? 'none'} → ${policy} (${source})`, () => {
      expect(resolveSpawnApproval(group, team)).toEqual({ policy, source })
    })
  }

  test('labels each source for the UI', () => {
    expect(spawnApprovalSourceLabel('group')).toBe('group file')
    expect(spawnApprovalSourceLabel('team')).toBe('team default')
    expect(spawnApprovalSourceLabel('built-in')).toBe('built-in')
  })
})
