// A message row's copy control (copy-chat-message-markdown D2, D4). It copies
// the row's original text — the event's own string, never rendered DOM text —
// through copyTextExact, then shows the outcome (check or alert icon) for
// 2000 ms, restarting on each click and cleared on unmount. The accessible
// name stays "Copy message"; a visually hidden status region announces
// "Copied" or "Copy failed". Visibility (hover, focus-within, always on touch)
// lives in the `.chat-row-copy` styles in index.css.
import { useEffect, useRef, useState } from 'react'
import AlertCircleIcon from '@untitledui-icons/react/line/esm/AlertCircleIcon'
import CheckIcon from '@untitledui-icons/react/line/esm/CheckIcon'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'
import { copyTextExact } from '../../utils/copyText'

export const COPY_FEEDBACK_MS = 2000

type CopyState = 'idle' | 'copied' | 'failed'

const STATUS: Record<CopyState, string> = { idle: '', copied: 'Copied', failed: 'Copy failed' }

export default function MessageCopyButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const show = (next: CopyState) => {
    if (!mounted.current) return
    if (timer.current !== null) clearTimeout(timer.current)
    setState(next)
    timer.current = setTimeout(() => {
      timer.current = null
      if (mounted.current) setState('idle')
    }, COPY_FEEDBACK_MS)
  }

  // Called synchronously in the click so the fallback runs inside the gesture.
  const onClick = () => {
    void copyTextExact(text).then(ok => show(ok ? 'copied' : 'failed'), () => show('failed'))
  }

  const Icon = state === 'copied' ? CheckIcon : state === 'failed' ? AlertCircleIcon : Copy01Icon
  return <button type="button" aria-label="Copy message" title="Copy message" data-testid="chat-message-copy"
    data-copy-state={state} onClick={onClick}
    className={`chat-row-copy ${state === 'failed' ? 'text-chat-danger' : 'text-secondary hover:text-primary'}`}>
    <Icon aria-hidden="true" className="h-[1.05em] w-[1.05em]" />
    <span role="status" className="sr-only" data-testid="chat-message-copy-status">{STATUS[state]}</span>
  </button>
}
