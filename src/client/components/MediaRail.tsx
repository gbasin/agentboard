/**
 * MediaRail — floating rail over the terminal surface showing media payloads
 * (pasted/read images, documents, artifact links) the server extracted from
 * the session's JSONL log. Renders nothing when the session has no media or
 * is remote (the log lives on another host).
 *
 * Collapsed: a small pill at top-right ("N media") — top placement keeps it
 * clear of the TUI's bottom input row. Expanded: a horizontal thumbnail strip.
 * Tapping a thumbnail opens a lightbox with the full image; document and link
 * items open their URL directly.
 */

import { useEffect, useState } from 'react'
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
  const [expanded, setExpanded] = useState(false)
  const [lightbox, setLightbox] = useState<SessionMedia | null>(null)

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
          onClick={() => setExpanded(true)}
          className={`absolute top-2 right-2 z-40 flex items-center gap-1.5 rounded-full border border-border bg-elevated/90 px-3 py-1.5 text-xs text-secondary shadow-lg backdrop-blur transition-colors hover:text-primary ${TOUCH_TARGET_CLASS}`}
        >
          <Image01Icon width={ICON_SIZE.pill} height={ICON_SIZE.pill} />
          <span className="tabular-nums">{images}</span>
          {others > 0 && (
            <span className="text-muted tabular-nums">+{others}</span>
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
