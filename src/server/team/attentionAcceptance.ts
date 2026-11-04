// The attention source for submitted results awaiting acceptance
// (attention-acceptance-ownership). Who has to act depends on two facts the
// stores already hold: whether the newest findings on the result fail (the
// work goes back to its submitter), and who closes the task (the human, or the
// live agent session that created it). A task a running execution owns is a
// source only for failing findings: WorkspaceRead leaves its acceptance out,
// because Kawai accepts it on landing.
import { attentionItemId } from '../../shared/teamWorkspace'
import type { AttentionInput, AttentionSource } from './workspaceRead'

/** A submitted, unaccepted outstanding result of a live task. */
export interface PendingAcceptance {
  resultId: string
  taskId: string
  /** Who submitted it, already labelled: the session's name, or "Human". */
  submitter: string
  /** The submitting agent session; null when the human submitted it. */
  submitterId: string | null
  needsReevaluation: boolean
  /** The verdict of the newest findings bound to the result; null without findings. */
  reviewVerdict: 'pass' | 'fail' | null
  /** The task's creator when it is a live (present, not archived) agent session; null otherwise. */
  liveCreator: { sessionId: string; name: string } | null
}

/** The task scope an item carries: the id, plus the title when it is known. */
export const taskImpact = (taskId: string | null, taskTitle: (taskId: string) => string | null) => {
  if (!taskId) return {}
  const title = taskTitle(taskId)
  return title === null ? { taskId } : { taskId, taskTitle: title }
}

/**
 * Failing findings are an agent-owned wait for fixes, owned by the result's
 * submitter. Otherwise a pending acceptance is agent-owned when a live agent
 * session created the task, and human-required for a human-created task or a
 * creator that is archived or killed.
 */
export const acceptanceItems: AttentionSource = ({ pendingAcceptance, taskTitle }: AttentionInput) =>
  pendingAcceptance.map(pending => {
    const impact = taskImpact(pending.taskId, taskTitle)
    const link = { kind: 'task' as const, id: pending.taskId }
    if (pending.reviewVerdict === 'fail') {
      return {
        id: attentionItemId('fixes-requested', pending.resultId),
        kind: 'fixes-requested' as const,
        cause: `Review of the result submitted by ${pending.submitter} requested fixes`,
        owner: pending.submitterId
          ? { kind: 'session' as const, id: pending.submitterId, label: pending.submitter }
          : { kind: 'human' as const, id: null, label: pending.submitter },
        impact,
        nextAction: 'Wait for fixes',
        link,
        requiresHuman: false,
      }
    }
    const creator = pending.liveCreator
    return {
      id: attentionItemId('pending-acceptance', pending.resultId),
      kind: 'pending-acceptance' as const,
      cause: creator
        ? `Result submitted by ${pending.submitter} awaits acceptance by ${creator.name}${pending.needsReevaluation ? ' (needs re-evaluation)' : ''}`
        : `Result submitted by ${pending.submitter} awaits acceptance${pending.needsReevaluation ? ' (needs re-evaluation)' : ''}`,
      owner: creator
        ? { kind: 'session' as const, id: creator.sessionId, label: creator.name }
        : { kind: 'human' as const, id: null, label: 'Human' },
      impact,
      nextAction: 'Accept result',
      link,
      requiresHuman: creator === null,
    }
  })
