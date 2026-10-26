/** Bounded media listings and content-validated payloads; never part of live catalogs. */
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { readMediaLine } from './mediaLine'
import type { MediaThumbnailClient } from './mediaThumbnailClient'
import type { AgentSessionRecord } from './db'
import type { MediaPage, MediaNeighbors, MediaQuery, MediaStreamEvent } from '../shared/media'
import { extractMediaItems } from './mediaExtractor'
import { getSubagentLogPaths } from './subagentLogs'
import { metadataIdentity } from './sessionMetadataClient'
import { isValidSessionId } from './validators'
import { parseMediaAnchor } from './mediaAnchor'
import { mediaStreamResponse } from './mediaStreamResponse'

interface Dependencies {
  getRecord(id: string): AgentSessionRecord | null | undefined
  page(record: AgentSessionRecord, cursor?: string, query?: MediaQuery): Promise<MediaPage>
  watch?(record: AgentSessionRecord, cursor?: string, query?: MediaQuery, signal?: AbortSignal): AsyncIterable<MediaStreamEvent>
  neighbors?(record: AgentSessionRecord, anchor: string): Promise<MediaNeighbors>
  thumbnail?: Pick<MediaThumbnailClient, 'get'>
  invalidate?(record: AgentSessionRecord): void
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
    const kind = c.req.query('kind'), search = c.req.query('search')
    if (kind !== undefined && kind !== 'media' && kind !== 'links') return c.json({ error: 'Invalid media kind' }, 400)
    if (search && search.length > 200) return c.json({ error: 'Search too long' }, 400)
    if (c.req.query('stream') === '1') {
      if (!deps.watch) return c.json({ error: 'Media discovery is temporarily unavailable' }, 503)
      return mediaStreamResponse({
        watch: signal => deps.watch!(record, cursor, { kind, search }, signal),
        isCurrent: () => {
          const current = deps.getRecord(id)
          return !!current && metadataIdentity(current) === metadataIdentity(record)
        },
        signal: c.req.raw.signal,
      })
    }
    try {
      const page = await deps.page(record, cursor, { kind, search })
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

  app.get('/:sessionId/neighbors', async (c) => {
    c.header('Cache-Control', 'no-store')
    const id = c.req.param('sessionId')
    if (!isValidSessionId(id)) return c.json({ error: 'Invalid session id' }, 400)
    const record = deps.getRecord(id)
    if (!record?.logFilePath) return c.json({ error: 'Session not found' }, 404)
    const anchor = c.req.query('anchor') ?? ''
    try { parseMediaAnchor(id, anchor) }
    catch { return c.json({ error: 'Invalid image anchor', code: 'INVALID_ANCHOR' }, 400) }
    if (!deps.neighbors) return c.json({ error: 'Image navigation unavailable' }, 503)
    try {
      const neighbors = await deps.neighbors(record, anchor)
      const current = deps.getRecord(id)
      if (!current) return c.json({ error: 'Session not found' }, 404)
      if (metadataIdentity(current) !== metadataIdentity(record)) {
        return c.json({ error: 'Session changed; refresh media', code: 'STALE_ANCHOR' }, 409)
      }
      return c.json(neighbors)
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code === 'STALE_ANCHOR' || code === 'STALE_CURSOR') {
        return c.json({ error: 'Image changed; refresh media', code: 'STALE_ANCHOR' }, 409)
      }
      if (code === 'INVALID_ANCHOR') return c.json({ error: 'Invalid image anchor', code }, 400)
      return c.json({ error: 'Image navigation is temporarily unavailable' }, 503)
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
      if (c.req.query('thumbnail') === '1') {
        if (!digest) return c.json({ error: 'Thumbnail requires a content digest' }, 400)
        if (!deps.thumbnail) return c.json({ error: 'Thumbnails unavailable' }, 503)
        const expectedBytes = c.req.query('bytes')
        if (expectedBytes !== undefined && (!Number.isSafeInteger(Number(expectedBytes)) || Number(expectedBytes) < 0)) {
          return c.json({ error: 'Invalid byte count' }, 400)
        }
        try {
          const body = await deps.thumbnail.get({ path: mediaPath, offset, index, digest,
            ...(expectedBytes === undefined ? {} : { expectedBytes: Number(expectedBytes) }),
          }, c.req.raw.signal)
          const current = deps.getRecord(id)
          if (!current || metadataIdentity(current) !== metadataIdentity(record)) return c.json({ error: 'Session changed' }, 409)
          return new Response(new Uint8Array(body), { headers: {
            'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
          } })
        } catch (error) {
          const code = (error as { code?: string }).code
          if (code === 'STALE') { deps.invalidate?.(record); return c.json({ error: 'Stale media ref' }, 409) }
          if (code === 'NOT_FOUND') return c.json({ error: 'Media not found' }, 404)
          if (code === 'UNSUPPORTED') return c.json({ error: 'Preview unavailable; open original' }, 422)
          return c.json({ error: 'Preview temporarily unavailable' }, 503)
        }
      }
      const line = await readMediaLine(mediaPath, offset)
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
