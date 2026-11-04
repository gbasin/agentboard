// A group target's dispatch preview (task-assignment D6, dispatch-worker-choice
// D10): what dispatch would do with the instruction, read from the same pure
// eligibility check the router applies and the router's cooling skip
// (`builtinPick`), never a second implementation. Members are the group's
// live members judged by the group path's member-state predicates (idle,
// available, in the worktree, not parked, not context-exhausted); pending
// spawns count toward caps once, beside them. A worker choice narrows both;
// when every chosen candidate cools, the preview says so and names the
// cooldown end — it never refuses, and the instruction waits until then.
// Without a choice it answers exactly what it answered before the choice.
import type { AssignmentTarget, TaskDispatchPreview } from '../../shared/teamTasks'
import type { RouteCandidate } from '../../shared/routing'
import type { MailRecipient } from './dispatcher'
import type { GroupDefinition } from './groupFile'
import { builtinPick } from './routing/builtin'
import type { GroupMemberRecord } from './routing/router'
import { evaluateEligibility, groupPathEligible, spawnCandidateId, type EligibilityReason } from './routing/workerEligibility'
import { workerChoiceState } from './routing/workerSelector'
import type { StaffingPreview } from './staffing'
import type { ChatApprovalPolicy } from '../../shared/chat'
import { resolveSpawnApproval } from '../../shared/spawnApproval'

/** The shared resolution, as the preview's `approval` and `approvalSource`. */
function approvalOf(groupApproval: ChatApprovalPolicy | undefined, teamDefault: ChatApprovalPolicy | null) {
  const { policy, source } = resolveSpawnApproval(groupApproval, teamDefault)
  return { approval: policy, approvalSource: source }
}

export interface GroupPreviewInput {
  worktree: string | null
  target: AssignmentTarget
  group: GroupDefinition
  /** The group's live members of this team (the router's roster). */
  members: GroupMemberRecord[]
  /** A member's recipient facts, as the dispatcher states them. */
  recipient: (sessionId: string) => MailRecipient | undefined
  facts: StaffingPreview
  teamCap: number
  providerOf: (profileId: string) => string
  cooldownUntil: (profileId: string) => string | null
  /** The canonical worker choice, or null. */
  workerChoice: string | null
  /** The team's stored default approval policy, or null (team-approval-default D5). */
  teamDefault: ChatApprovalPolicy | null
  now: number
}

/** Reasons that only the staffing facts give: the slot's profile is still open once they clear. */
const STAFFING_KINDS: ReadonlySet<EligibilityReason['kind']> = new Set(['group-cap', 'team-spawn-cap', 'worktree-occupied', 'spawn-backoff', 'spawn-not-allowed'])

export function previewGroupDispatch(input: GroupPreviewInput): TaskDispatchPreview {
  const { worktree, target, group, facts, teamCap, now } = input
  const choice = workerChoiceState(input.workerChoice, group, input.providerOf)
  const result = evaluateEligibility({
    group,
    members: input.members.map(member => {
      const recipient = input.recipient(member.sessionId)
      return {
        sessionId: member.sessionId, profileId: member.profileId, cwd: member.cwd,
        eligible: recipient !== undefined && groupPathEligible(recipient, { toKind: 'group' }, { targetWorktree: worktree, now, startupFailed: false }),
      }
    }),
    pendingSpawnProfiles: facts.pendingProfiles,
    spawnAllowed: worktree !== null && facts.teamSpawned < teamCap && facts.worktreeWriters < 1,
    // Slots are judged even without a worktree, so the preview names the
    // profile a spawn would use once one is targeted (spawnAllowed is false).
    spawnCwd: worktree ?? '',
    staffing: { teamSpawned: facts.teamSpawned, teamCap, worktreeOccupants: [], worktreePending: facts.worktreeWriters, backoffRetryAt: null },
    providerOf: input.providerOf,
    workerChoice: choice,
  })
  const members = result.candidates.filter(candidate => candidate.kind === 'member')
  // The slots no filter or profile cap drops, in the group's order: the staffing facts alone may still block them.
  const order = result.group.profiles.map(entry => entry.profileId)
  const open = new Set([
    ...result.candidates.filter(candidate => candidate.kind === 'spawn').map(candidate => candidate.profileId),
    ...result.excluded.flatMap(({ alternative, reasons }) =>
      alternative.kind === 'spawn' && reasons.every(reason => STAFFING_KINDS.has(reason.kind)) ? [alternative.profileId] : []),
  ])
  const slots: RouteCandidate[] = order.filter(profileId => open.has(profileId)).map(profileId => ({
    id: spawnCandidateId(profileId), kind: 'spawn', profileId, providerId: input.providerOf(profileId), cwd: worktree ?? '',
  }))
  const until = (profileId: string) => {
    const end = input.cooldownUntil(profileId)
    return end !== null && Date.parse(end) > now ? end : null
  }
  const cooling = (profileId: string) => until(profileId) !== null
  const picked = builtinPick(group.strategy, slots, order, cooling)?.profileId ?? null
  // Every candidate of the choice cools: the instruction waits for the first end (the router's retry).
  const live = [...members, ...slots]
  const ends = live.map(candidate => until(candidate.profileId)).filter((end): end is string => end !== null).sort()
  const choiceCooling = choice !== null && live.length > 0 && live.every(candidate => cooling(candidate.profileId)) ? ends[0]! : null
  const profile = choice ? picked ?? slots[0]?.profileId ?? null : picked

  let blockedBy: string | null = null
  if (worktree === null) blockedBy = 'the task has no target worktree'
  else if (facts.groupMembers >= group.max) blockedBy = `group ${target.id} is at its max of ${group.max} live members`
  else if (facts.teamSpawned >= teamCap) blockedBy = `the team is at its cap of ${teamCap} spawned sessions`
  else if (facts.worktreeWriters >= 1) blockedBy = `a spawned member already works in ${worktree}`
  else if (picked === null) {
    blockedBy = !choice ? 'every allowed profile is at its cap or cooling down'
      : slots.length > 0 ? `worker ${choice.selector} (${choice.profiles.join(', ')}) is cooling until ${slots.map(slot => until(slot.profileId)!).sort()[0]}`
        : `every profile of worker ${choice.selector} (${choice.profiles.join(', ')}) is at its cap`
  }
  return {
    worktree, target, role: group.label, profile, ...approvalOf(group.approval, input.teamDefault),
    sessionWorktree: null, idleMembers: members.map(candidate => candidate.sessionId!),
    spawn: { allowed: blockedBy === null, profile, blockedBy },
    warning: choiceCooling !== null ? `Worker ${choice!.selector} is cooling until ${choiceCooling}; the instruction waits until then` : null,
    ...(choice ? { worker: { selector: choice.selector, profiles: [...choice.profiles], cooldownUntil: choiceCooling } } : {}),
  }
}
