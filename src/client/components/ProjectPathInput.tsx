/** Recent projects and server-side path completion for the new-session field. */
import { ICON_SIZE } from './controlStyles'
import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { readDirectory, useDirectoryListing } from '../hooks/useDirectoryListing'
import { FolderIcon } from './icons'

export const ProjectPathInput = forwardRef<HTMLInputElement, {
  value: string
  onChange: (value: string) => void
  placeholder: string
  remote: boolean
  onBrowse: () => void
}>(function ProjectPathInput({ value, onChange, placeholder, remote, onBrowse }, ref) {
  const recentPaths = useSettingsStore(s => s.recentPaths)
  const [open, setOpen] = useState(false)
  const [edited, setEdited] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const choiceRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const text = value.trim()
  const completing = edited && (text.startsWith('/') || text.startsWith('~/') || text === '~')
  const slash = text.lastIndexOf('/')
  const parent = text === '~' ? '~' : text.slice(0, slash) || '/'
  const query = text === '~' ? '' : text.slice(slash + 1)
  const { listing, loading, error: listingError } = useDirectoryListing(
    open && !remote && completing ? parent : null, query, query.startsWith('.'),
  )
  const suggestions = completing
    ? listing?.directories.map(entry => entry.path) ?? []
    : recentPaths.filter(path => !edited || path.toLowerCase().includes(text.toLowerCase()))
  const visible = open && !remote

  const cancelChoice = () => {
    choiceRef.current?.abort()
    choiceRef.current = null
    setChoosing(false)
  }
  useEffect(() => () => choiceRef.current?.abort(), [])
  useEffect(() => {
    choiceRef.current?.abort()
    setChoosing(false)
    setError(null)
    setOpen(false)
  }, [remote])
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [active])

  const choose = async (path: string) => {
    cancelChoice()
    const controller = new AbortController()
    choiceRef.current = controller
    setChoosing(true)
    setError(null)
    try {
      const page = await readDirectory(path, controller.signal)
      if (controller.signal.aborted) return
      onChange(page.path)
      setOpen(false)
      setEdited(false)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to read folder')
    } finally {
      if (!controller.signal.aborted) setChoosing(false)
    }
  }

  return (
    <div onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); cancelChoice() }
    }}>
      <label htmlFor={id} className="mb-1.5 block text-xs text-secondary">Project path</label>
      <div className="flex gap-2">
        <input ref={ref} id={id} value={value} placeholder={placeholder} spellCheck={false} autoCapitalize="none" autoCorrect="off"
          role={remote ? undefined : 'combobox'} aria-autocomplete={remote ? undefined : 'list'}
          aria-expanded={remote ? undefined : visible} aria-controls={visible ? `${id}-options` : undefined}
          aria-activedescendant={visible && suggestions[active] ? `${id}-${active}` : undefined}
          onFocus={() => { setOpen(true); setEdited(false); setActive(-1) }}
          onChange={event => { cancelChoice(); onChange(event.target.value); setEdited(true); setOpen(true); setActive(-1); setError(null) }}
          onKeyDown={event => {
            if (remote) return
            if (event.key === 'Escape' && visible) {
              event.preventDefault(); event.stopPropagation(); setOpen(false); cancelChoice()
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); setOpen(true)
              setActive(index => Math.max(0, Math.min(suggestions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
            } else if (event.key === 'Enter' && visible) {
              event.preventDefault(); event.stopPropagation()
              if (suggestions[active]) void choose(suggestions[active])
              else setOpen(false)
            } else if (event.key === 'Tab' && visible && completing && suggestions[active]) {
              event.preventDefault(); event.stopPropagation(); cancelChoice()
              onChange(suggestions[active] + '/'); setActive(-1)
            }
          }} className="input min-w-0 flex-1 text-[16px] sm:text-sm" />
        {!remote && <button type="button" className="btn min-h-[44px] sm:min-h-0" onClick={() => { setOpen(false); cancelChoice(); onBrowse() }}>Browse</button>}
      </div>
      {visible && <div className="mt-2 border border-border bg-surface">
        <p className="px-3 py-2 text-xs text-secondary">{completing ? 'Matching folders' : 'Recent projects'}</p>
        <div ref={listRef} id={`${id}-options`} role="listbox" aria-label={completing ? 'Matching folders' : 'Recent projects'} className="max-h-48 overflow-y-auto">
          {suggestions.map((path, index) => <div key={path} id={`${id}-${index}`} role="option" aria-selected={active === index}
            onMouseDown={event => event.preventDefault()} onClick={() => void choose(path)}
            className={`flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover ${active === index ? 'bg-hover' : ''}`}>
            <FolderIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="shrink-0 text-secondary" aria-hidden="true" />
            <div className="min-w-0"><div className="truncate text-sm">{path.split('/').filter(Boolean).at(-1) || '/'}</div>
              <div className="truncate text-xs text-secondary" title={path}>{path}</div></div>
          </div>)}
        </div>
        <div role="status" className="px-3 pb-2 text-xs text-secondary">
          {error || listingError ? <span className="text-danger">{error || listingError}</span>
            : choosing ? 'Checking folder…' : loading ? 'Loading folders…'
              : !suggestions.length ? (completing ? 'No matching folders. Enter a full path or browse.' : 'No recent matches. Enter a path or browse.')
                : completing ? 'Enter to choose · Tab to browse into a match' : 'Choose a project or enter a path'}
          {listing?.truncated && <p>First 200 matches shown. Keep typing to narrow the list.</p>}
        </div>
      </div>}
    </div>
  )
})
