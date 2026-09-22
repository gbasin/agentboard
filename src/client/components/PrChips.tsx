import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { SessionPullRequest } from '../../shared/types'

interface PrInfo {
  url: string
  state?: string
  isDraft?: boolean
  title?: string
  author?: string
  error?: string
}

interface PrCheckInfo extends PrInfo {
  checks?: {
    name: string
    status: string
    conclusion: string | null
    link?: string
  }[]
}

// Module-level caches shared across all session rows: a session's PRs are
// fetched once per 60s (server also caches) no matter how often rows remount.
// Error results are never cached — a transient failure would otherwise pin
// the chip to its gray fallback for the life of the page (days in a PWA).
const INFO_TTL_MS = 60_000
const infoCache = new Map<string, { at: number; info: PrInfo }>()
const checksCache = new Map<string, PrCheckInfo>()
const infoInflight = new Map<string, Promise<unknown>>()
const checksInflight = new Set<string>()

function cachedInfo(url: string): PrInfo | undefined {
  const c = infoCache.get(url)
  return c && Date.now() - c.at < INFO_TTL_MS ? c.info : undefined
}

// Pill geometry shared by PrChip anchors and the offscreen measurer spans
// below — keep these in sync or the single-row fit math drifts.
const PILL_CLASS =
  'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums'
const DOT_CLASS = 'inline-block h-1.5 w-1.5 rounded-full'

function stateColor(info: PrInfo | undefined): string {
  if (!info || info.error || !info.state) return 'bg-muted'
  if (info.isDraft) return 'bg-muted'
  switch (info.state) {
    case 'OPEN':
      return 'bg-green-500'
    case 'MERGED':
      return 'bg-purple-500'
    case 'CLOSED':
      return 'bg-red-500'
    default:
      return 'bg-muted'
  }
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
      return { glyph: '✓', cls: 'text-green-500' }
    if (c.conclusion && NEUTRAL_CONCLUSIONS.has(c.conclusion))
      return { glyph: '–', cls: 'text-muted' }
    return { glyph: '✗', cls: 'text-red-500' }
  }
  return { glyph: '…', cls: 'text-yellow-500' }
}

// Shared eager fetch: fills infoCache for any urls not yet known/in-flight.
// Callers await the shared in-flight promise so a chip that mounts while a
// request is already running still receives its result — returning early
// here would leave the late chip gray forever.
async function fetchInfoBatch(urls: string[]): Promise<PrInfo[]> {
  const missing = urls.filter((u) => !cachedInfo(u) && !infoInflight.has(u))
  if (missing.length > 0) {
    const p: Promise<unknown> = fetch('/api/pr-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: missing }),
    })
      .then((r) => r.json() as Promise<PrInfo[]>)
      .then((arr) => {
        for (const info of arr) {
          if (!info.error) infoCache.set(info.url, { at: Date.now(), info })
        }
      })
      .catch(() => {
        // leave uncached; next mount/hover retries
      })
      .finally(() => {
        missing.forEach((u) => infoInflight.delete(u))
      })
    missing.forEach((u) => infoInflight.set(u, p))
  }
  await Promise.all(urls.map((u) => infoInflight.get(u)))
  return urls.map((u) => cachedInfo(u)!).filter(Boolean)
}

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
// rely on pointer staying inside one subtree. A short close delay absorbs
// transient mouseleaves that have nothing to do with intent: the browser
// re-hit-tests when rows re-sort/animate/scroll out from under a stationary
// cursor, and diagonal exits pass through row background before reaching
// the card.
function useHoverCard(
  anchorRef: React.RefObject<HTMLElement | null>,
  cardWidth: number
) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<CardPos | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const cardRef = useRef<HTMLDivElement>(null)

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(
      () => setOpen(false),
      CARD_CLOSE_DELAY_MS
    )
  }, [cancelClose])

  const openCard = useCallback(() => {
    cancelClose()
    const r = anchorRef.current?.getBoundingClientRect()
    if (r) {
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
    }
    setOpen(true)
  }, [anchorRef, cancelClose, cardWidth])

  // pos is captured on open; a scroll or resize detaches the fixed card
  // from its chip, so close rather than leave it floating. Scroll doesn't
  // bubble — capture at window to catch scrollable ancestors too. Scrolls
  // inside the card's own overflow lists are exempt or the card could
  // never be scrolled.
  useEffect(() => {
    if (!open) return
    const closeOnScroll = (e: Event) => {
      if (cardRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const closeOnResize = () => setOpen(false)
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnResize)
    return () => {
      window.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('resize', closeOnResize)
    }
  }, [open])

  useEffect(() => cancelClose, [cancelClose])

  return { open, pos, openCard, scheduleClose, cancelClose, cardRef }
}

