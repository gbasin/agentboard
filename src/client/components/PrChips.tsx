import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { GitMergeIcon, GitPullRequestIcon, Pencil02Icon, XCloseIcon } from './icons'
import { ICON_SIZE, PR_STATE_MARK_SIZE } from './controlStyles'
import type { SessionPullRequest } from '../../shared/types'
import type { PrInfo } from '../../shared/prStatus'
import { cachedChecks, fetchChecks, getPrInfo, subscribePrInfo, watchPrInfo } from '../lib/prStatus'
import { formatRelativeTime } from '../utils/time'

// Pill geometry shared by PrChip anchors and the offscreen measurer spans
// below — keep these in sync or the single-row fit math drifts.
const PILL_CLASS =
  'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums'

// The glyph carries "this is a PR" so the chip number needs no '#' sigil;
// state sets the color, and merged swaps to the merge icon — the same
// iconography GitHub and the VS Code PR extension use.

function stateGlyph(info: PrInfo | undefined): {
  StateIcon: typeof GitPullRequestIcon
  cls: string
} {
  if (!info?.state)
    return { StateIcon: GitPullRequestIcon, cls: 'text-muted' }
  switch (info.state) {
    case 'OPEN':
      // Drafts keep GitHub's muted gray; the pencil badge in PrGlyph is
      // what tells a draft apart from an unfetched or errored chip.
      return {
        StateIcon: GitPullRequestIcon,
        cls: info.isDraft ? 'text-muted' : 'text-pr-open',
      }
    case 'MERGED':
      return { StateIcon: GitMergeIcon, cls: 'text-pr-merged' }
    case 'CLOSED':
      return { StateIcon: GitPullRequestIcon, cls: 'text-pr-closed' }
    default:
      return { StateIcon: GitPullRequestIcon, cls: 'text-muted' }
  }
}

function PrGlyph({ info }: { info?: PrInfo }) {
  const { StateIcon, cls } = stateGlyph(info)
  // No closed- or draft-PR glyphs exist in the icon set — corner badges
  // stand in for GitHub's octicons: × for closed, a pencil for drafts.
  // Closed wins on a closed draft (terminal state beats the draft flag).
  // Kept inside the 12px box so the fit measurer's plain icon stays the
  // same width.
  const MarkIcon =
    info?.state
      ? info.state === 'CLOSED'
        ? XCloseIcon
        : info.isDraft
          ? Pencil02Icon
          : null
      : null
  // The 12px glyph and 6px badges run a stroke heavier than the icon
  // set's 1.5 default — line icons at this size are hard to read,
  // especially on the light theme.
  if (MarkIcon)
    return (
      <span className="relative inline-flex shrink-0">
        <StateIcon
          width={ICON_SIZE.pill}
          height={ICON_SIZE.pill}
          strokeWidth={2}
          className={cls}
          aria-hidden
        />
        <MarkIcon
          width={PR_STATE_MARK_SIZE}
          height={PR_STATE_MARK_SIZE}
          strokeWidth={2.5}
          className={`absolute bottom-0 right-0 ${cls}`}
          aria-hidden
        />
      </span>
    )
  return (
    <StateIcon
      width={ICON_SIZE.pill}
      height={ICON_SIZE.pill}
      strokeWidth={2}
      className={`shrink-0 ${cls}`}
      aria-hidden
    />
  )
}

function stateLabel(info: PrInfo | undefined): string {
  if (!info || !info.state) return ''
  if (info.isDraft && info.state === 'OPEN') return 'Draft'
  return info.state.charAt(0) + info.state.slice(1).toLowerCase()
}

// Conclusions GitHub renders as neutral rather than failing.
const NEUTRAL_CONCLUSIONS = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])

