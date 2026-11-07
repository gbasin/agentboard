/** Confirm destructive catalog observations independently of the refresh worker. */
import type { SavedSession } from '../../shared/persistence'
import { logger } from '../logger'
import type { TmuxIdentity, WindowIdentity } from './tmuxIdentity'

// Missing tags are unknown, not evidence that another run owns the window.
export function identityChanged(
  tag: WindowIdentity | undefined,
  saved: Pick<SavedSession, 'id' | 'lastRunId'>
): boolean {
  if (!tag?.boardId || !tag.runId) return false
  return tag.boardId !== saved.id || tag.runId !== saved.lastRunId
}

export function confirmSnapshot(
  observed: TmuxIdentity,
  active: SavedSession[],
  readIdentity: () => TmuxIdentity
): TmuxIdentity {
  const suspect = active.filter(saved => saved.window && (
    saved.epoch !== observed.epoch ||
    !observed.windows.has(saved.window) ||
    identityChanged(observed.windows.get(saved.window), saved)
  ))
  if (!suspect.length) return observed

  // One read for the entire batch, only on anomalies. A failed read must
  // abort reconciliation before any claim is released or replacement adopted.
  let confirmed: TmuxIdentity
  try {
    confirmed = readIdentity()
    if (confirmed.epoch !== observed.epoch)
      throw new Error('tmux server changed during catalog confirmation')
  } catch (error) {
    logger.warn('catalog_snapshot_confirmation_failed', {
      boardSessionIds: suspect.map(saved => saved.id), error: String(error),
    })
    throw error
  }
  for (const saved of suspect) {
    logger.warn('catalog_snapshot_confirmed', {
      boardSessionId: saved.id,
      tmuxWindow: saved.window,
      expected: { epoch: saved.epoch, boardId: saved.id, runId: saved.lastRunId },
      observed: { epoch: observed.epoch, tag: observed.windows.get(saved.window!) ?? null },
      confirmed: { epoch: confirmed.epoch, tag: confirmed.windows.get(saved.window!) ?? null },
    })
  }
  return confirmed
}
