// Spawned-member approval resolution (team-approval-default D2): a spawned
// chat's policy is its group file's `approval:` key when present, else the
// team's stored default, else manual. The spawn, the group dispatch preview,
// and the Members row all call this one function, so they can never disagree;
// the client only renders what the server resolved.
import type { ChatApprovalPolicy } from './chat'

/** Where a spawned member's policy came from. */
export type SpawnApprovalSource = 'group' | 'team' | 'built-in'

export interface SpawnApproval {
  policy: ChatApprovalPolicy
  source: SpawnApprovalSource
}

export function resolveSpawnApproval(
  groupApproval: ChatApprovalPolicy | undefined,
  teamDefault: ChatApprovalPolicy | null,
): SpawnApproval {
  if (groupApproval !== undefined) return { policy: groupApproval, source: 'group' }
  if (teamDefault !== null) return { policy: teamDefault, source: 'team' }
  return { policy: 'manual', source: 'built-in' }
}

/** Short source label for the UI: `group file`, `team default`, `built-in`. */
export function spawnApprovalSourceLabel(source: SpawnApprovalSource): string {
  return source === 'group' ? 'group file' : source === 'team' ? 'team default' : 'built-in'
}