function checkIcon(c: {
  status: string
  conclusion: string | null
}): { glyph: string; cls: string } {
  if (c.status === 'COMPLETED') {
    if (c.conclusion === 'SUCCESS')
      return { glyph: '✓', cls: 'text-pr-open' }
    if (c.conclusion && NEUTRAL_CONCLUSIONS.has(c.conclusion))
      return { glyph: '–', cls: 'text-muted' }
    return { glyph: '✗', cls: 'text-pr-closed' }
  }
  return { glyph: '…', cls: 'text-pr-pending' }
}

// Hover intent: the card opens only after the pointer rests on the chip,
// so skimming a row on the way to something else doesn't flash popups.
const CARD_OPEN_DELAY_MS = 250
const CARD_CLOSE_DELAY_MS = 200
// The card hugs the chip's edge with a few px of slack so the pointer
// crosses a shared hit region instead of a zero-gap boundary.
const CARD_OVERLAP_PX = 3

const VIEWPORT_MARGIN_PX = 8

interface CardPos {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

// Anchored hover-card state shared by PrChip and OverflowChip. The card
// portals to body (sortable row wrappers clip overflow and can be
// transformed), so it isn't a DOM descendant of the chip — open/close can't
// rely on pointer staying inside one subtree. Both directions get a short
// delay: open requires a brief rest so pass-through hovers don't flash,
// and close absorbs transient mouseleaves that have nothing to do with
// intent: the browser
// re-hit-tests when rows re-sort/animate/scroll out from under a stationary
// cursor, and diagonal exits pass through row background before reaching
// the card.
function useHoverCard(
  anchorRef: React.RefObject<HTMLElement | null>,
  cardWidth: number,
  // When set, the close timer fires but skips closing while this returns
  // true — OverflowChip uses it to keep its flyout alive while a nested
  // chip's detail card is open.
  isBlocked?: () => boolean
) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<CardPos | null>(null)
  // Mirror for timers, whose closures see render-time `open`, not the
  // value at fire time.
  const openRef = useRef(open)
  openRef.current = open
  // Read through a ref so callers can pass a fresh closure each render
  // without churning every useCallback that depends on it.
  const blockedRef = useRef(isBlocked)
  useEffect(() => {
    blockedRef.current = isBlocked
  })
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const cardRef = useRef<HTMLDivElement>(null)

