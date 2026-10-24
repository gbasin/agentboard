/** Tab-local text awaiting explicit review; never flushed on reconnect. */
import { useCallback, useState } from 'react'

export const MAX_RECOVERY_TEXT = 64 * 1024
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

function bounded(text: string, limit: number): string {
  const result = text.slice(0, Math.max(0, limit))
  // Never retain half of a surrogate pair at the capacity boundary.
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result
}

export function useRecoveryDraft(identity: string | null) {
  const [drafts, setDrafts] = useState<Record<string, { text: string; truncated: boolean }>>({})
  const update = useCallback((transform: (text: string) => string, reviewed = false) => {
    if (!identity) return
    setDrafts(previous => {
      const otherLength = Object.entries(previous).reduce((sum, [key, value]) => sum + (key === identity ? 0 : value.text.length), 0)
      const proposed = transform(previous[identity]?.text ?? '')
      const text = bounded(proposed, MAX_RECOVERY_TEXT - otherLength)
      const truncated = text !== proposed || (!reviewed && !!previous[identity]?.truncated)
      const next = { ...previous }
      if (text || truncated) next[identity] = { text, truncated }
      else delete next[identity]
      return next
    })
  }, [identity])
  const capture = useCallback((data: string, kind: DeferredInputKind) => {
    update(previous => editDeferredText(previous, data, kind))
  }, [update])
  const edit = useCallback((text: string) => update(() => {
    // The review editor cannot inject raw terminal control sequences.
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').replace(/\r\n?/g, '\n')
  }, true), [update])
  const discard = useCallback(() => update(() => '', true), [update])
  const discardOthers = useCallback(() => {
    setDrafts(previous => identity && previous[identity] ? { [identity]: previous[identity]! } : {})
  }, [identity])
  return {
    text: identity ? drafts[identity]?.text ?? '' : '',
    pending: !!identity && !!drafts[identity],
    truncated: !!identity && !!drafts[identity]?.truncated,
    hasOtherDrafts: Object.keys(drafts).some(key => key !== identity),
    atLimit: Object.values(drafts).reduce((sum, text) => sum + text.text.length, 0) >= MAX_RECOVERY_TEXT - 1,
    capture, edit, discard, discardOthers,
  }
}
