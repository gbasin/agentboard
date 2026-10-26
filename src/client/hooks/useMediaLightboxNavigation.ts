/** Bounded adjacent-image reads; gallery navigation does not retain or scan media pages. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionMedia } from '@shared/types'
import type { MediaNeighbors } from '@shared/media'
import { MEDIA_PAGE_BYTES } from '@shared/media'

type Selection = { media: SessionMedia; previewSrc?: string }
type Lookup = { anchor: string; status: 'loading' | 'error'; error?: string } |
  { anchor: string; status: 'ready'; value: MediaNeighbors }

export function useMediaLightboxNavigation(sessionId: string | undefined, identity: string | undefined, enabled: boolean) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [retry, setRetry] = useState(0)
  const selectedRef = useRef(selection)
  selectedRef.current = selection
  const localSelection = Boolean(selection?.media.url.startsWith('/api/session-media/'))
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const abort = useCallback(() => { generation.current++; request.current?.abort(); request.current = null }, [])
  const close = useCallback(() => { abort(); selectedRef.current = null; setSelection(null); setLookup(null) }, [abort])
  const open = useCallback((media: SessionMedia, previewSrc?: string) => {
    abort()
    const next = { media, previewSrc }
    selectedRef.current = next
    setSelection(next)
    setLookup(null)
  }, [abort])

  useEffect(() => { close() }, [sessionId, identity, close])
  useEffect(() => {
    if (!selection || !localSelection || !enabled || !sessionId || !identity) return
    const controller = new AbortController(), token = ++generation.current
    const anchor = selection.media.url
    request.current = controller
    setLookup({ anchor, status: 'loading' })
    const timeout = setTimeout(() => controller.abort(), 15_000)
    void (async () => {
      try {
        const response = await fetch(`/api/session-media/${encodeURIComponent(sessionId)}/neighbors?anchor=${encodeURIComponent(anchor)}`, {
          signal: controller.signal, cache: 'no-store',
        })
        if (!response.ok) throw new Error(response.status === 409 ? 'Media changed. Close this image and refresh Media.' : 'Could not load image navigation.')
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Empty navigation response.')
        const chunks: string[] = [], decoder = new TextDecoder()
        let bytes = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > MEDIA_PAGE_BYTES) throw new Error('Navigation response exceeded its size limit.')
            chunks.push(decoder.decode(value, { stream: true }))
          }
          chunks.push(decoder.decode())
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        const value: MediaNeighbors = JSON.parse(chunks.join(''))
        const image = (item: SessionMedia | null) => item === null || (item && item.kind === 'image' && typeof item.url === 'string')
        if (!value || value.identity !== identity || typeof value.revision !== 'string' || value.current?.url !== anchor ||
          !image(value.current) || !image(value.previous) || !image(value.next)) throw new Error('Invalid image navigation response.')
        if (generation.current === token && selectedRef.current?.media.url === anchor && !controller.signal.aborted) {
          setLookup({ anchor, status: 'ready', value })
        }
      } catch (error) {
        if (generation.current === token && selectedRef.current?.media.url === anchor) {
          setLookup({ anchor, status: 'error', error: controller.signal.aborted ? 'Image navigation timed out. Try again.' :
            error instanceof Error ? error.message : 'Could not load image navigation.' })
        }
      } finally {
        clearTimeout(timeout)
        if (request.current === controller) request.current = null
      }
    })()
    return () => { clearTimeout(timeout); abort() }
  }, [selection, localSelection, sessionId, identity, enabled, retry, abort])

  const current = lookup?.anchor === selection?.media.url ? lookup : null
  const value = current?.status === 'ready' ? current.value : null
  return {
    selection, open, close,
    navigating: enabled && localSelection && (!current || current.status === 'loading'),
    navigationError: current?.status === 'error' ? current.error : undefined,
    canPrevious: enabled && Boolean(value?.previous), canNext: enabled && Boolean(value?.next),
    previous: () => { if (enabled && value?.previous) open(value.previous) },
    next: () => { if (enabled && value?.next) open(value.next) },
    retry: () => setRetry(n => n + 1),
  }
}
