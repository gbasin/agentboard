/** Resolve only transcript-discovered references; never accept an arbitrary target. */
import path from 'node:path'
import os from 'node:os'
import { visualizationFile, VisualizationError } from './visualization'
import { Hono } from 'hono'
import type { AgentSessionRecord } from '../db'
import { getMergedMedia } from '../agentSessions'
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
    const ref = c.req.query('ref') ?? ''
    const descriptor = getMergedMedia(record).find(item => {
      if (item.kind !== 'html' && item.kind !== 'localhost' && item.kind !== 'visualization') return false
      return new URL(item.url, 'http://agentboard.local').searchParams.get('ref') === ref
    })
    if (!descriptor) return c.json({ error: 'Output is no longer shared by this session' }, 404)
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