  const cancelOpen = useCallback(() => {
    window.clearTimeout(openTimer.current)
    openTimer.current = undefined
  }, [])

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }, [])

  const openCard = useCallback(() => {
    cancelOpen()
    cancelClose()
    const r = anchorRef.current?.getBoundingClientRect()
    // No live anchor means no position — opening anyway would latch
    // open=true with pos=null, a state a later hover can't recover from
    // (scheduleOpen early-returns on open). Bail instead.
    if (!r) return
    // Anchor on whichever side of the chip has more room — near the top
    // edge the card flips below instead of clipping out of the viewport.
    // maxHeight bounds late-arriving content (CI checks load after open)
    // so the card scrolls internally rather than growing past the edge.
    const spaceAbove = r.top - VIEWPORT_MARGIN_PX
    const spaceBelow = window.innerHeight - r.bottom - VIEWPORT_MARGIN_PX
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(
        r.left,
        window.innerWidth - cardWidth - VIEWPORT_MARGIN_PX
      )
    )
    const maxHeight = (space: number) =>
      Math.max(60, space - CARD_OVERLAP_PX)
    setPos(
      spaceAbove >= spaceBelow
        ? {
            left,
            bottom: window.innerHeight - r.top + CARD_OVERLAP_PX,
            maxHeight: maxHeight(spaceAbove),
          }
        : {
            left,
            top: r.bottom + CARD_OVERLAP_PX,
            maxHeight: maxHeight(spaceBelow),
          }
    )
    setOpen(true)
  }, [anchorRef, cancelOpen, cancelClose, cardWidth])

  // Re-entering while the card is already up only needs the pending close
  // cancelled — the open delay applies to closed cards only.
  const scheduleOpen = useCallback(() => {
    cancelClose()
    if (open) return
    cancelOpen()
    openTimer.current = window.setTimeout(openCard, CARD_OPEN_DELAY_MS)
  }, [cancelClose, cancelOpen, open, openCard])

  const scheduleClose = useCallback(() => {
    // A pending open must not fire after the pointer has left.
    cancelOpen()
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      // Layout churn under a stationary cursor re-hit-tests and produces
      // mouseleaves the user never meant. Re-check live :hover at fire
      // time: still over the anchor or card means the leave was noise.
      // Restore the hover intent it killed — for a closed card that means
      // re-arming the pending open it cancelled; an open card just keeps
      // it. Goes through openCard directly rather than scheduleOpen, whose
      // `open` check may be stale at fire time.
      const overAnchor = anchorRef.current?.matches?.(':hover') === true
      const overCard = cardRef.current?.matches?.(':hover') === true
      if (overAnchor || overCard) {
        if (!openRef.current) {
          cancelOpen()
          openTimer.current = window.setTimeout(openCard, CARD_OPEN_DELAY_MS)
        }
        return
      }
      if (!blockedRef.current?.()) setOpen(false)
    }, CARD_CLOSE_DELAY_MS)
  }, [cancelOpen, cancelClose, anchorRef, openCard])

  // pos is captured on open; a scroll or resize detaches the fixed card
  // from its chip, so close rather than leave it floating. Scroll doesn't
  // bubble — capture at window to catch scrollable ancestors too. Scrolls
  // inside the card's own overflow lists are exempt or the card could
  // never be scrolled.
  useEffect(() => {
    if (!open) return
    const closeOnScroll = (e: Event) => {
      if (cardRef.current?.contains(e.target as Node)) return
      // A retained flyout hosts nested cards in their own portals —
      // scrolling inside one isn't contained by cardRef but must not
      // collapse the flyout (and that card) mid-scroll.
      if (blockedRef.current?.()) return
      setOpen(false)
    }
    const closeOnResize = () => setOpen(false)
    // Escape dismisses the card; if focus was inside it, return focus to
    // the anchor's interactive element instead of dropping to <body>.
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const hadFocus = !!cardRef.current?.contains?.(document.activeElement)
      setOpen(false)
      if (hadFocus) {
        const anchor = anchorRef.current
        const target =
          (anchor?.querySelector?.('a,button') as HTMLElement | null) ??
          anchor
        ;(target as HTMLElement | undefined)?.focus?.()
      }
    }
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnResize)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('resize', closeOnResize)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, anchorRef])

  useEffect(
    () => () => {
      cancelOpen()
      cancelClose()
    },
    [cancelOpen, cancelClose]
  )

  return {
    open,
    pos,
    openCard,
    scheduleOpen,
    scheduleClose,
    cancelClose,
    cardRef,
  }
}

// Set by OverflowChip around its flyout: chips rendered inside it call the
// provided retain function while their detail card is open, so moving from
// a spilled chip onto its card doesn't collapse the flyout out from under it.
const FlyoutRetainContext = createContext<(() => () => void) | null>(null)

function PrStatusAge({ at, stale }: { at: number; stale?: boolean }) {
  const iso = new Date(at).toJSON() ?? ''
  const [age, setAge] = useState(() => formatRelativeTime(iso))
  useEffect(() => {
    const tick = () => setAge(formatRelativeTime(iso))
    tick()
    const timer = setInterval(tick, 30_000)
    return () => clearInterval(timer)
  }, [iso])
  if (!age) return null
  return (
    <div className="mt-0.5 shrink-0 text-[11px] text-muted">
      {stale ? 'Last confirmed' : 'Checked'} {age === 'now' ? 'just now' : `${age} ago`}
    </div>
  )
}

