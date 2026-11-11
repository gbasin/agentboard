/** Resolve only transcript-discovered references; never accept an arbitrary target. */
import path from 'node:path'
import { PreviewTlsError } from './certificates'
import { OutputFileResolver } from './fileResolver'
import { absoluteOutputPath } from './fileEvidence'
import { visualizationFile, VisualizationError } from './visualization'
import { Hono } from 'hono'
import type { AgentSessionRecord } from '../db'
import { createHash } from 'node:crypto'
import { readMediaLine } from '../mediaLine'
import { extractMediaItems } from '../mediaExtractor'
import { getSubagentLogPaths } from '../subagentLogs'
import { metadataIdentity } from '../sessionMetadataClient'
import { loopbackUrl } from '../outputReferences'
import { PreviewServers } from './previewServers'
import { OutputThumbnails } from './thumbnails'

export function outputRoutes(options: {
  getSession: (id: string) => AgentSessionRecord | null | undefined
  previews: PreviewServers
  blockedPorts: () => number[]
  cacheRoot: string
  ready: () => Promise<unknown>
}) {
  const app = new Hono()
  const files = new OutputFileResolver()
  const thumbnails = new OutputThumbnails(path.join(options.cacheRoot, 'output-thumbnails'))
  app.get('/:sessionId/open', async c => {
    const record = options.getSession(c.req.param('sessionId'))
    if (!record?.logFilePath) return c.json({ error: 'Session not found' }, 404)
    const source = c.req.query('path') ?? ''
    const offset = Number(c.req.query('offset')), index = Number(c.req.query('index'))
    const digest = c.req.query('digest') ?? ''
    if ((source !== record.logFilePath && !getSubagentLogPaths(record.logFilePath, record.agentType, record.sessionId).includes(source)) ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(index) || index < 0 || !/^[a-f0-9]{64}$/.test(digest)) {
      return c.json({ error: 'Invalid output reference' }, 400)
    }
    // Re-read one bounded record, not the entire transcript on the main thread.
    const line = await readMediaLine(source, offset).catch(() => null)
    if (!line) return c.json({ error: 'Output is no longer shared by this session' }, 404)
    const current = options.getSession(record.sessionId)
    if (!current || metadataIdentity(current) !== metadataIdentity(record) || createHash('sha256').update(line).digest('hex') !== digest) {
      return c.json({ error: 'Session output changed; refresh previews' }, 409)
    }
    const descriptor = extractMediaItems(line)[index]
    if (!descriptor || !['html', 'localhost', 'visualization'].includes(descriptor.kind) || !descriptor.url) {
      return c.json({ error: 'Output is no longer shared by this session' }, 404)
    }
    const ref = descriptor.url
    const upstream = descriptor.kind === 'localhost' ? loopbackUrl(ref) : null
    if (descriptor.kind === 'localhost' && (!upstream || options.blockedPorts().includes(Number(upstream.port)) || options.previews.isPreviewOrigin(upstream.origin))) {
      return c.json({ error: 'This local address cannot be previewed' }, 400)
    }
    let file = absoluteOutputPath(ref, record.projectPath)
    const thumbnailKey = JSON.stringify([record.sessionId, descriptor.kind, upstream?.href ?? file])
    if (c.req.query('format') === 'thumbnail') {
      const body = await thumbnails.read(thumbnailKey)
      c.header('Cache-Control', 'no-store')
      return body ? new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } }) : c.body(null, 204)
    }
    try {
      if (descriptor.kind === 'html') {
        const resolution = await files.resolve(ref, record, c.req.query('candidate')).catch(error => ({ kind: 'failed' as const, error: error instanceof Error ? error.message : 'Unable to resolve this file' }))
        if (resolution.kind === 'failed') return c.json({ error: resolution.error }, 503)
        const latest = options.getSession(record.sessionId)
        const latestLine = await readMediaLine(source, offset).catch(() => null)
        if (!latest || metadataIdentity(latest) !== metadataIdentity(record) || latest.projectPath !== record.projectPath || latestLine !== line) {
          return c.json({ error: 'Session output changed; refresh previews' }, 409)
        }
        if (resolution.kind === 'missing') return c.json({ error: 'Couldn’t resolve this file. Ask the agent to share its full path.', attemptedPath: resolution.attemptedPath }, 404)
        if (resolution.kind === 'ambiguous') return c.json({ error: 'Several files in this session have this name. Choose the one to open.', candidates: resolution.candidates }, 409)
        file = resolution.file
      }
      await options.ready()
      const resolvedFile = descriptor.kind === 'visualization' ? await visualizationFile(file, options.cacheRoot) : file
      const boardUrl = new URL(c.req.url)
      // A browser can require HTTPS even when the proxy omits forwarding headers.
      // This only upgrades transport; certificate issuance still verifies local identity.
      if (c.req.query('protocol') === 'https:' || c.req.header('x-forwarded-proto') === 'https') boardUrl.protocol = 'https:'
      const url = await options.previews.open(upstream ? { kind: 'localhost', url: upstream.href } : { kind: 'html', file: resolvedFile }, boardUrl)
      void thumbnails.ensure(thumbnailKey, url)
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      if (c.req.query('format') === 'json') return c.json({ url })
      return c.redirect(url)
    } catch (error) {
      if (error instanceof PreviewTlsError) return c.json({ error: error.message }, 503)
      if (error instanceof VisualizationError) return c.json({ error: error.message }, 422)
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      return c.json({ error: missing ? `Output file not found at ${file}. Ask the agent to share its current path.` : 'Unable to start preview. Check available ports and try again.' }, missing ? 404 : 503)
    }
  })
  return app
}