function PrChip({
  pr,
  refreshKey,
}: {
  pr: SessionPullRequest
  refreshKey: number
}) {
  const [info, setInfo] = useState<PrInfo | undefined>(cachedInfo(pr.url))
  const [checks, setChecks] = useState<PrCheckInfo | undefined>(
    checksCache.get(pr.url)
  )
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { open, pos, openCard, scheduleClose, cancelClose, cardRef } =
    useHoverCard(anchorRef, 256)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Eager: state/title/author once per url. refreshKey re-runs this on
  // PWA resume so stale entries refresh and uncached failures retry.
  useEffect(() => {
    const c = cachedInfo(pr.url)
    if (c) {
      // Cache may have filled between render and effect via a shared
      // in-flight request — adopt it rather than fetching again.
      setInfo((prev) => prev ?? c)
      return
    }
    fetchInfoBatch([pr.url]).then((arr) => {
      const found = arr.find((i) => i.url === pr.url)
      if (mounted.current && found) setInfo(found)
    })
  }, [pr.url, refreshKey])

  // Lazy: CI detail only on hover.
  useEffect(() => {
    if (!open || checksCache.has(pr.url) || checksInflight.has(pr.url)) return
    checksInflight.add(pr.url)
    fetch(`/api/pr-checks?url=${encodeURIComponent(pr.url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: PrCheckInfo | null) => {
        if (c) checksCache.set(pr.url, c)
        if (mounted.current && c) setChecks(c)
      })
      .catch(() => {})
      .finally(() => checksInflight.delete(pr.url))
  }, [open, pr.url])

  const detail = checks ?? info
  return (
    <span
      ref={anchorRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={`${PILL_CLASS} bg-elevated text-muted hover:text-accent`}
        aria-label={`${pr.repo}#${pr.number}`}
      >
        <span className={`${DOT_CLASS} ${stateColor(detail)}`} />
        #{pr.number}
      </a>
      {open &&
        pos &&
        createPortal(
          <div
            ref={cardRef}
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
            <span className={stateColor(detail) + ' inline-block h-1.5 w-1.5 shrink-0 rounded-full'} />
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

/** Muted "+N" chip; hover opens a card listing the remaining PRs. */
function OverflowChip({ prs }: { prs: SessionPullRequest[] }) {
  const [infos, setInfos] = useState<Map<string, PrInfo> | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { open, pos, openCard, scheduleClose, cancelClose, cardRef } =
    useHoverCard(anchorRef, 224)

  // Lazy: only fetch state for hidden PRs when the card opens. Reopening
  // retries urls still missing info (failures are never cached).
  useEffect(() => {
    if (!open || (infos && prs.every((p) => infos.has(p.url)))) return
    fetchInfoBatch(prs.map((p) => p.url)).then((arr) => {
      setInfos((prev) => {
        const next = new Map(prev ?? [])
        for (const i of arr) next.set(i.url, i)
        return next
      })
    })
  }, [open, infos, prs])

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <span
        className={`${PILL_CLASS} cursor-default text-muted`}
        aria-label={`${prs.length} more PR${prs.length === 1 ? '' : 's'}`}
      >
        +{prs.length}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            ref={cardRef}
            className="fixed z-[100] flex w-56 flex-col rounded-md border border-border bg-elevated p-2 text-left shadow-lg"
            style={{
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
            }}
            // Keep the card alive while the pointer is on it so its rows
            // are actually reachable/clickable.
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 text-[11px] text-muted">
              {prs.length} more PR{prs.length === 1 ? '' : 's'}
            </div>
            <div className="mt-1 max-h-48 min-h-0 space-y-0.5 overflow-y-auto border-t border-border pt-1.5">
              {prs.map((pr) => (
                <a
                  key={pr.url}
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-[11px] text-secondary hover:text-accent"
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${stateColor(infos?.get(pr.url))}`}
                  />
                  <span className="tabular-nums">#{pr.number}</span>
                  <span className="truncate text-muted">{pr.repo}</span>
                </a>
              ))}
            </div>
          </div>,
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
export function PrChips({ prs }: { prs: SessionPullRequest[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chipEls = useRef<(HTMLSpanElement | null)[]>([])
  const plusRef = useRef<HTMLSpanElement>(null)
  const plusDigitRef = useRef<HTMLSpanElement>(null)
  // Extraction order is chronological by creation; show newest first.
  const ordered = useMemo(() => [...prs].reverse(), [prs])
  const [visibleCount, setVisibleCount] = useState(ordered.length)
  // Bump on page-visible so mounted chips refetch stale info: PWAs resume
  // from suspension instead of reloading, so without this PR state could
  // sit gray for days after one failed launch-time fetch.
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1)
    }
    document.addEventListener?.('visibilitychange', onVisible)
    return () =>
      document.removeEventListener?.('visibilitychange', onVisible)
  }, [])

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
      className="relative flex flex-nowrap items-center gap-1 overflow-hidden pl-[1.375rem]"
    >
      {visible.map((pr) => (
        <PrChip key={pr.url} pr={pr} refreshKey={refreshKey} />
      ))}
      {overflow.length > 0 && <OverflowChip prs={overflow} />}
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
            className={PILL_CLASS}
          >
            <span className={DOT_CLASS} />
            #{pr.number}
          </span>
        ))}
        <span ref={plusRef} className={PILL_CLASS}>
          +
        </span>
        <span ref={plusDigitRef} className={PILL_CLASS}>
          +0
        </span>
      </span>
    </div>
  )
}
