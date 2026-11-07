/** Transparent HTTP/WebSocket relay. One preview origin maps to one upstream. */
import type { ServerWebSocket } from 'bun'

const HOP_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer']

export function upstreamHeaders(input: Headers, upstream: URL): Headers {
  const headers = new Headers(input)
  for (const key of HOP_HEADERS) headers.delete(key)
  // Preview capability cookies must never reach the development app.
  const cookies = (headers.get('cookie') ?? '').split(';').filter(part => !part.trim().startsWith('ab_preview_'))
  if (cookies.some(part => part.trim())) headers.set('cookie', cookies.join(';'))
  else headers.delete('cookie')
  headers.set('host', upstream.host)
  headers.set('accept-encoding', 'identity')
  if (headers.has('origin')) headers.set('origin', upstream.origin)
  headers.delete('referer')
  return headers
}

export function upstreamUrl(request: Request, upstream: URL): URL {
  const incoming = new URL(request.url)
  const target = new URL(upstream.origin)
  target.pathname = incoming.pathname
  target.search = incoming.search
  return target
}

export async function proxyHttp(request: Request, upstream: URL): Promise<Response> {
  const target = upstreamUrl(request, upstream)
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders(request.headers, upstream),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      signal: request.signal,
    })
    const headers = new Headers(response.headers)
    for (const key of HOP_HEADERS) headers.delete(key)
    headers.delete('content-encoding')
    headers.delete('content-length')
    // Keep the app's CSP. Root-relative assets, fetch and sockets work because
    // the app owns this entire origin; no HTML/JS rewriting is needed.
    const location = headers.get('location')
    if (location) {
      const redirect = new URL(location, target)
      if (redirect.origin === upstream.origin) {
        const viewer = new URL(request.url)
        redirect.host = viewer.host
        redirect.protocol = viewer.protocol
        headers.set('location', redirect.href)
      }
    }
    headers.set('referrer-policy', 'no-referrer')
    return new Response(response.body, { status: response.status, headers })
  } catch {
    return new Response('Preview unavailable. The local app may have stopped. Start it again and reload the preview.', { status: 502 })
  }
}

export interface ProxySocket {
  upstream: WebSocket
  queue: (string | Uint8Array)[]
  queuedBytes: number
}

export const proxyWebsocket = {
  maxPayloadLength: 8 * 1024 * 1024,
  open(ws: ServerWebSocket<ProxySocket>) {
    const remote = ws.data.upstream
    remote.binaryType = 'arraybuffer'
    const flush = () => {
      for (const message of ws.data.queue) remote.send(message)
      ws.data.queue = []
      ws.data.queuedBytes = 0
    }
    remote.onopen = flush
    if (remote.readyState === WebSocket.OPEN) flush()
    remote.onmessage = event => ws.send(event.data)
    remote.onclose = () => ws.close(1000, 'Local app disconnected')
    remote.onerror = () => ws.close(1011, 'Local app unavailable')
    if (remote.readyState >= WebSocket.CLOSING) ws.close(1011, 'Local app unavailable')
  },
  message(ws: ServerWebSocket<ProxySocket>, message: string | Buffer) {
    const remote = ws.data.upstream
    if (remote.readyState === WebSocket.OPEN) remote.send(message)
    else if (remote.readyState === WebSocket.CONNECTING) {
      ws.data.queuedBytes += typeof message === 'string' ? Buffer.byteLength(message) : message.length
      if (ws.data.queuedBytes > 1024 * 1024) { ws.close(1009, 'Preview queue full'); return }
      ws.data.queue.push(typeof message === 'string' ? message : new Uint8Array(message))
    }
  },
  close(ws: ServerWebSocket<ProxySocket>) { ws.data.upstream.close() },
}
