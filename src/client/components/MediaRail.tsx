/**
 * MediaRail — floating rail over the terminal surface showing media payloads
 * (pasted/read images, documents, artifact links) the server extracted from
 * the session's JSONL log. Renders nothing when the session has no media or
 * is remote (the log lives on another host).
 *
 * Collapsed: a media pill at top-right — top placement keeps it
 * clear of the TUI's bottom input row. Expanded: a horizontal thumbnail strip.
 * Tapping a thumbnail opens a lightbox with the full image; document and link
 * items open their URL directly.
 */

import { useEffect, useRef, useState } from 'react'
import type { Session, SessionMedia } from '@shared/types'
import {
  File06Icon,
  Image01Icon,
  LinkExternal01Icon,
  XCloseIcon,
} from './icons'
import { ICON_SIZE, TOUCH_TARGET_CLASS } from './controlStyles'
// Payloads above this size render an "open" chip instead of an <img> so the
// rail never pulls a multi-MB response just for a thumbnail.
const MAX_INLINE_PREVIEW_BYTES = 12 * 1024 * 1024

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
}: {
  media: SessionMedia
  onOpen: (m: SessionMedia) => void
}) {
  const caption = mediaCaption(media)

  if (media.kind === 'link') {
    return (
      <a
        href={media.url}
        target="_blank"
        rel="noreferrer noopener"
        title={caption || media.url}
        className="flex h-14 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs text-secondary hover:border-accent/50 hover:text-primary"
      >
        <LinkExternal01Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} />
        <span className="max-w-[10rem] truncate">{media.label ?? 'Link'}</span>
      </a>
    )
  }

  const isImage = media.kind === 'image'
  const tooLarge = media.bytes != null && media.bytes > MAX_INLINE_PREVIEW_BYTES
  if (isImage && !tooLarge) {
    return (
      <button
        type="button"
        data-testid="media-thumb"
        onClick={() => onOpen(media)}
        title={caption || 'Image'}
        className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-surface hover:border-accent/50"
      >
        <img
          src={media.url}
          alt={caption || 'session image'}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </button>
    )
  }

  // Documents and oversized images open in a new tab rather than lightbox.
  return (
    <button
      type="button"
      data-testid="media-chip"
      onClick={() => window.open(media.url, '_blank', 'noopener')}
      title={caption || media.kind}
      className="flex h-14 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs text-secondary hover:border-accent/50 hover:text-primary"
    >
      {isImage ? (
        <Image01Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} />
      ) : (
        <File06Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} />
      )}
      <span className="max-w-[10rem] truncate">
        {media.label ?? (isImage ? 'Image' : 'Document')}
      </span>
      {media.bytes != null && (
        <span className="text-muted">{formatBytes(media.bytes)}</span>
      )}
    </button>
  )
}

export default function MediaRail({ session }: { session: Session }) {
  // A new transcript starts with a clean baseline and closed previews.
  const identity = JSON.stringify([
    session.id, session.agentSessionId, session.logFilePath, session.remote,
  ])
  return <SessionMediaRail key={identity} session={session} />
}

function SessionMediaRail({ session }: { session: Session }) {
  const [expanded, setExpanded] = useState(false)
  const [lightbox, setLightbox] = useState<SessionMedia | null>(null)
  const [attention, setAttention] = useState<'idle' | 'pulsing' | 'unread'>('idle')
  const seenUrls = useRef(new Set(session.media?.map((item) => item.url)))

  useEffect(() => {
    const nextUrls = new Set(session.media?.map((item) => item.url))
    const hasAddition = [...nextUrls].some((url) => !seenUrls.current.has(url))
    for (const url of nextUrls) seenUrls.current.add(url)
    if (nextUrls.size === 0) setAttention('idle')
    else if (hasAddition && !expanded && !session.remote) setAttention('pulsing')
  }, [session.media, session.remote, expanded])

  useEffect(() => {
    if (attention !== 'pulsing') return
    // Additions during this batch share its deadline instead of extending it.
    const timer = setTimeout(() => setAttention('unread'), 1600)
    return () => clearTimeout(timer)
  }, [attention])

  // Esc closes the lightbox before any other handler (stopPropagation keeps
  // it from falling through to terminal/app-level shortcuts).
  useEffect(() => {
    if (!lightbox) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setLightbox(null)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [lightbox])

  const media = session.media
  if (session.remote || !media?.length) return null

  const images = media.filter((m) => m.kind === 'image').length
  const others = media.length - images

  return (
    <>
      {expanded ? (
        <div
          data-testid="media-rail"
          className="absolute top-2 right-2 z-40 w-[min(560px,calc(100%-1.5rem))] rounded-xl border border-border bg-elevated/95 shadow-xl backdrop-blur"
        >
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-xs text-muted">
              Media · {media.length}
            </span>
            <button
              type="button"
              aria-label="Collapse media rail"
              onClick={() => setExpanded(false)}
              className="text-muted hover:text-primary"
            >
              <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
            </button>
          </div>
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-3 py-2">
            {media.map((m, i) => (
              <MediaChip key={`${m.url}:${i}`} media={m} onOpen={setLightbox} />
            ))}
          </div>
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
          aria-label={`Open media: ${media.length} ${media.length === 1 ? 'item' : 'items'}${attention !== 'idle' ? ', new media' : ''}`}
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

      {lightbox && (
        <div
          data-testid="media-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Media preview"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <figure
            className="flex max-w-[90vw] flex-col items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightbox.url}
              alt={mediaCaption(lightbox) || 'session media'}
              className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-2xl"
            />
            <figcaption className="flex items-center gap-3 text-xs text-white/80">
              <span>{mediaCaption(lightbox) || 'Image'}</span>
              {lightbox.width != null && lightbox.height != null && (
                <span>
                  {lightbox.width}×{lightbox.height}
                </span>
              )}
              <a
                href={lightbox.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent underline underline-offset-2"
              >
                Open original
              </a>
            </figcaption>
          </figure>
        </div>
      )}
    </>
  )
}