function PrChip({
  pr,
  pillClass = PILL_CLASS,
}: {
  pr: SessionPullRequest
  pillClass?: string
}) {
  const info = useSyncExternalStore(subscribePrInfo, () => getPrInfo(pr.url))
  const checks = useSyncExternalStore(subscribePrInfo, () => cachedChecks(pr.url))
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { open, pos, scheduleOpen, scheduleClose, cancelClose, cardRef } =
    useHoverCard(anchorRef, 256)
  const retainFlyout = useContext(FlyoutRetainContext)
  // Layout effect, not a passive one: the retain must be registered in the
  // same commit that opens the card. A passive effect leaves a window where
  // the card is open but uncounted — a flyout close timer expiring in that
  // gap would drop the strip out from under a live card.
  useLayoutEffect(
    () => (open && retainFlyout ? retainFlyout() : undefined),
    [open, retainFlyout]
  )
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      if (document.visibilityState !== 'hidden') await fetchChecks(pr.url).catch(() => {})
      if (!cancelled) timer = setTimeout(refresh, 60_000)
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, pr.url, info?.headSha, info?.state, info?.isDraft])

  const chipInfo = info ?? checks
  const chipState = stateLabel(chipInfo)
  const detail = checks?.state && (checks.lastConfirmedAt ?? 0) > (info?.lastConfirmedAt ?? 0)
    ? checks
    : chipInfo
  return (
    <span
      ref={anchorRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={`${pillClass} bg-elevated text-muted hover:text-accent`}
        aria-label={`${pr.repo}#${pr.number}${chipState ? ` ${chipState}` : ''}`}
      >
        <PrGlyph info={chipInfo} />
        {pr.number}
      </a>
      {open &&
        pos &&
        createPortal(
          <div
            ref={cardRef}
            data-testid="pr-hovercard"
            className="fixed z-[100] flex w-64 flex-col rounded-md border border-border bg-elevated p-2 text-left shadow-lg"
            style={{
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
            }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            // Portal events still bubble through the React tree — don't let
            // card clicks activate the session row underneath.
            onClick={(e) => e.stopPropagation()}
          >
          <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
            <PrGlyph info={detail} />
            <span className="text-muted">{stateLabel(detail) || 'PR'}</span>
            <span className="text-muted">·</span>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-muted hover:text-accent"
            >
              {pr.repo}#{pr.number}
            </a>
          </div>
          {detail ? (
            <>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block shrink-0 text-xs text-primary hover:text-accent"
              >
                {detail.title ?? '(title unavailable)'}
              </a>
              <div className="mt-0.5 shrink-0 text-[11px] text-muted">
                {detail.author ? `by ${detail.author}` : ''}
              </div>
              {detail.lastConfirmedAt !== undefined && (
                <PrStatusAge at={detail.lastConfirmedAt} stale={detail.stale} />
              )}
              {checks?.error && (
                <div className="mt-0.5 shrink-0 text-[11px] text-muted">
                  {checks.checks?.length ? 'Showing last known checks' : 'Checks unavailable'}
                </div>
              )}
              {checks?.checks && checks.checks.length > 0 && (
                <div className="mt-1.5 max-h-32 min-h-0 space-y-0.5 overflow-y-auto border-t border-border pt-1.5">
                  {checks.checks.map((c, i) => {
                    const ic = checkIcon(c)
                    const row = (
                      <>
                        <span className={ic.cls}>{ic.glyph}</span>
                        <span className="truncate text-muted group-hover:text-accent">
                          {c.name}
                        </span>
                      </>
                    )
                    return c.link ? (
                      <a
                        key={i}
                        href={c.link}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex items-center gap-1.5 text-[11px]"
                      >
                        {row}
                      </a>
                    ) : (
                      <div
                        key={i}
                        className="group flex items-center gap-1.5 text-[11px]"
                      >
                        {row}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="mt-1 shrink-0 space-y-1">
              <div className="h-3 w-3/4 animate-pulse rounded bg-border" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-border" />
            </div>
          )}
        </div>,
        document.body
      )}
    </span>
  )
}

/** Muted "+N" chip; hover (or Enter/ArrowDown for keyboard) spills the
    remaining PRs as a strip of
    real chips on a low-key tray — opaque so text can't bleed through the
    gaps between pills, recessed (bg-surface) so the elevated pills still
    read as pills. The strip
    anchors below "+N" (flipping above when there's more room, e.g. the
    footer rail), left edge aligned to the chip and clamped to the viewport;
    pills wrap internally so a right-edge anchor shifts the cluster left
    instead of clipping it. */
function OverflowChip({
  prs,
  pillClass = PILL_CLASS,
}: {
  prs: SessionPullRequest[]
  pillClass?: string
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Enter/ArrowDown on "+N" opens the strip and moves focus to its first
  // chip — deferred until the portal has mounted so the target exists.
  const focusFirstOnOpen = useRef(false)
  // Chips inside the strip retain it while their detail card is open:
  // moving onto that card crosses the strip boundary, which would
  // otherwise unmount the very card being hovered.
  const nestedRef = useRef(0)
  const {
    open,
    pos,
    openCard,
    scheduleOpen,
    scheduleClose,
    cancelClose,
    cardRef,
  } = useHoverCard(anchorRef, 288, () => nestedRef.current > 0)

  useEffect(() => {
    if (open && focusFirstOnOpen.current) {
      focusFirstOnOpen.current = false
      cardRef.current?.querySelector?.('a')?.focus()
    }
  }, [open, cardRef])
  const retainNested = useCallback(() => {
    nestedRef.current += 1
    return () => {
      nestedRef.current -= 1
      // If the pointer ended up outside both chip and strip when the
      // nested card closed, drop the flyout rather than leaving it pinned.
      // (Runs on flyout unmount too — no anchor means nothing to close.
      // Keyboard focus inside the strip counts the same as hover.)
      if (
        anchorRef.current &&
        !anchorRef.current.matches?.(':hover') &&
        !cardRef.current?.matches?.(':hover') &&
        !cardRef.current?.contains?.(document.activeElement)
      ) {
        scheduleClose()
      }
    }
  }, [scheduleClose, cardRef])

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`${pillClass} cursor-pointer text-muted hover:text-accent`}
        aria-label={`${prs.length} more PR${prs.length === 1 ? '' : 's'}`}
        aria-haspopup="true"
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== 'ArrowDown') return
          e.preventDefault()
          if (open) {
            cardRef.current?.querySelector?.('a')?.focus()
          } else {
            focusFirstOnOpen.current = true
            openCard()
          }
        }}
        onClick={(e) => e.stopPropagation()}
      >
        +{prs.length}
      </button>
      {open &&
        pos &&
        createPortal(
          <FlyoutRetainContext.Provider value={retainNested}>
            <div
              ref={cardRef}
              data-testid="pr-flyout"
              className="fixed z-[100] flex max-w-72 flex-wrap items-center gap-1 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lg"
              style={{
                left: pos.left,
                top: pos.top,
                bottom: pos.bottom,
                maxHeight: pos.maxHeight,
              }}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
              // React focus/blur bubble like focusin/focusout, so these
              // cover every chip inside the strip: focus arriving cancels
              // the +N blur-close, leaving schedules one.
              onFocus={cancelClose}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  scheduleClose()
                }
              }}
              onKeyDown={(e) => {
                // Shift+Tab on the first chip returns focus to "+N" (the
                // portal's tab order isn't adjacent to its anchor).
                if (e.key !== 'Tab' || !e.shiftKey) return
                const first = cardRef.current?.querySelector?.('a')
                if (e.target === first) {
                  e.preventDefault()
                  buttonRef.current?.focus()
                }
              }}
              // Portal events still bubble through the React tree — don't
              // let strip clicks activate the session row underneath.
              onClick={(e) => e.stopPropagation()}
            >
              {prs.map((pr) => (
                <PrChip
                  key={pr.url}
                  pr={pr}
                  pillClass={pillClass}
                />
              ))}
            </div>
          </FlyoutRetainContext.Provider>,
          document.body
        )}
    </span>
  )
}

