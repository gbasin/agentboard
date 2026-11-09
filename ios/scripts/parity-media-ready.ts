/** Explicitly discover the dormant parity fixture before cached-media assertions run. */
import type { MediaPage, MediaStreamEvent } from '../../src/shared/media'

const endpoint = '/api/session-media/11111111-2222-4333-8444-555555555555/items'

export async function prepareParityMedia(baseURL = 'http://127.0.0.1:4151', timeoutMs = 65_000): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs)
  const response = await fetch(new URL(`${endpoint}?stream=1`, baseURL), { signal })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('ndjson')) throw Error('Parity media discovery stream unavailable')
  let buffer = '', bytes = 0, ready = false, done = false
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 512 * 1024) throw Error('Parity media discovery exceeded stream limit')
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      if (!line) continue
      const event = JSON.parse(line) as MediaStreamEvent
      if (event.type === 'error') throw Error(`Parity media discovery failed: ${event.message}`)
      const discovery = event.type === 'progress' ? event.summary.discovery : event.type === 'snapshot' ? event.page.discovery : undefined
      if (discovery?.status === 'failed') throw Error(`Parity media discovery failed: ${discovery.message}`)
      // Only progress establishes completion of this explicit discovery pass.
      if (event.type === 'progress') ready = discovery?.status === 'ready'
      if (event.type === 'done') done = true
    }
  }
  if (!done || !ready || buffer.trim()) throw Error('Parity media discovery ended before ready completion')
  // Streams retain visible snapshots while indexing. Read the final cached page.
  const cached = await fetch(new URL(endpoint, baseURL), { signal })
  if (!cached.ok) throw Error(`Parity media snapshot failed: HTTP ${cached.status}`)
  const page = await cached.json() as MediaPage
  const required = [['image', 'image/png'], ['document', 'text/html'], ['document', 'application/pdf'], ['link', undefined]]
  if (page.discovery?.status !== 'ready' || page.total !== 4 || page.items.length !== 4 || page.nextCursor !== null ||
      !required.every(([kind, mediaType]) => page.items.some(item => item.kind === kind && (mediaType === undefined || item.mediaType === mediaType)))) {
    throw Error(`Parity media fixture incomplete: ${JSON.stringify({ total: page.total, discovery: page.discovery, items: page.items.map(item => [item.kind, item.mediaType]) })}`)
  }
}

if (import.meta.main) {
  await prepareParityMedia()
  console.log('Parity media catalog ready: image, HTML, PDF, link')
}
