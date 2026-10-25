/** On-demand session web links. Search and source excerpts stay out of the terminal. */
import { useEffect, useRef, useState } from 'react'
import type { Session, SessionMedia } from '@shared/types'
import { useMediaPages } from '../hooks/useMediaPages'
import { ICON_SIZE } from './controlStyles'
import { ChevronRightIcon } from './icons'

function LinkRow({ item }: { item: SessionMedia }) {
  const [showSource, setShowSource] = useState(false)
  const destination = item.externalUrl ?? item.url
  let title = item.label
  if (!title) {
    try { const url = new URL(destination); title = url.hostname + (url.pathname === '/' ? '' : url.pathname) }
    catch { title = destination }
  }
  return <div className="border-b border-border/60">
    <div className="flex min-h-[60px] items-center gap-2 px-3 py-2">
      <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={title}
        className="min-w-0 flex-1 rounded text-[12px] leading-[18px] text-primary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span className="block truncate">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] leading-[16px] text-secondary" title={destination}>
          {destination.replace(/^https?:\/\//i, '')}
        </span>
      </a>
      {item.sourceText && <button type="button" aria-label={`Source for ${title}`} aria-expanded={showSource}
        onClick={() => setShowSource(value => !value)}
        className="flex h-[44px] w-[36px] shrink-0 items-center justify-center rounded text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <ChevronRightIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className={showSource ? 'rotate-90' : ''} />
      </button>}
    </div>
    {showSource && <p className="whitespace-pre-wrap break-words bg-surface px-3 py-2 text-[11px] leading-[17px] text-secondary" data-testid="link-source">
      <span className="block text-muted">Agent reply excerpt</span>{item.sourceText}
    </p>}
  </div>
}

export default function SessionLinks({ session, ready, search, onRefresh }: { session: Session; ready: boolean; search: string; onRefresh: () => void }) {
  const pages = useMediaPages(session.agentSessionId, session.mediaSummary, true, ready, { kind: 'links', search })
  const scroll = useRef<HTMLDivElement>(null)
  // Paging replaces a bounded group of rows. Explicit navigation avoids scroll
  // jumps when expanded source excerpts have variable heights.
  const page = pages.pages.at(-1)
  const [pageNumber, setPageNumber] = useState(0)
  const current = pages.pages.find(p => p.number === pageNumber) ?? page
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0 }, [current?.number])
  return <>
    {pages.changed && <button type="button" onClick={() => { setPageNumber(0); onRefresh(); void pages.refresh() }} disabled={!ready}
      aria-label="Refresh media" className="shrink-0 px-3 py-2 text-left text-xs text-accent">Links changed · Refresh</button>}
    <div ref={scroll} data-testid="links-scroll" role="region" aria-label="Session links, oldest first"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {current?.page.items.map(item => <LinkRow key={item.url} item={item} />)}
      {current && !current.page.items.length && <p className="px-3 py-4 text-xs text-secondary">
        {search ? 'No matching links.' : 'No web links in this session yet.'}
      </p>}
      {pages.error && <p role="alert" className="px-3 py-2 text-xs text-secondary">{pages.error} <button type="button"
        onClick={() => { setPageNumber(0); onRefresh(); void pages.refresh() }} className="text-accent">Retry</button></p>}
      {pages.status === 'loading' && <p role="status" className="px-3 py-2 text-xs text-secondary">Loading links…</p>}
      {!ready && <p role="status" className="px-3 py-2 text-xs text-secondary">Waiting for terminal recovery…</p>}
      <div className="flex justify-between gap-2 px-3 text-xs text-accent">
        {current && current.number > 0 && <button type="button" disabled={pages.status === 'loading' || !ready}
          className="min-h-[44px]" onClick={() => {
            if (pages.pages.some(p => p.number === current.number - 1)) setPageNumber(current.number - 1)
            else if (pages.canLoadEarlier) { setPageNumber(current.number - 1); void pages.loadPrevious() }
            else { setPageNumber(0); void pages.refresh() }
          }}>Earlier links</button>}
        {current?.page.nextCursor && !pages.changed && <button type="button" disabled={pages.status === 'loading' || !ready}
          className="ml-auto min-h-[44px]" onClick={() => {
            setPageNumber(current.number + 1)
            if (!pages.pages.some(p => p.number === current.number + 1)) void pages.loadNext()
          }}>Newer links</button>}
      </div>
    </div>
    <div className="flex shrink-0 justify-between border-t border-border/60 px-3 py-1.5 text-[11px] text-secondary">
      <span>This session</span><span>Oldest first</span>
    </div>
  </>
}
