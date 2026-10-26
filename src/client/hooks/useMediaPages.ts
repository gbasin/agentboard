/** Scroll-requested media pages. No polling; every response is fenced to its view. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaPage, MediaSummary, MediaQuery, MediaDiscovery } from '@shared/media'
import { MEDIA_PAGE_ITEMS, MEDIA_STREAM_MS } from '@shared/media'
import { readMediaResponse } from './readMediaStream'

type CachedPage = { number: number; cursor: string | null; page: MediaPage }
const MAX_PAGES = 3
const MAX_CURSORS = 128
const MAX_CURSOR_BYTES = 64 * 1024

type State = {
  pages: CachedPage[]
  status: 'idle' | 'loading' | 'streaming' | 'error'
  discovery?: MediaDiscovery
  latestSummary?: MediaSummary
  error: string | null
  /** Summary seen at first request; a page can be ahead of its WS broadcast. */
  requestedRevision: string | null
  scrollShift: number
}
const initial = (): State => ({ pages: [], status: 'idle', error: null, requestedRevision: null, scrollShift: 0 })

function validDiscovery(value: unknown): value is MediaDiscovery {
  if (!value || typeof value !== 'object') return false
  const d = value as MediaDiscovery
  if (d.status === 'pending' || d.status === 'ready') return true
  if (d.status === 'failed') return typeof d.message === 'string'
  return d.status === 'indexing' && [d.bytesRead, d.bytesTotal, d.filesDone, d.filesTotal].every(n => Number.isFinite(n) && n >= 0)
}

function validPage(value: unknown, identity: string | undefined): value is MediaPage {
  if (!value || typeof value !== 'object') return false
  const page = value as MediaPage
  return typeof page.identity === 'string' && (!identity || page.identity === identity) && typeof page.revision === 'string' &&
    Number.isSafeInteger(page.total) && page.total >= 0 &&
    (page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length <= 8192)) &&
    Array.isArray(page.items) && page.items.length <= MEDIA_PAGE_ITEMS && page.items.every(item =>
      item && ['image', 'document', 'link'].includes(item.kind) && typeof item.url === 'string')
}

