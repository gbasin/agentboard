// Durable text awaiting explicit review; never flushed on reconnect.
import { useCallback, useEffect, useState } from 'react'
import { RecoveryDraftStorage, RECOVERY_DRAFT_PREFIX, MAX_RECOVERY_TEXT, MAX_RECOVERY_DRAFTS, type DraftPersistence } from '../utils/recoveryDraftStorage'
export { MAX_RECOVERY_TEXT } from '../utils/recoveryDraftStorage'
export type DeferredInputKind = 'typing' | 'paste'

export function editDeferredText(previous: string, data: string, kind: DeferredInputKind): string {
  // Escape sequences and terminal control keys are commands, not draft text.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x07\x0b\x0c\x0e-\x1f\x80-\x9f]/.test(data)) return previous
  if (kind === 'typing' && data.includes('\t')) return previous
  if (kind === 'paste') {
    // eslint-disable-next-line no-control-regex
    if (/[\x08\x7f]/.test(data)) return previous
    return previous + data.replace(/\r\n?/g, '\n')
  }
  let text = previous
  for (const character of data.replace(/\r\n?/g, '\n')) {
    text = character === '\b' || character === '\x7f'
      ? Array.from(text).slice(0, -1).join('') : text + character
  }
  return text
}

/** A hook owns only its unsaved fallback. Durable records belong to this origin. */
export function useRecoveryDraft(identity: string | null) {
  const [storage] = useState(() => new RecoveryDraftStorage())
  const [snapshot, setSnapshot] = useState(() => storage.select(identity))
  useEffect(() => { setSnapshot(storage.select(identity)) }, [storage, identity])
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(RECOVERY_DRAFT_PREFIX)) {
        setSnapshot(storage.storageChanged(event.key, event.newValue))
      }
    }
    if (typeof window === 'undefined') return
    window.addEventListener('storage', refresh)
    // Refresh on remount/subscription too; storage events do not fire in their writer.
    setSnapshot(storage.read())
    return () => window.removeEventListener('storage', refresh)
  }, [storage])
  const current = identity ? snapshot.drafts[identity] : undefined
  const persistence: DraftPersistence = identity ? snapshot.failures[identity] ?? 'saved' : 'saved'
  const update = useCallback((transform: (text: string) => string, reviewed = false, replace = false) => {
    if (persistence === 'sent-remove-failed') return
    if (identity) setSnapshot(storage.update(identity, transform, current?.revision ?? null, reviewed, replace))
  }, [storage, identity, current?.revision, persistence])
  const capture = useCallback((data: string, kind: DeferredInputKind) => {
    update(previous => editDeferredText(previous, data, kind))
  }, [update])
  const edit = useCallback((text: string) => update(() => {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').replace(/\r\n?/g, '\n')
  }, true), [update])
  const discard = useCallback(() => {
    if (identity) setSnapshot(storage.remove(identity, current?.revision ?? null))
  }, [storage, identity, current?.revision])
  const sent = useCallback(() => {
    if (identity) setSnapshot(storage.remove(identity, current?.revision ?? null, true))
  }, [storage, identity, current?.revision])
  const discardOthers = useCallback(() => setSnapshot(storage.removeOthers(identity)), [storage, identity])
  const save = useCallback(() => update(() => current?.text ?? '', false, true), [update, current?.text])
  return {
    text: current?.text ?? '',
    pending: !!current,
    truncated: !!current?.truncated,
    persistence,
    hasOtherDrafts: snapshot.overflow || Object.keys(snapshot.drafts).some(key => key !== identity),
    atLimit: snapshot.overflow || Object.values(snapshot.drafts).reduce((sum, value) => sum + value.text.length, 0) >= MAX_RECOVERY_TEXT - 1 ||
      Object.keys(snapshot.drafts).length >= MAX_RECOVERY_DRAFTS,
    capture, edit, discard, discardOthers, save, sent,
  }
}
