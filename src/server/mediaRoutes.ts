/** Bounded media listings and content-validated payloads; never part of live catalogs. */
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import type { AgentSessionRecord } from './db'
import type { MediaPage } from '../shared/media'
import { extractMediaItems } from './mediaExtractor'
import { getSubagentLogPaths } from './subagentLogs'
import { metadataIdentity } from './sessionMetadataClient'
import { isValidSessionId } from './validators'

interface Dependencies {
  getRecord(id: string): AgentSessionRecord | null | undefined
  page(record: AgentSessionRecord, cursor?: string): Promise<MediaPage>
  invalidate?(record: AgentSessionRecord): void
}

async function readLine(logPath: string, offset: number): Promise<string | null> {
  const handle = await fs.open(logPath, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total < 64 * 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, 64 * 1024 * 1024 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset + total)
      if (!bytesRead) return chunks.length ? Buffer.concat(chunks).toString('utf8') : null
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(buffer.subarray(0, newline))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    // A truncated JSONL record is never a valid payload.
    return null
  } finally { await handle.close() }
}

export function createMediaRoutes(deps: Dependencies) {
  const app = new Hono()
  app.get('/:sessionId/items', async (c) => {
    const id = c.req.param('sessionId')
    if (!isValidSessionId(id)) return c.json({ error: 'Invalid session id' }, 400)
    const record = deps.getRecord(id)
    if (!record?.logFilePath) return c.json({ error: 'Session not found' }, 404)
    const cursor = c.req.query('cursor')
    if (cursor && cursor.length > 8192) return c.json({ error: 'Invalid cursor' }, 400)
    try {
      const page = await deps.page(record, cursor)
      const current = deps.getRecord(id)
      if (!current) return c.json({ error: 'Session not found' }, 404)
      if (metadataIdentity(current) !== metadataIdentity(record)) {
        return c.json({ error: 'Session changed; refresh media', code: 'STALE_CURSOR' }, 409)
      }
      c.header('Cache-Control', 'no-store')
      return c.json(page)
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code === 'STALE_CURSOR') return c.json({ error: 'Media changed; refresh to continue', code }, 409)
      if (code === 'INVALID_CURSOR') return c.json({ error: 'Invalid media cursor', code }, 400)
      return c.json({ error: 'Media is temporarily unavailable' }, 503)
    }
  })

  app.get('/:sessionId', async (c) => {
    const id = c.req.param('sessionId')
    if (!isValidSessionId(id)) return c.json({ error: 'Invalid session id' }, 400)
    const record = deps.getRecord(id)
    if (!record?.logFilePath) return c.json({ error: 'Session not found' }, 404)
    const mediaPath = c.req.query('path') ?? ''
    const allowed = mediaPath === record.logFilePath ||
      getSubagentLogPaths(record.logFilePath, record.agentType, id).includes(mediaPath)
    if (!allowed) return c.json({ error: 'Invalid media path' }, 400)
    const digest = c.req.query('digest')
    const offset = Number(c.req.query('offset')), index = Number(c.req.query('index'))
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(index) || index < 0 || (!digest && index > 256)) {
      return c.json({ error: 'Invalid media ref' }, 400)
    }
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) return c.json({ error: 'Invalid media digest' }, 400)
    try {
      const line = await readLine(mediaPath, offset)
      if (!line) return c.json({ error: 'Media not found' }, 404)
      const current = deps.getRecord(id)
      if (!current || metadataIdentity(current) !== metadataIdentity(record)) return c.json({ error: 'Session changed' }, 409)
      if (digest && createHash('sha256').update(line).digest('hex') !== digest) {
        deps.invalidate?.(record)
        return c.json({ error: 'Stale media ref' }, 409)
      }
      const item = extractMediaItems(line)[index]
      if (item?.url) {
        let target: URL
        try { target = new URL(item.url) } catch { return c.json({ error: 'Invalid media URL' }, 400) }
        if (!['https:', 'http:'].includes(target.protocol)) return c.json({ error: 'Unsupported media URL' }, 400)
        c.header('Cache-Control', 'no-store')
        return c.redirect(target.href, 302)
      }
      if (!item?.data) return c.json({ error: 'Media not found' }, 404)
      const body = Buffer.from(item.data, 'base64')
      const expected = c.req.query('bytes')
      if (expected !== undefined && (!Number.isSafeInteger(Number(expected)) || Number(expected) !== body.length)) {
        return c.json({ error: 'Stale media ref' }, 409)
      }
      return new Response(new Uint8Array(body), { headers: {
        'Content-Type': item.mediaType ?? 'application/octet-stream',
        'Cache-Control': digest ? 'private, max-age=31536000, immutable' : 'no-store',
        'X-Content-Type-Options': 'nosniff',
      } })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: 'Media not found' }, 404)
      return c.json({ error: 'Unable to read media' }, 500)
    }
  })
  return app
}
