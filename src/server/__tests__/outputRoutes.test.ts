/** The public relay and internal dashboard must never become preview upstreams. */
import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { outputRoutes } from '../outputs/routes'
import { PreviewServers } from '../outputs/previewServers'
import type { AgentSessionRecord } from '../db'

test('rejects transcript references to every board listener and refuses stale digests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-output-route-'))
  const log = path.join(root, 'session.jsonl')
  const previews = new PreviewServers({ hostname: '127.0.0.1' })
  const record = { sessionId: 'fixture', agentType: 'claude', logFilePath: log, projectPath: root } as AgentSessionRecord
  const app = outputRoutes({ getSession: () => record, previews, blockedPorts: () => [4040, 45000], cacheRoot: root, ready: async () => {} })
  try {
    for (const port of [4040, 45000]) {
      const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `http://localhost:${port}` }] } })
      await fs.writeFile(log, line + '\n')
      const query = new URLSearchParams({ path: log, offset: '0', index: '0', digest: createHash('sha256').update(line).digest('hex') })
      expect((await app.request('/fixture/open?' + query)).status).toBe(400)
      query.set('digest', 'a'.repeat(64))
      expect((await app.request('/fixture/open?' + query)).status).toBe(409)
    }
  } finally { previews.dispose(); await fs.rm(root, { recursive: true, force: true }) }
})
