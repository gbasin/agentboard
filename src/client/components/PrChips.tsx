import { useCallback, useEffect, useRef, useState } from 'react'
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
  checks?: { name: string; status: string; conclusion: string | null }[]
}

// Module-level caches shared across all session rows: a session's PRs are
// fetched once per 60s (server also caches) no matter how often rows remount.
const infoCache = new Map<string, PrInfo>()
const checksCache = new Map<string, PrCheckInfo>()
const infoInflight = new Set<string>()
const checksInflight = new Set<string>()

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

function checkIcon(c: {
  status: string
  conclusion: string | null
}): { glyph: string; cls: string } {
  if (c.status === 'COMPLETED') {
    return c.conclusion === 'SUCCESS'
      ? { glyph: '✓', cls: 'text-green-500' }
      : { glyph: '✗', cls: 'text-red-500' }
  }
  return { glyph: '…', cls: 'text-yellow-500' }
}

// Shared eager fetch: fills infoCache for any urls not yet known/in-flight.
async function fetchInfoBatch(urls: string[]): Promise<PrInfo[]> {
  const missing = urls.filter((u) => !infoCache.has(u) && !infoInflight.has(u))
  if (missing.length === 0) return urls.map((u) => infoCache.get(u)!)
  missing.forEach((u) => infoInflight.add(u))
  try {
    const r = await fetch('/api/pr-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: missing }),
    })
    const arr = (await r.json()) as PrInfo[]
    for (const info of arr) infoCache.set(info.url, info)
  } catch {
    // leave uncached; next mount/hover retries
  } finally {
    missing.forEach((u) => infoInflight.delete(u))
  }
  return urls.map((u) => infoCache.get(u)!).filter(Boolean)
}

const CARD_CLOSE_DELAY_MS = 200
// The card's bottom edge overlaps the chip's top edge so the pointer crosses
// a shared hit region instead of a zero-gap boundary.
const CARD_OVERLAP_PX = 3

// Anchored hover-card state shared by PrChip and OverflowChip. The card
// portals to body (sortable row wrappers clip overflow and can be
// transformed), so it isn't a DOM descendant of the chip — open/close can't
// rely on pointer staying inside one subtree. A short close delay absorbs
// transient mouseleaves that have nothing to do with intent: the browser
// re-hit-tests when rows re-sort/animate/scroll out from under a stationary
// cursor, and diagonal exits pass through row background before reaching
// the card.
function useHoverCard(anchorRef: React.RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)

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
      // Anchor above the chip; clamp so the card stays in the viewport.
      setPos({
        left: Math.min(r.left, window.innerWidth - 270),
        bottom: window.innerHeight - r.top + CARD_OVERLAP_PX,
      })
    }
    setOpen(true)
  }, [anchorRef, cancelClose])

  // pos is captured on open; a scroll or resize detaches the fixed card
  // from its chip, so close rather than leave it floating. Scroll doesn't
  // bubble — capture at window to catch scrollable ancestors too.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  useEffect(() => cancelClose, [cancelClose])

  return { open, pos, openCard, scheduleClose, cancelClose }
}

function PrChip({ pr }: { pr: SessionPullRequest }) {
  const [info, setInfo] = useState<PrInfo | undefined>(infoCache.get(pr.url))
  const [checks, setChecks] = useState<PrCheckInfo | undefined>(
    checksCache.get(pr.url)
  )
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { open, pos, openCard, scheduleClose, cancelClose } =
    useHoverCard(anchorRef)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Eager: state/title/author once per url.
  useEffect(() => {
    if (infoCache.has(pr.url)) return
    fetchInfoBatch([pr.url]).then((arr) => {
      if (mounted.current && arr[0]) setInfo(arr[0])
    })
  }, [pr.url])

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
      className="relative inline-flex"
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 rounded-full bg-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-muted hover:text-accent"
        aria-label={`${pr.repo}#${pr.number}`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${stateColor(info)}`}
        />
        #{pr.number}
      </a>
      {open &&
        pos &&
        createPortal(
          <div
            className="fixed z-[100] w-64 rounded-md border border-border bg-elevated p-2 text-left shadow-lg"
            style={{ left: pos.left, bottom: pos.bottom }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className={stateColor(info) + ' inline-block h-1.5 w-1.5 rounded-full'} />
            <span className="text-muted">{stateLabel(info) || 'PR'}</span>
            <span className="text-muted">·</span>
            <span className="truncate text-muted">{pr.repo}#{pr.number}</span>
          </div>
          {detail ? (
            <>
              <div className="mt-1 text-xs text-primary">
                {detail.title ?? '(title unavailable)'}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                {detail.author ? `by ${detail.author}` : ''}
              </div>
              {checks?.checks && checks.checks.length > 0 && (
                <div className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto border-t border-border pt-1.5">
                  {checks.checks.map((c, i) => {
                    const ic = checkIcon(c)
                    return (
                      <div key={i} className="flex items-center gap-1.5 text-[11px]">
                        <span className={ic.cls}>{ic.glyph}</span>
                        <span className="truncate text-muted">{c.name}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="mt-1 space-y-1">
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

const MAX_VISIBLE = 4

/** Muted "+N" chip; hover opens a card listing the remaining PRs. */
function OverflowChip({ prs }: { prs: SessionPullRequest[] }) {
  const [infos, setInfos] = useState<Map<string, PrInfo> | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { open, pos, openCard, scheduleClose, cancelClose } =
    useHoverCard(anchorRef)

  // Lazy: only fetch state for hidden PRs when the card opens.
  useEffect(() => {
    if (!open || infos) return
    fetchInfoBatch(prs.map((p) => p.url)).then((arr) => {
      setInfos(new Map(arr.map((i) => [i.url, i])))
    })
  }, [open, infos, prs])

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <span
        className="inline-flex cursor-default items-center rounded-full px-1.5 py-0.5 text-[11px] tabular-nums text-muted"
        aria-label={`${prs.length} more PR${prs.length === 1 ? '' : 's'}`}
      >
        +{prs.length}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            className="fixed z-[100] w-56 rounded-md border border-border bg-elevated p-2 text-left shadow-lg"
            style={{ left: pos.left, bottom: pos.bottom }}
            // Keep the card alive while the pointer is on it so its rows
            // are actually reachable/clickable.
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className="text-[11px] text-muted">
              {prs.length} more PR{prs.length === 1 ? '' : 's'}
            </div>
            <div className="mt-1 max-h-48 space-y-0.5 overflow-y-auto border-t border-border pt-1.5">
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

export function PrChips({ prs }: { prs: SessionPullRequest[] }) {
  if (prs.length === 0) return null
  // Extraction order is chronological by creation; show newest first.
  const ordered = [...prs].reverse()
  const visible = ordered.slice(0, MAX_VISIBLE)
  const overflow = ordered.slice(MAX_VISIBLE)
  return (
    <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
      {visible.map((pr) => (
        <PrChip key={pr.url} pr={pr} />
      ))}
      {overflow.length > 0 && <OverflowChip prs={overflow} />}
    </div>
  )
}
