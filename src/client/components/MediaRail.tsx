/**
 * MediaRail — floating rail over the terminal surface showing media payloads
 * (pasted/read images, documents, artifact links) the server extracted from
 * the session's JSONL log. Renders nothing when the session has no media or
 * is remote (the log lives on another host).
 *
 * Collapsed: a media pill at top-right — top placement keeps it
 * clear of the TUI's bottom input row. Expanded: a horizontal strip of uniformly sized media tiles.
 * Tapping an image opens a navigable lightbox; large originals load on request; document and link
 * items open their URL directly.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useMediaThumbnail } from '../hooks/useMediaThumbnail'
import MediaLightbox from './MediaLightbox'
import { useMediaLightboxNavigation } from '../hooks/useMediaLightboxNavigation'
import { useMediaPages } from '../hooks/useMediaPages'
import type { Session, SessionMedia } from '@shared/types'
import {
  File06Icon,
  Image01Icon,
  LinkExternal01Icon,
  XCloseIcon,
} from './icons'
import { ICON_SIZE, TOUCH_TARGET_CLASS } from './controlStyles'
// Full originals load only after an explicit user gesture.

// Explicit pixels avoid the app's 13px root shrinking rem-based thumbnails.
const MEDIA_TILE_CLASS = 'h-[56px] w-[56px] shrink-0 overflow-hidden rounded-md border border-border bg-surface hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent'
const MEDIA_FILE_TILE_CLASS = `${MEDIA_TILE_CLASS} flex flex-col items-center justify-center gap-[3px] p-[4px] text-center text-secondary hover:text-primary`
const MEDIA_TILE_LABEL_CLASS = 'line-clamp-2 w-full break-words text-[10px] leading-[12px]'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function mediaCaption(m: SessionMedia): string {
  return [m.label, m.mediaType, m.bytes != null ? formatBytes(m.bytes) : null]
    .filter(Boolean)
    .join(' · ')
}

function MediaChip({
  media,
  onOpen,
  previewEnabled,
  scrollRoot,
}: {
  media: SessionMedia
  onOpen: (m: SessionMedia, previewSrc?: string) => void
  previewEnabled: boolean
  scrollRoot: RefObject<HTMLDivElement>
}) {
  const caption = mediaCaption(media)

  if (media.kind === 'link') {
    return (
      <a
        href={media.url}
        target="_blank"
        rel="noreferrer noopener"
        title={[caption, media.url].filter(Boolean).join(' · ')}
        aria-label={media.label || media.url}
        className={MEDIA_FILE_TILE_CLASS}
      >
        <LinkExternal01Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="shrink-0" />
        <span className={MEDIA_TILE_LABEL_CLASS}>{media.label || 'Link'}</span>
      </a>
    )
  }

  const isImage = media.kind === 'image'
  const local = media.url.startsWith('/api/session-media/') && !media.url.startsWith('//')
  if (isImage && local) {
    return <ImageThumbnail media={media} caption={caption} enabled={previewEnabled} root={scrollRoot} onOpen={onOpen} />
  }

  // Documents and external images open only by explicit gesture.
  return (
    <button
      type="button"
      data-testid="media-chip"
      onClick={(event) => {
        if (isImage) {
          event.currentTarget.focus({ preventScroll: true })
          onOpen(media)
        } else window.open(media.url, '_blank', 'noopener')
      }}
      title={caption || media.kind}
      aria-label={caption || (isImage ? 'Image' : 'Document')}
      className={MEDIA_FILE_TILE_CLASS}
    >
      {isImage ? (
        <Image01Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="shrink-0" />
      ) : (
        <File06Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="shrink-0" />
      )}
      <span className={MEDIA_TILE_LABEL_CLASS}>
        {media.label ?? (isImage ? 'Image' : 'Document')}
      </span>
    </button>
  )
}

function ImageThumbnail({ media, caption, enabled, root, onOpen }: {
  media: SessionMedia; caption: string; enabled: boolean; root: RefObject<HTMLDivElement>; onOpen: (m: SessionMedia, previewSrc?: string) => void
}) {
  const { target, preview, fail } = useMediaThumbnail(media.url, enabled, root)
  const label = preview.status === 'error' ? 'No preview' : preview.status === 'loading' ? 'Loading…' : 'Open image'
  return (
    <button ref={target} type="button" data-testid="media-thumb" data-preview-state={preview.status}
      onClick={(event) => {
        // Safari does not focus buttons on pointer clicks; retain a concrete opener.
        event.currentTarget.focus({ preventScroll: true })
        onOpen(media, preview.status === 'ready' ? preview.src : undefined)
      }} title={caption || 'Image'}
      aria-label={`${caption || 'Image'} · ${preview.status === 'error' ? 'Preview unavailable. ' : ''}Open image`}
      aria-busy={preview.status === 'loading'} className={preview.status === 'ready' ? MEDIA_TILE_CLASS : MEDIA_FILE_TILE_CLASS}>
      {preview.status === 'ready' ? (
        <img data-testid="media-thumbnail" src={preview.src} alt={caption || 'session image'} onError={fail} className="h-full w-full object-cover" />
      ) : <>
        <Image01Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="shrink-0" />
        <span className={MEDIA_TILE_LABEL_CLASS}>{label}</span>
      </>}
    </button>
  )
}

export default function MediaRail({ session, ready = false }: { session: Session; ready?: boolean }) {
  // A new transcript starts with a clean baseline and closed previews.
  const identity = JSON.stringify([
    session.id, session.agentSessionId, session.logFilePath, session.remote, session.mediaSummary?.identity,
  ])
  return <SessionMediaRail key={identity} session={session} ready={ready} />
}

function SessionMediaRail({ session, ready }: { session: Session; ready: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [attention, setAttention] = useState<'idle' | 'pulsing' | 'unread'>('idle')
  const summary = session.mediaSummary
  const seenAdditions = useRef(summary?.additions)
  const pages = useMediaPages(session.agentSessionId, summary, expanded, ready)
  const lightbox = useMediaLightboxNavigation(session.agentSessionId, summary?.identity, pages.visible && ready)
  const scroll = useRef<HTMLDivElement>(null)
  const previousShift = useRef(0)
  const previousScroll = useRef(0)

  useEffect(() => { if (!summary?.images) lightbox.close() }, [summary?.images, lightbox.close])

  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollLeft += (pages.scrollShift - previousShift.current) * 64
    previousShift.current = pages.scrollShift
  }, [pages.scrollShift])

  useEffect(() => {
    if (!summary) return
    const before = seenAdditions.current
    seenAdditions.current = summary.additions
    if (summary.total === 0) setAttention('idle')
    else if (before !== undefined && summary.additions > before && !session.remote) setAttention(expanded ? 'unread' : 'pulsing')
  }, [summary, session.remote, expanded])

  const refresh = () => {
    if (scroll.current) scroll.current.scrollLeft = 0
    previousScroll.current = 0
    previousShift.current = 0
    lightbox.close()
    setAttention('idle')
    void pages.refresh()
  }

  useEffect(() => {
    if (attention !== 'pulsing') return
    // Additions during this batch share its deadline instead of extending it.
    const timer = setTimeout(() => setAttention('unread'), 1600)
    return () => clearTimeout(timer)
  }, [attention])

  if (session.remote || !summary || (summary.total === 0 && !summary.omittedRecords) || !session.agentSessionId) return null

  const images = summary.images
  const others = summary.total - images

  return (
    <>
      {expanded ? (
        <div
          data-testid="media-rail"
          className="absolute top-2 right-2 z-40 w-[min(560px,calc(100%-1.5rem))] rounded-xl border border-border bg-elevated/95 shadow-xl backdrop-blur"
        >
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-xs text-muted">
              Media · {summary.total}
            </span>
            <button
              type="button"
              aria-label="Collapse media rail"
              onClick={() => { lightbox.close(); setExpanded(false) }}
              className="text-muted hover:text-primary"
            >
              <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
            </button>
          </div>
          {!!summary.omittedRecords && (
            <p data-testid="media-incomplete" className="px-3 py-2 text-xs text-muted">
              Some media may be unavailable: {summary.omittedRecords} oversized transcript {summary.omittedRecords === 1 ? 'entry was' : 'entries were'} skipped.
            </p>
          )}
          {pages.changed && (
            <button type="button" onClick={refresh} disabled={!ready || pages.status === 'loading'}
              className="px-3 py-2 text-xs text-accent" aria-label="Refresh media">Media changed · Refresh</button>
          )}
          {pages.hasEarlier && (
            <button type="button" onClick={() => { if (pages.canLoadEarlier) void pages.loadPrevious(); else refresh() }}
              disabled={!ready || pages.status === 'loading'} className="px-3 py-1 text-xs text-accent">
              {pages.canLoadEarlier ? 'Earlier media' : 'Back to oldest media'}
            </button>
          )}
          <div ref={scroll} data-testid="media-scroll" tabIndex={0} role="region" aria-label="Session media, oldest first"
            onScroll={(event) => {
              const el = event.currentTarget
              const forward = el.scrollLeft > previousScroll.current
              previousScroll.current = el.scrollLeft
              if (forward && el.clientWidth > 0 && el.scrollWidth - el.clientWidth - el.scrollLeft < 128 &&
                  pages.hasNext && pages.status === 'idle' && !pages.changed) void pages.loadNext()
            }}
            className="scrollbar-none flex gap-2 overflow-x-auto px-3 py-2">
            {pages.items.map((m, i) => (
              <MediaChip key={`${m.url}:${i}`} media={m} onOpen={lightbox.open} previewEnabled={pages.visible && ready} scrollRoot={scroll} />
            ))}
          </div>
          {!ready && <p role="status" className="px-3 pb-2 text-xs text-muted">Waiting for terminal recovery…</p>}
          {pages.status === 'loading' && <p role="status" className="px-3 pb-2 text-xs text-muted">Loading media…</p>}
          {pages.error && <div role="alert" className="px-3 pb-2 text-xs text-muted">
            {pages.error} <button type="button" onClick={refresh} disabled={!ready} className="text-accent" aria-label="Refresh media">Refresh</button>
          </div>}
          {pages.hasNext && !pages.changed && !pages.error && (
            <button type="button" onClick={() => void pages.loadNext()} disabled={!ready || pages.status === 'loading'}
              className="px-3 pb-2 text-xs text-accent">Load newer media</button>
          )}

        </div>
      ) : (
        <button
          type="button"
          data-testid="media-rail-pill"
          aria-expanded={false}
          onClick={() => {
            setAttention('idle')
            setExpanded(true)
          }}
          aria-label={`Open media: ${summary.total} ${summary.total === 1 ? 'item' : 'items'}${attention !== 'idle' ? ', new media' : ''}`}
          className={`absolute top-2 right-2 z-40 flex items-center gap-1.5 rounded-full border border-border bg-elevated/90 px-3 py-1.5 text-xs text-secondary shadow-lg backdrop-blur transition-colors hover:text-primary md:min-h-[30px] md:gap-[6px] md:px-[12px] md:py-[5px] md:text-[12px] md:leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${attention === 'pulsing' ? 'media-attention' : ''} ${TOUCH_TARGET_CLASS}`}
        >
          <Image01Icon width={ICON_SIZE.pill} height={ICON_SIZE.pill} className="md:h-[16px] md:w-[16px]" />
          <span className="hidden md:inline">Media</span>
          <span className="tabular-nums">{images}</span>
          {others > 0 && (
            <span className="text-muted tabular-nums">+{others}</span>
          )}
          {attention !== 'idle' && (
            <span data-testid="media-rail-new-dot" aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
          )}
        </button>
      )}

      {lightbox.selection && (
        <MediaLightbox media={lightbox.selection.media} previewSrc={lightbox.selection.previewSrc}
          enabled={pages.visible && ready} onClose={lightbox.close}
          onPrevious={lightbox.previous} onNext={lightbox.next}
          canPrevious={lightbox.canPrevious} canNext={lightbox.canNext}
          navigating={lightbox.navigating} navigationError={lightbox.navigationError}
          onRetryNavigation={lightbox.retry} />
      )}
    </>
  )
}
