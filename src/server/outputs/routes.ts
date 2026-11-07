/** Resolve only transcript-discovered references; never accept an arbitrary target. */
import path from 'node:path'
import os from 'node:os'
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

export function outputRoutes(options: {
  getSession: (id: string) => AgentSessionRecord | null | undefined
  previews: PreviewServers
  boardPort: number
  cacheRoot: string
  ready: () => Promise<unknown>
}) {
  const app = new Hono()
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
    if (descriptor.kind === 'localhost' && (!upstream || Number(upstream.port) === options.boardPort || options.previews.isPreviewOrigin(upstream.origin))) {
      return c.json({ error: 'This local address cannot be previewed' }, 400)
    }
    const file = ref.startsWith('~/') ? path.join(os.homedir(), ref.slice(2)) : path.resolve(record.projectPath, ref)
    try {
      await options.ready()
      const resolvedFile = descriptor.kind === 'visualization' ? await visualizationFile(file, options.cacheRoot) : file
      const url = await options.previews.open(upstream ? { kind: 'localhost', url: upstream.href } : { kind: 'html', file: resolvedFile }, new URL(c.req.url))
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      if (c.req.query('format') === 'json') return c.json({ url })
      return c.redirect(url)
    } catch (error) {
      if (error instanceof VisualizationError) return c.json({ error: error.message }, 422)
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      return c.json({ error: missing ? 'Output file not found. It may have been moved or deleted.' : 'Unable to start preview. Check available ports and try again.' }, missing ? 404 : 503)
    }
  })
  return app
}
