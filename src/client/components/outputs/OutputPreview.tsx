/** Cross-origin output viewer; opening/closing it never remounts the terminal. */
import { useEffect, useRef, useState } from 'react'
import { ICON_SIZE } from '../controlStyles'
import type { SessionMedia } from '@shared/types'
import { LinkExternal01Icon, XCloseIcon } from '../icons'
import { useSuspendTerminalInput } from '../settings/useDialogFocus'

const control = 'flex min-h-[44px] items-center justify-center rounded px-3 text-[12px] text-secondary hover:bg-hover hover:text-primary'

function MobileInputLock() {
  useSuspendTerminalInput()
  return <span data-suspends-terminal className="hidden" />
}

export function OutputPreview({ item, mobile, open, onClose, onChoose, status }: {
  item: SessionMedia
  mobile: boolean
  open: boolean
  onClose: () => void
  onChoose: () => void
  status?: string
}) {
  const [load, setLoad] = useState<{ url: string } | { error: string; candidates?: string[]; attemptedPath?: string } | null>(null)
  const [width, setWidth] = useState(48)
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState<{ itemUrl: string; path: string } | null>(null)
  const selected = selection?.itemUrl === item.url ? selection.path : undefined
  const [waiting, setWaiting] = useState(true)
  const [slow, setSlow] = useState(false)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoad(null)
    setWaiting(true)
    setSlow(false)
    if (item.kind === 'link') {
      try {
        const url = new URL(item.externalUrl ?? item.url, window.location.href)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === window.location.origin) {
          throw new Error('Open this link in a new tab to view it.')
        }
        if (window.location.protocol === 'https:' && url.protocol === 'http:') {
          throw new Error('This HTTP page cannot be embedded in an HTTPS dashboard. Open the original to view it.')
        }
        setLoad({ url: url.href })
      } catch (error) {
        setLoad({ error: error instanceof Error ? error.message : 'Invalid preview address' })
      }
      return () => controller.abort()
    }
    fetch(item.url + '&format=json&protocol=' + encodeURIComponent(window.location.protocol) + (selected ? '&candidate=' + encodeURIComponent(selected) : ''), { signal: controller.signal })
      .then(async response => {
        const body = await response.json()
        if (!response.ok) {
          if (!controller.signal.aborted) setLoad({
            error: body.error || 'Preview unavailable',
            attemptedPath: typeof body.attemptedPath === 'string' ? body.attemptedPath : undefined,
            candidates: Array.isArray(body.candidates) ? body.candidates.filter((value: unknown): value is string => typeof value === 'string') : undefined,
          })
          return
        }
        if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) throw new Error('Invalid preview address')
        if (window.location.protocol === 'https:' && new URL(body.url).protocol !== 'https:') throw new Error('This server returned an HTTP preview for an HTTPS dashboard. Update Agentboard or use Open original.')
        if (!controller.signal.aborted) setLoad({ url: body.url })
      }).catch(error => {
        if (!controller.signal.aborted) setLoad({ error: error.message || 'Preview unavailable' })
      })
    return () => controller.abort()
  }, [item.url, item.externalUrl, item.kind, revision, selected])
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setSlow(true), 12_000)
    return () => clearTimeout(timer)
  }, [waiting, revision])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!mobile && !panel.current?.contains(event.target as Node))) return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [open, mobile, onClose])

  return (
    <section
      ref={panel}
      hidden={!open}
      style={!open ? { display: 'none' } : mobile ? undefined : { width: `${width}%`, position: 'relative' }}
      data-testid="output-preview"
      aria-label={item.label || 'Output preview'}
      className={mobile
        ? 'fixed inset-0 z-[55] flex flex-col bg-base pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
        : 'flex min-w-0 w-[48%] min-h-0 flex-col border-l border-border bg-base'}
    >
      {!mobile && <div
        role="separator" aria-label="Resize output preview" aria-orientation="vertical"
        aria-valuemin={30} aria-valuemax={70} aria-valuenow={width} tabIndex={0}
        className="absolute -left-1 top-0 bottom-0 z-10 w-2 cursor-col-resize touch-none hover:bg-accent/30 focus-visible:bg-accent/30"
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          const bounds = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect()
          if (bounds) setWidth(Math.min(70, Math.max(30, Math.round((bounds.right - event.clientX) / bounds.width * 100))))
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          event.stopPropagation()
          setWidth(value => Math.min(70, Math.max(30, value + (event.key === 'ArrowLeft' ? 2 : -2))))
        }}
      />}
      {mobile && open && <MobileInputLock />}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {mobile && <button type="button" onClick={onClose} className={control}>← Terminal</button>}
        <div className={`min-w-0 flex-1 px-1 ${mobile ? 'order-last basis-full py-1' : ''}`}>
          <div className="truncate text-[13px] font-medium text-primary">{item.label || 'Output preview'}</div>
          <div className="text-[12px] text-muted">{item.kind === 'link' ? 'Web page' : item.kind === 'visualization' ? 'Codex visualization' : item.kind === 'html' ? 'HTML report' : 'Live app'}</div>
        </div>
        <button type="button" onClick={onChoose} className={control}>{item.kind === 'link' ? 'Links' : 'Previews'}</button>
        <button type="button" onClick={() => setRevision(v => v + 1)} className={control}>Reload</button>
        <a href={load && 'url' in load ? load.url : item.externalUrl ?? item.url} target="_blank" rel="noopener noreferrer" aria-label="Open output in new tab" className={control}>
          <LinkExternal01Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} /><span className="ml-1">Open original</span>
        </a>
        {!mobile && <button type="button" onClick={onClose} aria-label="Close preview" className={control}><XCloseIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} /></button>}
      </div>
      {item.kind === 'link' && <p className="shrink-0 border-b border-border px-3 py-2 text-[12px] text-muted">If this page stays blank or refuses to connect, use Open original.</p>}
      {load && 'error' in load ? (
        <div role="alert" className="min-h-0 overflow-y-auto p-5 text-[13px] text-secondary">
          <p>{load.error}</p>
          {load.attemptedPath && <p className="mt-3 break-all">Looked for: <code>{load.attemptedPath}</code></p>}
          {load.candidates && <ul aria-label="Matching session files" className="mt-3 space-y-2">
            {load.candidates.map(candidate => <li key={candidate}><button type="button"
              className="min-h-[44px] w-full break-all rounded border border-border px-3 py-2 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => setSelection({ itemUrl: item.url, path: candidate })}>{candidate}</button></li>)}
          </ul>}
          <button type="button" onClick={() => { setSelection(null); setRevision(v => v + 1) }} className="mt-3 rounded border border-border px-3 py-2">Try again</button>
        </div>
      ) : (
        <>
          {waiting && <div role="status" className="px-4 py-3 text-[12px] text-muted">{slow ? 'Still connecting. Preview ports must be reachable from this device. Try opening in a new tab or check your network.' : 'Opening preview…'}</div>}
          {load && 'url' in load && <iframe
            key={revision}
            title={item.label || 'Output preview'}
            src={load.url}
            className="min-h-0 w-full flex-1 border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
            referrerPolicy="no-referrer"
            onLoad={() => setWaiting(false)}
          />}
        </>
      )}
      {mobile && <div className="shrink-0 border-t border-border px-3 py-2 text-[12px] text-muted">Agent {status === 'working' ? 'is still working' : status === 'permission' ? 'needs permission' : 'status: ' + (status || 'unknown')}</div>}
    </section>
  )
}
