/**
 * SnapshotDeckActions - the key deck row while the "Select text" snapshot
 * layer is open: Done (back to the live terminal) and Refresh (re-capture),
 * in place of the keys, so nothing floats over the selectable text.
 */

import { RefreshCcw01Icon, SpinnerIcon, XCloseIcon } from './icons'
import { ICON_SIZE } from './controlStyles'

export interface SnapshotActions {
  onDone: () => void
  onRefresh: () => void
  /** A capture is in flight: Refresh shows progress and is unavailable. */
  busy: boolean
}

const BUTTON_CLASS = 'terminal-key flex h-[44px] min-w-[96px] items-center justify-center gap-1.5 rounded-md border px-4 text-sm font-medium select-none touch-manipulation active:scale-95 transition-transform duration-75 disabled:opacity-50'

export default function SnapshotDeckActions({ onDone, onRefresh, busy }: SnapshotActions) {
  return (
    <div className="flex items-center gap-[6px]" data-testid="snapshot-deck-actions">
      <button type="button" aria-label="Done selecting text" onClick={onDone}
        onMouseDown={(e) => e.preventDefault()}
        className={`${BUTTON_CLASS} border-accent/40 bg-accent/20 text-accent`}>
        <XCloseIcon width={ICON_SIZE.key} height={ICON_SIZE.key} />
        Done
      </button>
      <button type="button" aria-label="Refresh text" onClick={onRefresh} disabled={busy} aria-busy={busy}
        onMouseDown={(e) => e.preventDefault()}
        className={`${BUTTON_CLASS} border-border bg-surface text-secondary`}>
        {busy
          ? <SpinnerIcon width={ICON_SIZE.key} height={ICON_SIZE.key} className="animate-spin" />
          : <RefreshCcw01Icon width={ICON_SIZE.key} height={ICON_SIZE.key} />}
        Refresh
      </button>
    </div>
  )
}
