/**
 * SettingsModal - the settings dialog shell.
 *
 * Every control applies instantly (there is no Save step); rows come from
 * the registry in ./settings. Desktop: a centred fixed-height modal with a
 * page tablist and search on the left and one scrolling page on the right,
 * over a light backdrop so terminal font/theme changes stay visible. Phone
 * (below md): a full-screen surface that opens on the page list and drills
 * into a page, with a back control in the header.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { useIsMobileLayout } from '../hooks/useMobileLayout'
import { cn } from '../utils/cn'
import { ICON_SIZE } from './controlStyles'
import { ChevronRightIcon, XCloseIcon } from './icons'
import { loadLastPage, saveLastPage } from './settings/lastPage'
import { PageView, SearchResults } from './settings/SettingsPane'
import { SettingsNav, SettingsSearch, tabId } from './settings/SettingsNav'
import { getPageLabel, type SettingsPageId } from './settings/types'
import { useFocusTrap, useSuspendTerminalInput } from './settings/useDialogFocus'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  // Mount the dialog only while open so each opening starts fresh (query
  // cleared, phone back on the page list) and focus is restored on unmount.
  return isOpen ? <SettingsDialog onClose={onClose} /> : null
}

const PANEL_ID = 'settings-panel'
const HEADER_BUTTON =
  'flex shrink-0 items-center justify-center text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent'

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const isPhone = useIsMobileLayout()
  const [page, setPage] = useState<SettingsPageId | null>(() => (isPhone ? null : loadLastPage()))
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const backdropPressRef = useRef(false)
  // Phone: the page to refocus in the list after tapping back.
  const returnToRef = useRef<SettingsPageId | null>(null)

  useSuspendTerminalInput()
  useFocusTrap(panelRef, onClose)

  // Initial focus: the search box on desktop; the panel itself on phones so
  // the on-screen keyboard doesn't pop up on open.
  useEffect(() => {
    if (isPhone) panelRef.current?.focus()
    else searchRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open; a later layout change keeps focus where it is
  }, [])

  // Phone drill-in/out: keep keyboard and screen-reader focus on the screen
  // that just appeared.
  useEffect(() => {
    if (!isPhone) return
    if (page) {
      backRef.current?.focus()
    } else if (returnToRef.current) {
      const target = panelRef.current?.querySelector<HTMLElement>(`[data-page-id="${returnToRef.current}"]`)
      returnToRef.current = null
      target?.focus()
    }
  }, [isPhone, page])

  const selectPage = (next: SettingsPageId) => {
    setPage(next)
    saveLastPage(next)
    setQuery('')
  }

  const searching = query.trim().length > 0

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close settings"
      className={cn(HEADER_BUTTON, 'size-[32px] max-md:size-[44px]')}
    >
      <XCloseIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} />
    </button>
  )

  if (isPhone) {
    return (
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-suspends-terminal=""
        tabIndex={-1}
        className="fixed inset-0 z-50 flex flex-col bg-elevated outline-none"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border px-1">
          {page ? (
            <button
              ref={backRef}
              type="button"
              onClick={() => {
                returnToRef.current = page
                setPage(null)
              }}
              aria-label="Back to settings"
              className={cn(HEADER_BUTTON, 'size-[44px]')}
            >
              <ChevronRightIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="rotate-180" />
            </button>
          ) : (
            <span aria-hidden="true" className="size-[44px] shrink-0" />
          )}
          <h2 id="settings-title" className="min-w-0 flex-1 truncate text-center text-[16px] font-semibold text-primary">
            {page ? getPageLabel(page) : 'Settings'}
          </h2>
          {closeButton}
        </header>
        <div
          id={PANEL_ID}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4"
          style={{ paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}
        >
          {page ? (
            <PageView page={page} showTitle={false} />
          ) : (
            <>
              <SettingsSearch ref={searchRef} value={query} onChange={setQuery} className="py-3" />
              {searching ? (
                <SearchResults query={query} />
              ) : (
                <div className="-mx-4">
                  <SettingsNav variant="list" current={null} onSelect={selectPage} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  // Desktop. A viewport change from phone mid-session may leave page null.
  const currentPage = page ?? loadLastPage()

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    backdropPressRef.current = event.target === event.currentTarget
  }
  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    // Only a press that started and ended on the backdrop closes, so a text
    // selection dragged out of the dialog doesn't.
    if (backdropPressRef.current && event.target === event.currentTarget) onClose()
    backdropPressRef.current = false
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-suspends-terminal=""
        tabIndex={-1}
        className="flex h-[600px] max-h-full w-[760px] max-w-full flex-col border border-border bg-elevated shadow-2xl outline-none"
      >
        <header className="flex h-[48px] shrink-0 items-center justify-between border-b border-border pl-5 pr-2">
          <h2 id="settings-title" className="text-[13px] font-semibold uppercase tracking-wider text-primary">
            Settings
          </h2>
          {closeButton}
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[192px] shrink-0 flex-col gap-3 border-r border-border p-3">
            <SettingsSearch ref={searchRef} value={query} onChange={setQuery} />
            <SettingsNav
              variant="tabs"
              current={searching ? null : currentPage}
              onSelect={selectPage}
              panelId={PANEL_ID}
            />
          </div>
          <div
            id={PANEL_ID}
            role={searching ? 'region' : 'tabpanel'}
            aria-label={searching ? 'Search results' : undefined}
            aria-labelledby={searching ? undefined : tabId(currentPage)}
            className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5"
          >
            {searching ? <SearchResults query={query} /> : <PageView page={currentPage} showTitle />}
          </div>
        </div>
      </div>
    </div>
  )
}
