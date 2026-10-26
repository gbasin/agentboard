/** Pull-driven finite NDJSON: one queued frame, abortable discovery, bounded output. */
import { MEDIA_PAGE_BYTES, MEDIA_STREAM_BYTES, MEDIA_STREAM_MS, type MediaStreamEvent } from '../shared/media'

interface Options {
  watch(signal: AbortSignal): AsyncIterable<MediaStreamEvent>
  isCurrent(): boolean
  signal: AbortSignal
  /** Injectable lower bounds keep deadline/backpressure regression tests fast. */
  lifetimeMs?: number
  byteLimit?: number
}

const encoder = new TextEncoder()
const doneFrame = encoder.encode('{"type":"done"}\n')
const TERMINAL_RESERVE = 256

function safeError(error: unknown): Extract<MediaStreamEvent, { type: 'error' }> {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'STALE_CURSOR') return { type: 'error', code, message: 'Media changed. Refresh to continue.' }
  if (code === 'INVALID_CURSOR') return { type: 'error', code, message: 'Invalid media cursor. Refresh to continue.' }
  return { type: 'error', message: 'Media discovery is temporarily unavailable. Retry to continue.' }
}

export function mediaStreamResponse(options: Options): Response {
  const cancellation = new AbortController()
  const byteLimit = Math.max(TERMINAL_RESERVE, Math.min(options.byteLimit ?? MEDIA_STREAM_BYTES, MEDIA_STREAM_BYTES))
  let iterator: AsyncIterator<MediaStreamEvent> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false, sentBytes = 0
  // Wakes a pending iterator.next race even when a misbehaving producer ignores abort.
  let wakeAbort!: () => void
  const aborted = new Promise<null>(resolve => { wakeAbort = () => resolve(null) })
  const cleanup = () => {
    if (timer) clearTimeout(timer)
    options.signal.removeEventListener('abort', onRequestAbort)
    cancellation.abort()
    wakeAbort()
    // Async generators can defer return until a pending next settles. Never make
    // response completion wait for an uncooperative producer's cleanup.
    try { void iterator?.return?.().catch(() => {}) } catch { /* Already disposed. */ }
  }
  const finish = (error?: Extract<MediaStreamEvent, { type: 'error' }>) => {
    if (stopped) return
    stopped = true
    if (error) {
      const frame = encoder.encode(JSON.stringify(error) + '\n')
      if (sentBytes + frame.byteLength + doneFrame.byteLength <= byteLimit) {
        controller.enqueue(frame)
        sentBytes += frame.byteLength
      }
    }
    controller.enqueue(doneFrame)
    controller.close()
    cleanup()
  }
  const onRequestAbort = () => {
    if (stopped) return
    stopped = true
    controller.close()
    cleanup()
  }
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      if (options.signal.aborted) { onRequestAbort(); return }
      options.signal.addEventListener('abort', onRequestAbort, { once: true })
      timer = setTimeout(() => finish({ type: 'error', message: 'Media discovery timed out. Retry to continue.' }),
        Math.min(options.lifetimeMs ?? MEDIA_STREAM_MS, MEDIA_STREAM_MS))
      timer.unref?.()
    },
    async pull() {
      if (stopped) return
      try {
        iterator ??= options.watch(cancellation.signal)[Symbol.asyncIterator]()
        const next = await Promise.race([iterator.next(), aborted])
        if (stopped || !next) return
        if (!options.isCurrent()) { finish(safeError({ code: 'STALE_CURSOR' })); return }
        if (next.done || next.value.type === 'done') { finish(); return }
        const event = next.value.type === 'error' ? safeError(next.value) : next.value
        const frame = encoder.encode(JSON.stringify(event) + '\n')
        if (frame.byteLength - 1 > MEDIA_PAGE_BYTES) {
          finish({ type: 'error', message: 'Media response exceeded its size limit. Retry to continue.' })
          return
        }
        if (sentBytes + frame.byteLength + TERMINAL_RESERVE > byteLimit) { finish(); return }
        controller.enqueue(frame)
        sentBytes += frame.byteLength
        if (event.type === 'error') finish()
      } catch (error) {
        if (!stopped) finish(safeError(error))
      }
    },
    cancel() {
      if (stopped) return
      stopped = true
      cleanup()
    },
  }, { highWaterMark: 1 })
  return new Response(body, { headers: {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  } })
}
