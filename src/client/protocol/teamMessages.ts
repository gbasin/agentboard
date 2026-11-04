// Store dispatches and notifications for the team mailbox/task message family
// the Messages read model (team-message-threads 5.2), and the Plans view
// (durable-plans D12): one paged list, its
// thread replies, and the human composer's send result. The view is
// host-agnostic and drives the wire itself; this is the host that feeds its
// store. A reply for a team key whose views moved (a rekey) is routed to
// the new key, so an in-flight result still settles its action.
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useTeamMessageStore } from '../stores/teamMessageStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamAuditStore } from '../stores/teamAuditStore'
import { handlePlanWorkspaceMessage } from './planWorkspaceMessages'
import { notifyDeliveredToHuman, notifyMailboxDeadLetter } from '../utils/teamMailboxNotification'
import { handleTeamApprovalDefaultResult, handleTeamWorkspaceMessage } from './teamWorkspaceMessages'
import { routedTeamPath } from '../utils/teamKeyAliases'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

type TeamMessage = Extract<ServerMessage, { type: `team-${string}` }>

const routed = <M extends { teamPath: string }>(message: M, views: Record<string, unknown>): M => {
  const teamPath = routedTeamPath(message.teamPath, views)
  return teamPath === message.teamPath ? message : { ...message, teamPath }
}

export function handleTeamMessage(message: TeamMessage, _deps: MessageRouterDeps): void {
  const mailbox = useTeamMailboxStore.getState()
  const messages = useTeamMessageStore.getState()
  const tasks = useTeamTaskStore.getState()
  const plans = useTeamPlanStore.getState()
  const audits = useTeamAuditStore.getState()
  switch (message.type) {
    case 'team-mailbox-snapshot': mailbox.apply(routed(message, mailbox.views)); return
    case 'team-mailbox-rules-result': mailbox.applyRulesResult(routed(message, mailbox.views)); return
    case 'team-mailbox-hand-off-result': mailbox.applyHandOffResult(routed(message, mailbox.views)); return
    case 'team-mailbox-dead-letter': notifyMailboxDeadLetter(message); return
    case 'team-mailbox-delivered-to-human': notifyDeliveredToHuman(message); return
    case 'team-tasks-snapshot': tasks.applySnapshot(routed(message, tasks.views)); return
    case 'team-task-detail': tasks.applyDetail(routed(message, tasks.views)); return
    case 'team-task-result': tasks.applyResult(routed(message, tasks.views)); return
    case 'team-task-preview-result': tasks.applyPreviewResult(routed(message, tasks.views)); return
    case 'team-task-targets-result': tasks.applyTargetsResult(routed(message, tasks.views)); return
    case 'team-task-capacity-result': tasks.applyCapacityResult(routed(message, tasks.views)); return
    case 'team-workspace-snapshot':
    case 'team-workspace': handleTeamWorkspaceMessage(message); return
    case 'team-workspace-approval-default-result': handleTeamApprovalDefaultResult(message); return
    case 'team-messages-snapshot': messages.applySnapshot(routed(message, messages.views)); return
    case 'team-messages': messages.applyPush(routed(message, messages.views)); return
    case 'team-thread': messages.applyThread(routed(message, messages.views)); return
    case 'team-message-send-result': messages.applyResult(routed(message, messages.views)); return
    // Durable plans (durable-plans D12).
    case 'team-plans-snapshot': plans.applySnapshot(routed(message, plans.views)); return
    case 'team-plan-detail': plans.applyDetail(routed(message, plans.views)); return
    case 'team-plan-result': plans.applyResult(routed(message, plans.views)); return
    // The plan workspace (plan-workspace §5).
    case 'team-plan-workspace-snapshot':
    case 'team-plan-workspace-checklist':
    case 'team-plan-workspace-document':
    case 'team-plan-workspace-artifacts':
    case 'team-plan-workspace-result': handlePlanWorkspaceMessage(message); return
    // The Audit tab (execution-safety-recovery D9).
    case 'team-audit-page': audits.applyPage(routed(message, audits.views)); return
    case 'team-audit-changed': audits.applyChanged(routed(message, audits.views)); return
    case 'team-audit-result': audits.applyResult(routed(message, audits.views)); return
  }
}
