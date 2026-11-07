/** Bounded preview pages share discovery and cancellation with Media and Links. */
import type { Session, SessionMedia } from '@shared/types'
import { useMediaPages } from '../../hooks/useMediaPages'
import { BrowserIcon } from '../icons'
import { ICON_SIZE } from '../controlStyles'
import MediaDiscoveryStatus from '../MediaDiscoveryStatus'

export function PreviewList({ session, ready, onSelect }: { session: Session; ready: boolean; onSelect: (item: SessionMedia) => void }) {
  const pages = useMediaPages(session.agentSessionId, session.mediaSummary, true, ready, { kind: 'previews' })
  return <div className="min-h-0 overflow-y-auto px-3 py-2" data-testid="preview-list">
    {pages.changed && <button type="button" onClick={() => void pages.refresh()} className="min-h-[44px] text-[12px] text-accent">Previews changed · Refresh</button>}
    {pages.hasEarlier && <button type="button" disabled={!ready || pages.status === 'loading'} onClick={() => void pages.refresh()} className="min-h-[44px] text-[12px] text-accent">Back to newest previews</button>}
    {pages.items.map(item => <button key={item.url} type="button" data-testid="output-item" onClick={() => onSelect(item)}
      className="flex min-h-[44px] w-full items-center gap-2 rounded px-1 py-2 text-left text-secondary hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <BrowserIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="shrink-0" />
      <span className="min-w-0"><span className="block truncate text-[12px] text-primary">{item.label || 'Preview'}</span>
        <span className="block text-[12px] text-muted">{item.kind === 'localhost' ? 'Live app' : item.kind === 'visualization' ? 'Codex visualization' : 'HTML report'}</span></span>
    </button>)}
    {!ready && <p role="status" className="text-[12px] text-muted">Waiting for terminal recovery…</p>}
    {!pages.error && <MediaDiscoveryStatus discovery={pages.discovery} kind="previews" hasItems={pages.items.length > 0} />}
    {pages.status === 'loading' && pages.discovery.status === 'ready' && <p role="status" className="text-[12px] text-muted">Loading previews…</p>}
    {pages.pages.length > 0 && !pages.items.length && pages.discovery.status === 'ready' && <p className="py-2 text-[12px] text-secondary">No previews in this session yet.</p>}
    {pages.error && <div role="alert" className="text-[12px] text-muted">{pages.error} <button onClick={() => void pages.refresh()} className="min-h-[44px] text-accent">Retry</button></div>}
    {pages.hasNext && <button type="button" disabled={!ready || pages.status === 'loading'} onClick={() => void pages.loadNext()} className="min-h-[44px] text-[12px] text-accent">Load older previews</button>}
  </div>
}
