/** Viewport-sized image browsing loads only the selected original while the viewer is active. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionMedia } from '@shared/types'
import './MediaLightbox.css'
import { fetchMediaThumbnail } from '../hooks/useMediaThumbnail'
import { ChevronRightIcon, Image01Icon, XCloseIcon } from './icons'
import { ICON_SIZE } from './controlStyles'
import { useFocusTrap, useSuspendTerminalInput } from './settings/useDialogFocus'
import { getFocusable, nextTrapTarget } from './settings/focusTrap'

export interface MediaLightboxProps {
  media: SessionMedia
  previewSrc?: string
  enabled: boolean
  onClose(): void
  onPrevious(): void
  onNext(): void
  canPrevious: boolean
  canNext: boolean
  navigating: boolean
  navigationError?: string | null
  onRetryNavigation?(): void
  label?: string
}
const buttonClass = 'flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-md px-3 text-sm text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-35'
const isLocal = (media: SessionMedia) => media.url.startsWith('/api/session-media/')

export default function MediaLightbox(props: MediaLightboxProps) {
  const { media, enabled, onClose, canPrevious, canNext, navigating, navigationError, onRetryNavigation, label } = props
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const current = useRef(props)
  current.current = props
  useSuspendTerminalInput({ restoreFocus: 'opener' })
  useFocusTrap(panel, onClose)
  useEffect(() => { close.current?.focus() }, [])
  const navigate = (direction: 'previous' | 'next') => {
    const view = current.current
    if (!view.enabled || view.navigating || !(direction === 'previous' ? view.canPrevious : view.canNext)) return
    // The activating button becomes disabled while loading. Move focus first so
    // the browser cannot drop it onto body and expose app/terminal shortcuts.
    panel.current?.focus()
    if (direction === 'previous') view.onPrevious()
    else view.onNext()
  }
  const previousNavigating = useRef(navigating)
  useLayoutEffect(() => {
    // Initial loading must not steal focus before the suspension hook records
    // the opener. Activation already focuses the panel before changing state.
    const started = navigating && !previousNavigating.current
    previousNavigating.current = navigating
    if (started && panel.current && !panel.current.contains(document.activeElement)) panel.current.focus()
  }, [navigating])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); current.current.onClose()
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation()
        navigate(event.key === 'ArrowLeft' ? 'previous' : 'next')
      } else if (panel.current && (!event.target || typeof (event.target as Node).nodeType !== 'number' ||
          !panel.current.contains(event.target as Node))) {
        // Body can receive keys without a focusin event when an element is
        // disabled or removed. Fence that gap before app-level listeners run.
        event.preventDefault(); event.stopImmediatePropagation()
        if (event.key === 'Tab') {
          const target = nextTrapTarget(getFocusable(panel.current), null, event.shiftKey)
          if (target) target.focus()
          else panel.current.focus()
        } else panel.current.focus()
      }
    }
    window.addEventListener('keydown', handle, true)
    return () => window.removeEventListener('keydown', handle, true)
  }, [])

  const dialog = <div className="media-lightbox-backdrop fixed inset-0 z-[80] flex items-center justify-center bg-black/80"
    onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose() }}
    onPointerDown={event => event.stopPropagation()}>
    <div ref={panel} data-testid="media-lightbox" role="dialog" aria-modal="true" aria-label="Media preview"
      data-suspends-terminal="" tabIndex={-1}
      onKeyDown={event => {
        // The portal remains a React child of the terminal. Do not bubble typing,
        // shortcuts, or activation keys into its handlers or the app shortcuts.
        event.stopPropagation()
        if (event.key === 'Tab' && panel.current) {
          const target = nextTrapTarget(getFocusable(panel.current), document.activeElement as HTMLElement | null, event.shiftKey)
          if (target) { event.preventDefault(); target.focus() }
        }
      }}
      className="media-lightbox-panel flex flex-col overflow-hidden border border-white/15 bg-neutral-950 text-white shadow-2xl outline-none">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <span className="min-w-0 flex-1 truncate text-sm" title={media.label}>{media.label || 'Image'}</span>
        {label && <span className="shrink-0 text-xs text-white/60">{label}</span>}
        <button ref={close} type="button" className={buttonClass} aria-label="Close image viewer" onClick={onClose}>
          <XCloseIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} aria-hidden="true" />
        </button>
      </header>
      <ImageView key={media.url} media={media} previewSrc={props.previewSrc} enabled={enabled} />
      {!enabled && <p role="status" className="px-4 py-2 text-center text-sm text-white/70">Waiting for terminal recovery…</p>}
      {navigationError && <div role="alert" className="px-4 py-2 text-center text-sm text-white/70">
        {navigationError}{' '}{onRetryNavigation && <button type="button" className="min-h-[44px] text-accent underline"
          disabled={!enabled || navigating} onClick={onRetryNavigation}>Retry navigation</button>}
      </div>}
      <nav aria-label="Image navigation" className="flex shrink-0 items-center justify-between gap-2 border-t border-white/10 p-2">
        <button type="button" className={buttonClass} aria-label="Previous image" onClick={() => navigate('previous')}
          disabled={!enabled || navigating || !canPrevious}>
          <ChevronRightIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} className="rotate-180" aria-hidden="true" />Previous
        </button>
        <span role="status" className="text-xs text-white/60">{navigating ? 'Loading images…' : ''}</span>
        <button type="button" className={buttonClass} aria-label="Next image" onClick={() => navigate('next')}
          disabled={!enabled || navigating || !canNext}>Next<ChevronRightIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} aria-hidden="true" /></button>
      </nav>
    </div>
  </div>
  return typeof document !== 'undefined' && document.body?.nodeType === 1 ? createPortal(dialog, document.body) : dialog
}

type Preview = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; src: string }
function ImageView({ media, previewSrc, enabled }: Pick<MediaLightboxProps, 'media' | 'previewSrc' | 'enabled'>) {
  const [preview, setPreview] = useState<Preview>(previewSrc ? { status: 'ready', src: previewSrc } : { status: 'idle' })
  const [full, setFull] = useState<'idle' | 'loading' | 'ready' | 'error'>(enabled ? 'loading' : 'idle')
  const previewRef = useRef(preview)
  previewRef.current = preview
  const owned = useRef<string | null>(null)
  const source = useRef(previewSrc)
  const generation = useRef(0)
  const visible = useRef(enabled)
  if (visible.current !== enabled) { generation.current++; visible.current = enabled }

  useEffect(() => () => { if (owned.current) URL.revokeObjectURL(owned.current) }, [])
  useEffect(() => {
    setFull(enabled ? 'loading' : 'idle')
  }, [enabled])
  useEffect(() => {
    if (!enabled || !isLocal(media) || owned.current || !source.current || previewRef.current.status === 'error') return
    const controller = new AbortController()
    let active = true
    const timeout = setTimeout(() => controller.abort(), 15_000)
    if (!source.current) setPreview({ status: 'loading' })
    void (async () => {
      let blob: Blob | undefined
      // Copy the tile's tiny blob; its owner may be evicted by pagination.
      if (source.current?.startsWith('blob:')) {
        try { blob = await fetchMediaThumbnail(source.current, controller.signal) } catch { /* revoked tile: request cached thumbnail */ }
      }
      if (controller.signal.aborted) return
      if (!blob) blob = await fetchMediaThumbnail(`${media.url}${media.url.includes('?') ? '&' : '?'}thumbnail=1`, controller.signal)
      if (!active || controller.signal.aborted) return
      owned.current = URL.createObjectURL(blob)
      setPreview({ status: 'ready', src: owned.current })
    })().catch(() => { if (active) setPreview({ status: 'error' }) }).finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [media.url, enabled])

  const token = generation.current
  const loadingOriginal = enabled && (full === 'loading' || full === 'ready')
  return <>
    <div data-testid="media-lightbox-stage" className="media-lightbox-stage">
      <div className="media-lightbox-canvas">
        {preview.status === 'ready' && full !== 'ready' && <img data-testid="media-lightbox-preview" src={preview.src}
          alt={`${media.label || 'Image'} preview`} className="media-lightbox-image"
          onError={() => { source.current = undefined; setPreview({ status: 'error' }) }} />}
        {loadingOriginal && <img key={token} data-testid="media-lightbox-original" src={media.url} alt={media.label || 'Image'}
          className={`media-lightbox-image ${full === 'ready' ? '' : 'invisible'}`}
          onLoad={() => { if (visible.current && generation.current === token) setFull('ready') }}
          onError={() => { if (visible.current && generation.current === token) setFull('error') }} />}
        {preview.status !== 'ready' && full !== 'ready' && <div className="col-start-1 row-start-1 flex flex-col items-center justify-center gap-2 text-sm text-white/60">
          <Image01Icon width={ICON_SIZE.primary} height={ICON_SIZE.primary} aria-hidden="true" />
          <span role="status">{full === 'loading' ? 'Loading image…' : preview.status === 'loading' ? 'Loading preview…' : 'Preview unavailable'}</span>
        </div>}
      </div>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 px-3 text-sm">
      {full === 'loading' && enabled && <span role="status" className="text-white/60">Loading full image…</span>}
      {full === 'error' && <span role="alert" className="text-white/60">Could not load the full image.</span>}
      {full === 'error' && <button type="button" className={`${buttonClass} border border-white/20`}
        disabled={!enabled} onClick={() => { generation.current++; setFull('loading') }}>
        Retry full image
      </button>}
      <a href={media.url} target="_blank" rel="noreferrer noopener" aria-disabled={!enabled} tabIndex={enabled ? 0 : -1}
        onClick={event => { if (!enabled) event.preventDefault() }}
        className={`flex min-h-[44px] items-center text-accent underline underline-offset-2 ${enabled ? '' : 'opacity-35'}`}>Open original</a>
    </div>
  </>
}
