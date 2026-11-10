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

test('opens session-evidenced filenames and requires current evidence for every chosen path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-output-resolve-route-'))
  const project = path.join(root, 'project'), log = path.join(root, 'session.jsonl')
  const first = path.join(root, 'report.html'), second = path.join(root, 'other', 'report.html')
  const previews = new PreviewServers({ hostname: '127.0.0.1' })
  const record = { sessionId: 'fixture', agentType: 'claude', logFilePath: log, projectPath: project } as AgentSessionRecord
  const app = outputRoutes({ getSession: () => record, previews, blockedPorts: () => [], cacheRoot: root, ready: async () => {} })
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '`report.html`' }] } })
  const evidence = (file: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file } }] } }) + '\n'
  const query = new URLSearchParams({ path: log, offset: '0', index: '0', digest: createHash('sha256').update(line).digest('hex'), format: 'json' })
  const open = () => app.request('/fixture/open?' + query)
  const body = async (response: Response) => {
    const { url } = await response.json()
    const capability = await fetch(url, { redirect: 'manual' })
    return (await fetch(new URL(capability.headers.get('location')!, url), { headers: { Cookie: capability.headers.get('set-cookie')!.split(';')[0] } })).text()
  }
  try {
    await fs.mkdir(project); await fs.mkdir(path.dirname(second))
    await fs.writeFile(first, '<h1>First</h1>'); await fs.writeFile(second, '<h1>Second</h1>')
    await fs.writeFile(log, line + '\n' + evidence(first))
    let reads = 0
    const stale = outputRoutes({ getSession: () => ++reads < 3 ? record : { ...record, logFilePath: log + '.replacement' }, previews, blockedPorts: () => [], cacheRoot: root, ready: async () => {} })
    expect((await stale.request('/fixture/open?' + query)).status).toBe(409)
    const resolved = await open()
    expect(resolved.status).toBe(200)
    expect(await body(resolved)).toContain('First')
    await fs.appendFile(log, evidence(second))
    const ambiguous = await open()
    expect(ambiguous.status).toBe(409)
    expect((await ambiguous.json()).candidates).toEqual([first, second].sort())
    query.set('candidate', second)
    expect(await body(await open())).toContain('Second')
    query.set('candidate', '/etc/passwd')
    expect((await open()).status).toBe(503)
    query.delete('candidate')
    await fs.writeFile(log, line + '\n')
    const missing = await open()
    expect(missing.status).toBe(404)
    expect((await missing.json()).attemptedPath).toBe(path.join(project, 'report.html'))
  } finally { previews.dispose(); await fs.rm(root, { recursive: true, force: true }) }
})
