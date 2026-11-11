/** Browse server folders; navigation and choosing the loaded folder are separate actions. */
import { ICON_SIZE } from './controlStyles'
import { useEffect, useRef, useState } from 'react'
import { FolderIcon, ChevronRightIcon } from './icons'
import { useDirectoryListing } from '../hooks/useDirectoryListing'
import { useFocusTrap } from './settings/useDialogFocus'

interface DirectoryBrowserProps {
  onSelect: (path: string) => void
  onCancel: () => void
  initialPath?: string
}

export function DirectoryBrowser({ onSelect, onCancel, initialPath }: DirectoryBrowserProps) {
  const [path, setPath] = useState(initialPath || '~')
  const [draft, setDraft] = useState(initialPath || '~')
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [retry, setRetry] = useState(0)
  const { listing, error, loading } = useDirectoryListing(path, query, showHidden, retry)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, onCancel)

  useEffect(() => {
    const opener = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null
    panelRef.current?.focus()
    return () => { opener?.focus?.() }
  }, [])

  const navigate = (next: string) => {
    setPath(next)
    setDraft(next)
    setQuery('')
    setRetry(n => n + 1)
    listRef.current?.scrollTo?.(0, 0)
    listRef.current?.focus()
  }
  const displayPath = listing?.path || path
  const parts = displayPath.split('/').filter(Boolean)
  const name = parts.at(-1) || '/'
  const canChoose = !!listing && !loading && draft === path

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="directory-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 sm:p-4"
      onClick={event => { if (event.target === event.currentTarget) onCancel() }}
      data-testid="directory-browser">
      <div ref={panelRef} tabIndex={-1}
        className="flex h-[100dvh] w-full flex-col border border-border bg-elevated text-primary outline-none sm:h-[min(680px,90dvh)] sm:max-w-xl">
        <div className="shrink-0 space-y-3 border-b border-border p-4">
          <div>
            <h2 id="directory-title" className="text-[16px] font-semibold text-primary">Choose folder</h2>
            <p className="mt-1 text-xs text-secondary">Folders on the Agentboard server</p>
          </div>
          <div className="flex gap-2">
            <input aria-label="Directory path" value={draft} spellCheck={false} autoCapitalize="none" autoCorrect="off"
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); navigate(draft.trim() || '~') }
              }} className="input min-w-0 flex-1 font-mono text-[16px] sm:text-sm" />
            <button type="button" className="btn min-h-[44px] sm:min-h-0" onClick={() => navigate(draft.trim() || '~')}>Go</button>
          </div>
          <nav aria-label="Folder ancestors" className="flex items-center gap-1 overflow-x-auto text-xs text-secondary">
            <button type="button" className="btn min-h-[44px] shrink-0 sm:min-h-0" onClick={() => navigate('~')}>Home</button>
            <button type="button" className="btn min-h-[44px] shrink-0 sm:min-h-0" disabled={!listing?.parent} onClick={() => listing?.parent && navigate(listing.parent)}>Up</button>
            {displayPath.startsWith('/') && <button type="button" className="shrink-0 p-2 hover:bg-hover" onClick={() => navigate('/')}>/</button>}
            {parts.map((part, index) => (
              <span key={index} className="flex shrink-0 items-center">
                {index > 0 && <ChevronRightIcon width={ICON_SIZE.pill} height={ICON_SIZE.pill} aria-hidden="true" />}
                <button type="button" className="max-w-48 truncate p-2 hover:bg-hover" title={part}
                  aria-current={index === parts.length - 1 ? 'location' : undefined}
                  onClick={() => navigate('/' + parts.slice(0, index + 1).join('/'))}>{part}</button>
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <input aria-label="Filter folders" placeholder="Filter folders…" value={query}
              onChange={event => setQuery(event.target.value)} className="input min-w-0 flex-1 text-[16px] sm:text-sm" />
            <label className="flex shrink-0 items-center gap-2 text-xs text-secondary">
              <input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />Show hidden
            </label>
          </div>
        </div>
        <div ref={listRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto p-2 outline-none" aria-busy={loading}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-testid="directory-entry"]'))
            const index = buttons.indexOf(event.target as HTMLButtonElement)
            event.preventDefault()
            buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
          }}>
          {loading ? <p role="status" className="p-3 text-sm text-secondary" data-testid="directory-loading">Loading folders…</p>
            : error ? <div role="alert" className="p-3 text-sm" data-testid="directory-error">
              <p className="text-danger">{error}</p>
              <button type="button" className="btn mt-3" onClick={() => setRetry(n => n + 1)}>Retry</button>
            </div>
            : !listing?.directories.length ? <p className="p-3 text-sm text-secondary" data-testid="directory-empty">
              {query ? 'No matching folders.' : 'No visible subfolders.'}
            </p>
            : listing.directories.map(entry => (
              <button key={entry.path} type="button" onClick={() => navigate(entry.path)}
                className="flex min-h-[44px] w-full items-center gap-3 px-3 py-2 text-left text-[14px] sm:text-sm hover:bg-hover focus-visible:bg-hover"
                data-testid="directory-entry" data-entry-name={entry.name} data-entry-path={entry.path}>
                <FolderIcon width={ICON_SIZE.key} height={ICON_SIZE.key} className="shrink-0 text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <ChevronRightIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="shrink-0 text-secondary" aria-hidden="true" />
              </button>
            ))}
          {listing?.truncated && <p className="p-3 text-xs text-secondary">Showing first 200 matches. Filter folders or enter a full path.</p>}
        </div>
        <div className="shrink-0 border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <p className="mb-3 break-all text-xs text-secondary" data-testid="directory-current-path">{displayPath}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="btn min-h-[44px] sm:min-h-0">Cancel</button>
            <button type="button" disabled={!canChoose} onClick={() => { if (canChoose) onSelect(listing.path) }}
              className="btn btn-primary min-h-[44px] sm:min-h-0 max-w-[75%] truncate" title={`Use ${displayPath}`} data-testid="directory-choose">
              {listing ? `Use “${name}”` : 'Use folder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
