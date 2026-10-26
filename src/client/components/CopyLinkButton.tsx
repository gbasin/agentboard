/** Per-link copy feedback, driven by actual clipboard success rather than the click. */
import { useEffect, useRef, useState } from 'react'
import { copyTextWithResult } from '../utils/copyTextWithResult'
import { ICON_SIZE } from './controlStyles'
import { CheckIcon, Copy01Icon } from './icons'

export function CopyLinkButton({ url, label }: { url: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    setStatus('idle')
    return () => { generation.current++; clearTimeout(timer.current) }
  }, [url])
  const Icon = status === 'copied' ? CheckIcon : Copy01Icon
  return <span className="relative shrink-0">
    <button type="button" aria-label={`Copy link for ${label}`} title={status === 'copied' ? 'Copied' : 'Copy link'}
      aria-busy={status === 'copying'} data-copy-state={status}
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        // Safari pointer clicks need explicit focus, also ensuring the fallback
        // restores this button rather than the terminal and its software keyboard.
        event.currentTarget.focus({ preventScroll: true })
        clearTimeout(timer.current)
        const attempt = ++generation.current
        setStatus('copying')
        void copyTextWithResult(url).then(copied => {
          if (attempt !== generation.current) return
          setStatus(copied ? 'copied' : 'failed')
          if (copied) timer.current = setTimeout(() => setStatus('idle'), 2000)
        })
      }}
      className="flex h-[44px] w-[44px] items-center justify-center rounded text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <Icon aria-hidden="true" width={ICON_SIZE.primary} height={ICON_SIZE.primary} />
    </button>
    <span role="status" aria-live="polite" className={status === 'failed'
      ? 'absolute right-0 top-full z-10 w-48 rounded border border-border bg-surface p-2 text-xs text-secondary shadow-sm'
      : 'sr-only'}>
      {status === 'copied' ? 'Link copied' : status === 'failed' ? 'Could not copy. Touch and hold the link to copy it.' : ''}
    </span>
  </span>
}
