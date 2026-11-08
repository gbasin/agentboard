/** Real-backend fixture: only private logs/DB, with loopback controls for native E2E. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { initDatabase } from '../../src/server/db'
if (process.env.NATIVE_PARITY_SHELL_RESUME !== '1') throw new Error('Requires the private shell-resume backend on 4151')
const root = '/tmp/ab-ios-parity'
const id = '22222222-3333-4444-8555-666666666666'
const log = `${root}/${id}.jsonl`
const child = `${root}/${id}/subagents/agent-native-review.jsonl`
const row = (event: object) => JSON.stringify({ sessionId: id, timestamp: new Date().toISOString(), ...event }) + '\n'
function png(index: number): string {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, payload, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.concat(Array.from({ length: 32 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 32 }, () => [index * 2, 100, 220 - index]).flat())])))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
await mkdir(`${root}/project`, { recursive: true })
await mkdir(`${root}/${id}/subagents`, { recursive: true })
const lines = Array.from({ length: 90 }, (_, index) => row({ type: 'user', message: { role: 'user', content: [
  { type: 'frame-link', title: `Catalog reference ${String(index).padStart(3, '0')}`, frameUrl: `https://example.com/native-${String(index).padStart(3, '0')}` },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(index) } },
] } })).join('')
await writeFile(log, lines)
async function activity(done: boolean) {
  await appendFile(child, row(done ? { type: 'assistant', message: { stop_reason: 'end_turn' } } : {
    type: 'assistant', message: { content: [{ type: 'tool_use', id: `read-${Date.now()}`, name: 'Read', input: {} }] },
  }))
  await writeFile(child.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'Native activity reviewer', finished: done }))
}
await activity(false)
const db = initDatabase({ path: `${root}/data/agentboard.db` })
const now = new Date().toISOString()
if (!db.getSessionById(id)) db.insertSession({ sessionId: id, logFilePath: log, projectPath: `${root}/project`, slug: null,
  agentType: 'claude', displayName: 'native-media-activity', createdAt: now, lastActivityAt: now, lastUserMessage: 'Native media pagination fixture',
  currentWindow: null, isHibernating: false, lastResumeError: null, lastKnownLogSize: null, isCodexExec: false, launchCommand: '/bin/zsh -f' })
db.close()
const sessions = await (await fetch('http://127.0.0.1:4151/api/sessions')).json() as { agentSessionId?: string }[]
if (!sessions.some(session => session.agentSessionId === id)) await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:4151/ws?catalog=2')
  const timer = setTimeout(() => { ws.close(); reject(new Error('Wake timeout')) }, 15000)
  ws.onopen = () => ws.send(JSON.stringify({ type: 'session-wake', sessionId: id }))
  ws.onmessage = event => {
    const message = JSON.parse(String(event.data))
    if (message.type === 'session-wake-result' && message.sessionId === id) {
      clearTimeout(timer); ws.close()
      if (message.ok) resolve(); else reject(new Error(JSON.stringify(message)))
    }
  }
})
Bun.serve({ hostname: '127.0.0.1', port: 4193, async fetch(request) {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST') return new Response('POST required', { status: 405 })
  if (path === '/activity/running') await activity(false)
  else if (path === '/activity/done') await activity(true)
  else return new Response('Not found', { status: 404 })
  return Response.json({ ok: true })
} })
console.log(`Real backend media/activity fixture ${id}; controls on loopback 4193`)
