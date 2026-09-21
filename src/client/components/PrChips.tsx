import { useEffect, useRef, useState } from 'react'
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

function PrChip({ pr }: { pr: SessionPullRequest }) {
  const [info, setInfo] = useState<PrInfo | undefined>(infoCache.get(pr.url))
  const [checks, setChecks] = useState<PrCheckInfo | undefined>(
    checksCache.get(pr.url)
  )
  const [hover, setHover] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Eager: state/title/author once per url.
  useEffect(() => {
    if (infoCache.has(pr.url) || infoInflight.has(pr.url)) return
    infoInflight.add(pr.url)
    fetch('/api/pr-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [pr.url] }),
    })
      .then((r) => r.json())
      .then((arr: PrInfo[]) => {
        const found = arr[0]
        if (found) infoCache.set(pr.url, found)
        if (mounted.current && found) setInfo(found)
      })
      .catch(() => {})
      .finally(() => infoInflight.delete(pr.url))
  }, [pr.url])

  // Lazy: CI detail only on hover.
  useEffect(() => {
    if (!hover || checksCache.has(pr.url) || checksInflight.has(pr.url)) return
    checksInflight.add(pr.url)
    fetch(`/api/pr-checks?url=${encodeURIComponent(pr.url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: PrCheckInfo | null) => {
        if (c) checksCache.set(pr.url, c)
        if (mounted.current && c) setChecks(c)
      })
      .catch(() => {})
      .finally(() => checksInflight.delete(pr.url))
  }, [hover, pr.url])

  const detail = checks ?? info
  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={() => {
        const r = anchorRef.current?.getBoundingClientRect()
        if (r) {
          // Anchor above the chip; clamp so the card stays in the viewport.
          setPos({
            left: Math.min(r.left, window.innerWidth - 270),
            bottom: window.innerHeight - r.top + 4,
          })
        }
        setHover(true)
      }}
      onMouseLeave={() => setHover(false)}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 rounded-full bg-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-muted hover:text-accent"
        title={`${pr.repo}#${pr.number}`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${stateColor(info)}`}
        />
        #{pr.number}
      </a>
      {hover &&
        pos &&
        createPortal(
          <div
            className="fixed z-[100] w-64 rounded-md border border-border bg-elevated p-2 text-left shadow-lg"
            style={{ left: pos.left, bottom: pos.bottom }}
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

export function PrChips({ prs }: { prs: SessionPullRequest[] }) {
  if (prs.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
      {prs.map((pr) => (
        <PrChip key={pr.url} pr={pr} />
      ))}
    </div>
  )
}
