/** Scroll-requested media pages. No polling; every response is fenced to its view. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaPage, MediaSummary } from '@shared/media'
import { MEDIA_PAGE_BYTES, MEDIA_PAGE_ITEMS } from '@shared/media'

type CachedPage = { number: number; cursor: string | null; page: MediaPage }
const MAX_PAGES = 3
const MAX_CURSORS = 128
const MAX_CURSOR_BYTES = 64 * 1024

type State = {
  pages: CachedPage[]
  status: 'idle' | 'loading' | 'error'
  error: string | null
  /** Summary seen at first request; a page can be ahead of its WS broadcast. */
  requestedRevision: string | null
  scrollShift: number
}
const initial = (): State => ({ pages: [], status: 'idle', error: null, requestedRevision: null, scrollShift: 0 })

function validPage(value: unknown, identity: string): value is MediaPage {
  if (!value || typeof value !== 'object') return false
  const page = value as MediaPage
  return page.identity === identity && typeof page.revision === 'string' &&
    Number.isSafeInteger(page.total) && page.total >= 0 &&
    (page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length <= 8192)) &&
    Array.isArray(page.items) && page.items.length <= MEDIA_PAGE_ITEMS && page.items.every(item =>
      item && ['image', 'document', 'link'].includes(item.kind) && typeof item.url === 'string')
}

export function useMediaPages(sessionId: string | undefined, summary: MediaSummary | undefined, expanded: boolean, ready: boolean) {
  const [state, setState] = useState<State>(initial)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const stateRef = useRef(state)
  stateRef.current = state
  const summaryRef = useRef(summary)
  summaryRef.current = summary
  const current = useRef<{ token: number; controller: AbortController } | null>(null)
  const serial = useRef(0)
  const cursors = useRef(new Map<number, string | null>())
  const identity = summary?.identity

  const cancel = useCallback(() => {
    serial.current++
    current.current?.controller.abort()
    current.current = null
  }, [])
  useEffect(() => {
    const hide = () => { cancel(); setVisible(false); setState(s => s.status === 'loading' ? { ...s, status: 'idle' } : s) }
    const show = () => setVisible(document.visibilityState !== 'hidden')
    const change = () => document.visibilityState === 'hidden' ? hide() : show()
    document.addEventListener('visibilitychange', change)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    return () => {
      document.removeEventListener('visibilitychange', change)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
      cancel()
    }
  }, [cancel])

  useEffect(() => {
    cancel()
    cursors.current.clear()
    setState(initial())
  }, [identity, sessionId, cancel])

  useEffect(() => {
    if (expanded && ready && visible) return
    cancel()
    setState(s => s.status === 'loading' ? { ...s, status: 'idle' } : s)
  }, [expanded, ready, visible, cancel])

  const load = useCallback(async (direction: 'first' | 'next' | 'previous') => {
    const latest = summaryRef.current
    if (!expanded || !ready || !visible || !sessionId || !latest || current.current) return
    const before = stateRef.current
    const first = before.pages[0], last = before.pages.at(-1)
    const number = direction === 'first' ? 0 : direction === 'next' ? (last?.number ?? -1) + 1 : (first?.number ?? 1) - 1
    const cursor = direction === 'first' ? null : direction === 'next' ? last?.page.nextCursor : cursors.current.get(number)
    if (direction !== 'first' && (cursor === undefined || (direction === 'next' && cursor === null))) return
    const controller = new AbortController(), token = ++serial.current
    current.current = { controller, token }
    setState(s => ({ ...s, status: 'loading', error: null }))
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const response = await fetch(`/api/session-media/${encodeURIComponent(sessionId)}/items${query}`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error(response.status === 409 ? 'Media changed. Refresh to continue.' : 'Could not load media. Try again.')
      // Read bytes with a hard limit rather than trusting a Content-Length header.
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty media response.')
      const decoder = new TextDecoder(), chunks: string[] = []
      let bytes = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MEDIA_PAGE_BYTES) throw new Error('Media response exceeded its size limit.')
          chunks.push(decoder.decode(value, { stream: true }))
        }
        chunks.push(decoder.decode())
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const page: unknown = JSON.parse(chunks.join(''))
      if (!validPage(page, latest.identity)) throw new Error('Media identity changed. Refresh to continue.')
      if (current.current?.token !== token || serial.current !== token || summaryRef.current?.identity !== latest.identity) return
      if (direction !== 'first' && page.revision !== first?.page.revision) throw new Error('Media changed. Refresh to continue.')
      cursors.current.set(number, cursor ?? null)
      if (page.nextCursor) cursors.current.set(number + 1, page.nextCursor)
      while (cursors.current.size > MAX_CURSORS || [...cursors.current.values()].reduce((n, c) => n + (c?.length ?? 0) * 2, 0) > MAX_CURSOR_BYTES) {
        cursors.current.delete(cursors.current.keys().next().value!)
      }
      const entry = { number, cursor: cursor ?? null, page }
      setState(s => {
        let pages = direction === 'first' ? [entry] : direction === 'next' ? [...s.pages, entry] : [entry, ...s.pages]
        let shift = s.scrollShift
        if (direction === 'previous') shift += page.items.length
        if (pages.length > MAX_PAGES) {
          if (direction === 'next') { shift -= pages[0].page.items.length; pages = pages.slice(1) }
          else pages = pages.slice(0, MAX_PAGES)
        }
        return { pages, status: 'idle', error: null, scrollShift: direction === 'first' ? 0 : shift,
          requestedRevision: direction === 'first' ? latest.revision : s.requestedRevision }
      })
    } catch (error) {
      if (current.current?.token !== token || serial.current !== token || controller.signal.aborted) return
      setState(s => ({ ...s, status: 'error', error: error instanceof Error ? error.message : 'Could not load media.' }))
    } finally {
      if (current.current?.token === token) current.current = null
    }
  }, [expanded, ready, visible, sessionId])

  useEffect(() => {
    if (expanded && ready && visible && (summary?.total ?? 0) > 0 && !state.pages.length && state.status === 'idle') void load('first')
  }, [expanded, ready, visible, summary?.total, state.pages.length, state.status, load])

  const pageRevision = state.pages[0]?.page.revision
  const changed = Boolean(pageRevision && summary && summary.revision !== pageRevision && summary.revision !== state.requestedRevision)
  return {
    ...state, visible, changed,
    items: state.pages.flatMap(p => p.page.items),
    hasNext: Boolean(state.pages.at(-1)?.page.nextCursor),
    hasEarlier: (state.pages[0]?.number ?? 0) > 0,
    canLoadEarlier: cursors.current.has((state.pages[0]?.number ?? 0) - 1),
    firstItem: state.pages[0]?.number ?? 0,
    loadNext: () => load('next'), loadPrevious: () => load('previous'),
    refresh: () => { cancel(); cursors.current.clear(); return load('first') },
  }
}