// Single-row layout: the row never wraps. An offscreen measurer renders one
// pill per PR (plus "+" and "+0" probes so the "+N" chip's width is exact for
// any digit count); a fit pass then shows as many chips as the row's current
// width allows and collapses the rest into OverflowChip. The measurer is
// absolute + invisible — measurable but out of flow — and clipped by the
// container's overflow-hidden.
export function PrChips({
  prs,
  className = 'pl-[1.375rem]',
  pillClass = PILL_CLASS,
}: {
  prs: SessionPullRequest[]
  className?: string
  /** Pill geometry for chips and the offscreen measurer — keep in sync or the fit math drifts. */
  pillClass?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chipEls = useRef<(HTMLSpanElement | null)[]>([])
  const plusRef = useRef<HTMLSpanElement>(null)
  const plusDigitRef = useRef<HTMLSpanElement>(null)
  // Extraction order is chronological by creation; show newest first.
  const ordered = useMemo(() => [...prs].reverse(), [prs])
  const [visibleCount, setVisibleCount] = useState(ordered.length)
  useEffect(() => watchPrInfo(ordered.map(pr => pr.url)), [ordered])

  const recompute = useCallback(() => {
    const n = ordered.length
    const el = containerRef.current
    // Non-DOM environments (react-test-renderer) can't measure; show all.
    if (!el || typeof el.clientWidth !== 'number' || el.clientWidth === 0) {
      setVisibleCount(n)
      return
    }
    const style = getComputedStyle(el)
    const avail =
      el.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0)
    const gap = parseFloat(style.columnGap) || 0
    // "+N" width = the "+" run (padding included) + one tabular digit per
    // digit of N. tabular-nums makes all digits the same width.
    const plusW = plusRef.current?.offsetWidth ?? 0
    const digitW = Math.max(
      0,
      (plusDigitRef.current?.offsetWidth ?? plusW) - plusW
    )
    const overW = (m: number) => plusW + String(m).length * digitW
    let used = 0
    let k = 0
    for (let i = 0; i < n; i++) {
      const w = chipEls.current[i]?.offsetWidth ?? 0
      const remaining = n - i - 1
      const tail = remaining > 0 ? gap + overW(remaining) : 0
      const need = (k > 0 ? gap : 0) + w + tail
      if (used + need > avail) break
      used += need - tail
      k++
    }
    setVisibleCount(k)
  }, [ordered])

  // Runs pre-paint so chips never flash a wrapped row on mount or when the
  // PR list changes.
  useLayoutEffect(() => {
    recompute()
  }, [recompute])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', recompute)
      return () => window.removeEventListener('resize', recompute)
    }
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [recompute])

  // Pill widths can shift once webfonts finish loading.
  useEffect(() => {
    document.fonts?.ready.then(recompute).catch(() => {})
  }, [recompute])

  if (ordered.length === 0) return null
  const visible = ordered.slice(0, visibleCount)
  const overflow = ordered.slice(visibleCount)
  return (
    <div
      ref={containerRef}
      className={`relative flex flex-nowrap items-center gap-1 overflow-hidden ${className}`}
    >
      {visible.map((pr) => (
        <PrChip key={pr.url} pr={pr} pillClass={pillClass} />
      ))}
      {overflow.length > 0 && (
        <OverflowChip
          prs={overflow}
          pillClass={pillClass}
        />
      )}
      <span
        aria-hidden
        className="invisible absolute left-0 top-0 flex flex-nowrap"
      >
        {ordered.map((pr, i) => (
          <span
            key={pr.url}
            ref={(el) => {
              chipEls.current[i] = el
            }}
            className={pillClass}
          >
            <PrGlyph />
            {pr.number}
          </span>
        ))}
        <span ref={plusRef} className={pillClass}>
          +
        </span>
        <span ref={plusDigitRef} className={pillClass}>
          +0
        </span>
      </span>
    </div>
  )
}
