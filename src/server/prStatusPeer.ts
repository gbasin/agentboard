// Server-to-server protocol for sharing PR status with authenticated followers.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { canonicalPrUrl, type PrCheckInfo, type PrInfo } from './prInfo'

export const PR_STATUS_PEER_PATH = '/api/internal/pr-status'
export const PEER_BATCH_SIZE = 128
const REQUEST_BYTES = 64 * 1024
export const RESPONSE_BYTES = 2 * 1024 * 1024

interface Authority {
  register(urls: string[]): void
  read(urls: string[]): PrInfo[]
  check(url: string): Promise<PrCheckInfo>
}

export function peerPrUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256) return null
  return canonicalPrUrl(value)
}

export function recordDigest(record: PrInfo): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('base64url').slice(0, 22)
}

export async function boundedJson(message: Request | Response, limit: number): Promise<unknown> {
  const reader = message.body?.getReader()
  if (!reader) throw new Error('Missing JSON body')
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        void reader.cancel().catch(() => {})
        throw new Error('JSON body too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } finally {
    reader.releaseLock()
  }
}

async function discard(body: ReadableStream<Uint8Array> | null): Promise<void> {
  // Drain the rejected upload to avoid affecting the relay's pooled connections.
  if (!body) return
  const reader = body.getReader()
  try {
    while (!(await reader.read()).done) { /* discard */ }
  } catch { /* request aborted */ }
  finally { reader.releaseLock() }
}

type Subscription = [url: string, digest: string | null]

function subscriptions(payload: unknown): Subscription[] | null {
  if (!Array.isArray(payload) || payload.length > PEER_BATCH_SIZE) return null
  const seen = new Map<string, string | null>()
  for (const entry of payload) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const url = peerPrUrl(entry[0])
    const digest: unknown = entry[1]
    if (!url || (digest !== null && (typeof digest !== 'string' || !/^[\w-]{22}$/.test(digest)))) return null
    seen.set(url, digest)
  }
  return [...seen]
}

function digestHeader(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function mountPrStatusPeer(app: Hono, authority: Authority, token: string, revision: () => string): void {
  const credential = digestHeader(`Bearer ${token}`)
  const authorized = (req: Request) =>
    !req.headers.has('origin') &&
    !req.headers.has('sec-fetch-site') &&
    timingSafeEqual(credential, digestHeader(req.headers.get('authorization') ?? ''))

  app.use(`${PR_STATUS_PEER_PATH}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (!authorized(c.req.raw)) {
      await discard(c.req.raw.body)
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return next()
  })

  app.get(`${PR_STATUS_PEER_PATH}/revision`, c => c.json(revision()))

  app.post(`${PR_STATUS_PEER_PATH}/sync`, async (c) => {
    const payload = await boundedJson(c.req.raw, REQUEST_BYTES).catch(() => null)
    const requested = subscriptions(payload)
    if (!requested) return c.json({ error: 'Invalid subscriptions' }, 400)
    const versions = new Map(requested)
    const urls = [...versions.keys()]
    authority.register(urls)
    return c.json(authority.read(urls).filter((record) =>
      versions.has(record.url) && recordDigest(record) !== versions.get(record.url)))
  })

  app.post(`${PR_STATUS_PEER_PATH}/check`, async (c) => {
    const payload = await boundedJson(c.req.raw, REQUEST_BYTES).catch(() => null)
    const url = peerPrUrl(payload)
    if (!url) return c.json({ error: 'Invalid pull request URL' }, 400)
    authority.register([url])
    return c.json(await authority.check(url))
  })
}