export function useMediaPages(sessionId: string | undefined, summary: MediaSummary | undefined, expanded: boolean, ready: boolean, query: MediaQuery = {}) {
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
  const kind = query.kind, search = query.search
  const queryKey = JSON.stringify([kind, search])
  const queryRef = useRef(queryKey)
  queryRef.current = queryKey

  const cancel = useCallback(() => {
    serial.current++
    current.current?.controller.abort()
    current.current = null
  }, [])
  useEffect(() => {
    const hide = () => { cancel(); setVisible(false); setState(s => (s.status === 'loading' || s.status === 'streaming') ? { ...s, status: 'idle' } : s) }
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
  }, [sessionId, queryKey, cancel])

  useEffect(() => {
    const previous = stateRef.current.pages[0]?.page.identity
    if (identity && previous && identity !== previous) {
      cancel(); cursors.current.clear(); setState(initial())
    }
  }, [identity, cancel])

  useEffect(() => {
    if (expanded && ready && visible) return
    cancel()
    setState(s => (s.status === 'loading' || s.status === 'streaming') ? { ...s, status: 'idle' } : s)
  }, [expanded, ready, visible, cancel])

  const load = useCallback(async (direction: 'first' | 'next' | 'previous', retain = false) => {
    const latest = summaryRef.current
    if (!expanded || !ready || !visible || !sessionId) return
    if (current.current) cancel()
    const before = stateRef.current
    const first = before.pages[0], last = before.pages.at(-1)
    const number = direction === 'first' ? 0 : direction === 'next' ? (last?.number ?? -1) + 1 : (first?.number ?? 1) - 1
    const cursor = direction === 'first' ? null : direction === 'next' ? last?.page.nextCursor : cursors.current.get(number)
    if (direction !== 'first' && (cursor === undefined || (direction === 'next' && cursor === null))) return
    const controller = new AbortController(), token = ++serial.current
    current.current = { controller, token }
    setState(s => ({ ...s, status: 'loading', error: null, latestSummary: direction === 'first' ? undefined : s.latestSummary }))
    const timeout = setTimeout(() => controller.abort('timeout'), MEDIA_STREAM_MS + 5_000)
    try {
      const params = new URLSearchParams()
      params.set('stream', '1')
      if (cursor) params.set('cursor', cursor)
      if (kind) params.set('kind', kind)
      if (search) params.set('search', search)
      const query = params.size ? `?${params}` : ''
      const response = await fetch(`/api/session-media/${encodeURIComponent(sessionId)}/items${query}`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error(response.status === 409 ? 'Media changed. Refresh to continue.' : 'Could not load media. Try again.')
      let frozen = retain && before.pages.some(p => p.page.items.length > 0), received = false
      let discovery: MediaDiscovery | undefined
      let responseIdentity = latest?.identity ?? first?.page.identity
      const active = () => current.current?.token === token && serial.current === token &&
        queryRef.current === queryKey && !controller.signal.aborted
      await readMediaResponse(response, event => {
        if (!active()) return
        if (event.type === 'error') throw new Error(typeof event.message === 'string' ? event.message : 'Could not load media.')
        if (event.type === 'done') return
        if (event.type === 'progress') {
          const summary = event.summary
          if (!summary || summary.identity !== responseIdentity || typeof summary.revision !== 'string' || ![summary.total, summary.images, summary.documents, summary.links, summary.additions].every(n => Number.isSafeInteger(n) && n >= 0) || !validDiscovery(summary.discovery)) {
            throw new Error('Invalid discovery progress.')
          }
          discovery = summary.discovery
          setState(s => ({ ...s, discovery, latestSummary: summary }))
          return
        }
        const page = event.page
        if (!validPage(page, responseIdentity) || !validDiscovery(page.discovery)) throw new Error('Media identity changed. Refresh to continue.')
        discovery = page.discovery
        responseIdentity = page.identity
        received = true
        if (frozen) { setState(s => ({ ...s, discovery, status: 'streaming' })); return }
        if (direction !== 'first' && page.revision !== first?.page.revision) throw new Error('Media changed. Refresh to continue.')
        frozen = page.items.length > 0
        cursors.current.set(number, cursor ?? null)
        if (page.nextCursor) cursors.current.set(number + 1, page.nextCursor)
        while (cursors.current.size > MAX_CURSORS || [...cursors.current.values()].reduce((n, c) => n + (c?.length ?? 0) * 2, 0) > MAX_CURSOR_BYTES) {
          cursors.current.delete(cursors.current.keys().next().value!)
        }
        const entry = { number, cursor: cursor ?? null, page }
        setState(s => {
          // Empty discovery snapshots replace one another; a committed nonempty view freezes.
          let pages = direction === 'first' ? [entry] : direction === 'next' ? [...before.pages, entry] : [entry, ...before.pages]
          let shift = before.scrollShift
          if (direction === 'previous') shift += page.items.length
          if (pages.length > MAX_PAGES) {
            if (direction === 'next') { shift -= pages[0].page.items.length; pages = pages.slice(1) }
            else pages = pages.slice(0, MAX_PAGES)
          }
          return { ...s, pages, discovery, status: 'streaming', error: null,
            scrollShift: direction === 'first' ? 0 : shift,
            requestedRevision: direction === 'first' ? latest?.revision ?? page.revision : s.requestedRevision }
        })
      })
      if (!active()) return
      if (!received) throw new Error('Empty media response.')
      if (discovery?.status === 'failed') throw new Error(discovery.message)
      if (discovery?.status !== 'ready') throw new Error('Discovery paused. Retry to continue.')
      setState(s => ({ ...s, status: 'idle' }))
    } catch (error) {
      if (current.current?.token !== token || serial.current !== token) return
      setState(s => ({ ...s, status: 'error', error: controller.signal.aborted ? 'Media discovery timed out. Retry to continue.' : error instanceof Error ? error.message : 'Could not load media.' }))
    } finally {
      clearTimeout(timeout)
      if (current.current?.token === token) current.current = null
    }
  }, [expanded, ready, visible, sessionId, kind, search, queryKey, cancel])

  useEffect(() => {
    if (expanded && ready && visible && state.status === 'idle' && (!state.pages.length || state.discovery?.status === 'pending' || state.discovery?.status === 'indexing')) void load('first', state.pages.length > 0)
  }, [expanded, ready, visible, state.pages.length, state.status, state.discovery?.status, load])

  const pageRevision = state.pages[0]?.page.revision
  const latestSummary = state.latestSummary ?? summary
  const changed = Boolean(pageRevision && [state.latestSummary, summary].some(value => value && value.revision !== pageRevision && value.revision !== state.requestedRevision))
  const discovery = state.discovery ?? latestSummary?.discovery ?? (summary ? { status: 'ready' as const } : { status: 'pending' as const })
  return {
    ...state, visible, changed, discovery, latestSummary,
    identity: state.pages[0]?.page.identity ?? summary?.identity,
    items: state.pages.flatMap(p => p.page.items),
    hasNext: Boolean(state.pages.at(-1)?.page.nextCursor),
    hasEarlier: (state.pages[0]?.number ?? 0) > 0,
    canLoadEarlier: cursors.current.has((state.pages[0]?.number ?? 0) - 1),
    firstItem: state.pages[0]?.number ?? 0,
    loadNext: () => load('next'), loadPrevious: () => load('previous'),
    refresh: () => { cancel(); cursors.current.clear(); return load('first') },
  }
}
