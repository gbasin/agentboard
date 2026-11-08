/**
 * On-demand, capability-protected preview origins. Each output owns a separate
 * port so absolute app routes, fetch, cookies and WebSockets keep their paths.
 * Listeners bind to the configured interface and detected Tailscale interface.
 * Preview binding is independent of who owns the dashboard port.
 */
import fs from 'node:fs/promises'
import { crossOriginRejection } from '../requestOrigin'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'bun'
import { connectProxySocket, proxyHttp, proxyWebsocket, upstreamHeaders, upstreamUrl, type ProxySocket } from './liveProxy'

export type PreviewTarget = { kind: 'html'; file: string } | { kind: 'localhost'; url: string }
interface Preview {
  key: string
  secret: string
  port: number
  lastUsed: number
  servers: Server<ProxySocket>[]
  entry: string
}
interface Options {
  hostname: string
  tls?: { cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> }
  idleMs?: number
  limit?: number
}
const ASSET_TYPES = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.mp4', '.webm', '.mp3', '.wav', '.pdf', '.txt', '.csv'])

function equalSecret(actual: string, expected: string) {
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function servePreviewFile(request: Request, file: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
  try {
    const root = await fs.realpath(path.dirname(file))
    const requested = decodeURIComponent(new URL(request.url).pathname)
    const parts = requested.split('/')
    if (parts.some(part => part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return new Response('Invalid path', { status: 403 })
    const candidate = await fs.realpath(path.join(root, requested))
    if (!candidate.startsWith(root + path.sep) || !ASSET_TYPES.has(path.extname(candidate).toLowerCase())) return new Response('Not available in this preview', { status: 403 })
    const stat = await fs.stat(candidate)
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return new Response('File unavailable or too large', { status: 413 })
    return new Response(request.method === 'HEAD' ? null : Bun.file(candidate), { headers: {
      'Content-Type': Bun.file(candidate).type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    } })
  } catch { return new Response('Output file not found. It may have been moved or deleted.', { status: 404 }) }
}

export class PreviewServers {
  private previews = new Map<string, Preview>()
  private hosts: string[]
  private timer: ReturnType<typeof setInterval>
  private blockedPorts = new Set<number>()

  constructor(private options: Options) {
    this.hosts = [options.hostname]
    this.timer = setInterval(() => this.reap(), 60_000)
    this.timer.unref?.()
  }

  /** Preview scripts must never be able to mutate or attach to Agentboard. */
  isPreviewOrigin(origin: string | null): boolean {
    if (origin === 'null') return true
    try { return origin !== null && this.blockedPorts.has(Number(new URL(origin).port)) } catch { return false }
  }

  private reap() {
    for (const [key, preview] of this.previews) {
      if (preview.servers.some(server => server.pendingWebSockets > 0 || server.pendingRequests > 0)) continue
      if (Date.now() - preview.lastUsed < (this.options.idleMs ?? 30 * 60_000)) continue
      for (const server of preview.servers) server.stop(true)
      this.previews.delete(key)
      // Keep the port blocked until shutdown: an expired page may still run.
    }
  }

  addHost(hostname: string) {
    if (this.hosts.includes(hostname) || this.hosts.includes('0.0.0.0')) return
    this.hosts.push(hostname)
    // Existing listeners remain bound to their original interface. New opens
    // create listeners after the Tailscale lookup has completed.
  }

  async open(target: PreviewTarget, boardUrl: URL): Promise<string> {
    this.reap()
    if (target.kind === 'html') {
      target = { kind: 'html', file: await fs.realpath(target.file) }
      if (!/\.html?$/i.test(target.file) || !(await fs.stat(target.file)).isFile()) throw new Error('HTML output not found')
    }
    const key = JSON.stringify([target, boardUrl.hostname, this.hosts])
    let preview = this.previews.get(key)
    if (!preview) {
      if (this.previews.size >= (this.options.limit ?? 24)) throw new Error('Too many open previews. Try again after unused previews expire.')
      const upstream = target.kind === 'localhost' ? new URL(target.url) : null
      const entry = upstream ? upstream.pathname + upstream.search + upstream.hash : '/' + encodeURIComponent(path.basename((target as { file: string }).file))
      preview = { key, secret: crypto.randomUUID(), port: 0, lastUsed: Date.now(), servers: [], entry }
      const current = preview
      const fetchPreview = async (request: Request, server: Server<ProxySocket>) => {
        const url = new URL(request.url)
        const cookieName = `ab_preview_${current.port}`
        if (url.pathname === '/_agentboard/open') {
          if (!equalSecret(url.searchParams.get('token') ?? '', current.secret)) return new Response('Preview link expired', { status: 403 })
          return new Response(null, { status: 302, headers: {
            'Location': current.entry,
            'Set-Cookie': `${cookieName}=${current.secret}; HttpOnly; SameSite=Strict; Path=/${this.options.tls ? '; Secure' : ''}`,
            'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          } })
        }
        const cookie = (request.headers.get('cookie') ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? ''
        if (!equalSecret(cookie, current.secret)) return new Response('Open this output from Agentboard to access the preview.', { status: 403 })
        const rejected = crossOriginRejection(request, url.pathname, { allowedOrigins: [], servesTls: Boolean(this.options.tls) }, () => {})
        if (rejected) return await rejected
        current.lastUsed = Date.now()
        if (upstream && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const socketUrl = upstreamUrl(request, upstream)
          socketUrl.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:'
          const headers = upstreamHeaders(request.headers, upstream)
          for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) headers.delete(name)
          const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(p => p.trim()) ?? []
          let data: ProxySocket
          try { data = await connectProxySocket(socketUrl, headers, protocols, request.signal) }
          catch { return new Response('Local WebSocket unavailable', { status: 502 }) }
          const protocol = data.upstream.protocol
          if (server.upgrade(request, { data, headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined })) return
          data.upstream.close()
          return new Response('WebSocket upgrade failed', { status: 400 })
        }
        return upstream ? proxyHttp(request, upstream) : servePreviewFile(request, (target as { file: string }).file)
      }
      try {
        for (const hostname of this.hosts) {
          const server = Bun.serve<ProxySocket>({ port: current.port, hostname, ...(this.options.tls ? { tls: this.options.tls } : {}), fetch: fetchPreview, websocket: proxyWebsocket })
          current.port = server.port!
          current.servers.push(server)
        }
      } catch (error) {
        for (const server of current.servers) server.stop(true)
        throw error
      }
      this.blockedPorts.add(current.port)
      this.previews.set(key, current)
    }
    preview.lastUsed = Date.now()
    const result = new URL(boardUrl.origin)
    result.port = String(preview.port)
    result.protocol = this.options.tls ? 'https:' : 'http:'
    result.pathname = '/_agentboard/open'
    result.searchParams.set('token', preview.secret)
    return result.href
  }

  dispose() {
    clearInterval(this.timer)
    for (const preview of this.previews.values()) for (const server of preview.servers) server.stop(true)
    this.previews.clear()
  }
}
