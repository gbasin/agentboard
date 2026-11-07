/** Bounded response frames; ordinary fetch works on HTTP Safari without secure-context APIs. */
import { MEDIA_PAGE_BYTES, MEDIA_STREAM_BYTES } from '@shared/media'
import type { MediaStreamEvent } from '@shared/media'

export async function readMediaResponse(response: Response, receive: (event: MediaStreamEvent) => void) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty media response.')
  const streamed = response.headers.get('content-type')?.includes('application/x-ndjson')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0, frameBytes = 0, frame = '', doneFrame = false
  const deliver = (text: string) => {
    if (!text.trim()) return
    if (doneFrame) throw new Error('Unexpected data after media completion.')
    const event = JSON.parse(text) as MediaStreamEvent
    if (!event || !['snapshot', 'progress', 'error', 'done'].includes(event.type)) throw new Error('Invalid media response.')
    receive(event)
    if (event.type === 'done') doneFrame = true
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > (streamed ? MEDIA_STREAM_BYTES : MEDIA_PAGE_BYTES)) throw new Error('Media response exceeded its size limit.')
      let start = 0
      for (let i = 0; i < value.length; i++) {
        if (!streamed || value[i] !== 10) continue
        frameBytes += i - start
        if (frameBytes > MEDIA_PAGE_BYTES) throw new Error('Media frame exceeded its size limit.')
        frame += decoder.decode(value.subarray(start, i), { stream: true }) + decoder.decode()
        deliver(frame)
        frame = ''; frameBytes = 0; start = i + 1
      }
      frameBytes += value.length - start
      if (frameBytes > MEDIA_PAGE_BYTES) throw new Error('Media frame exceeded its size limit.')
      frame += decoder.decode(value.subarray(start), { stream: true })
    }
    frame += decoder.decode()
    if (streamed) {
      if (frame.trim()) deliver(frame)
      if (!doneFrame) throw new Error('Media discovery was interrupted. Retry to continue.')
    } else {
      const page = JSON.parse(frame)
      receive({ type: 'snapshot', page: { ...page, discovery: page.discovery ?? { status: 'ready' } } })
      receive({ type: 'done' })
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
