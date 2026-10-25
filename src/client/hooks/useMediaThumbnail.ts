/** Visible-only thumbnail requests. Originals are never a preview fallback. */
import { useEffect, useRef, useState, type RefObject } from 'react'

const MAX_THUMBNAIL_BYTES = 128 * 1024
const MAX_ACTIVE = 3
let active = 0
const waiting: { start: () => void; signal: AbortSignal }[] = []

function acquire(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(entry)
      if (index >= 0) waiting.splice(index, 1)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const entry = { signal, start: () => {
      signal.removeEventListener('abort', abort)
      active++
      resolve(() => {
        active--
        const next = waiting.shift()
        if (next) next.start()
      })
    } }
    if (signal.aborted) return abort()
    if (active < MAX_ACTIVE) entry.start()
    else if (waiting.length >= 32) reject(new Error('Thumbnail queue full'))
    else { waiting.push(entry); signal.addEventListener('abort', abort, { once: true }) }
  })
}

export async function fetchMediaThumbnail(url: string, signal: AbortSignal): Promise<Blob> {
  const release = await acquire(signal)
  try {
    const response = await fetch(url, { signal, redirect: 'error' })
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/png') {
      await response.body?.cancel()
      throw new Error('Preview unavailable')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty preview')
    let bytes = 0
    const chunks: Uint8Array<ArrayBuffer>[] = []
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_THUMBNAIL_BYTES) throw new Error('Preview too large')
        chunks.push(new Uint8Array(value))
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (!bytes) throw new Error('Empty preview')
    return new Blob(chunks, { type: 'image/png' })
  } finally { release() }
}

type Preview = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; src: string }

export function useMediaThumbnail(url: string, enabled: boolean, root: RefObject<HTMLDivElement>) {
  const target = useRef<HTMLButtonElement>(null)
  const [near, setNear] = useState(false)
  const [preview, setPreview] = useState<Preview>({ status: 'idle' })
  const previewRef = useRef(preview)
  previewRef.current = preview
  const objectUrl = useRef<string | null>(null)

  useEffect(() => {
    if (!target.current || !root.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), {
      root: root.current, rootMargin: '0px 64px',
    })
    observer.observe(target.current)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    previewRef.current = { status: 'idle' }
    setPreview(previewRef.current)
    return () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = null
    }
  }, [url])

  useEffect(() => {
    if (!enabled || !near || previewRef.current.status === 'ready' || previewRef.current.status === 'error') return
    const controller = new AbortController()
    let current = true
    const timeout = setTimeout(() => controller.abort(), 15_000)
    setPreview({ status: 'loading' })
    void fetchMediaThumbnail(`${url}${url.includes('?') ? '&' : '?'}thumbnail=1`, controller.signal).then(blob => {
      if (!current || controller.signal.aborted) return
      const src = URL.createObjectURL(blob)
      objectUrl.current = src
      setPreview({ status: 'ready', src })
    }).catch(() => {
      if (current) setPreview({ status: 'error' })
    }).finally(() => clearTimeout(timeout))
    return () => {
      current = false
      clearTimeout(timeout)
      controller.abort()
      setPreview(value => value.status === 'loading' ? { status: 'idle' } : value)
    }
  }, [url, enabled, near])

  const fail = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    setPreview({ status: 'error' })
  }
  return { target, preview, fail }
}
