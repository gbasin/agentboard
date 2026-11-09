/** Opt-in load fixture. Uses only the private parity DB and a bounded generated log. */
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { initDatabase } from '../../src/server/db'
if (process.env.NATIVE_PARITY_SHELL_RESUME !== '1') throw new Error('Private parity backend required')
const root = '/tmp/ab-ios-parity', id = '33333333-4444-4555-8666-777777777777'
const log = `${root}/${id}.jsonl`
const line = (n: number) => JSON.stringify({ sessionId: id, type: 'user', timestamp: '2026-11-08T12:00:00Z', message: { role: 'user', content: [{ type: 'frame-link', title: `Slow reference ${n}`, frameUrl: `https://example.test/slow-${n}` }] } }) + '\n'
await mkdir(root, { recursive: true }); await writeFile(log, line(0))
const db = initDatabase({ path: `${root}/data/agentboard.db` })
const now = new Date().toISOString()
if (!db.getSessionById(id)) db.insertSession({ sessionId: id, logFilePath: log, projectPath: `${root}/project`, slug: null,
  agentType: 'claude', displayName: 'native-slow-media', createdAt: now, lastActivityAt: now, lastUserMessage: 'Slow discovery acceptance',
  currentWindow: null, isHibernating: false, lastResumeError: null, lastKnownLogSize: null, isCodexExec: false, launchCommand: '/bin/zsh -f' })
db.close()
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:4151/ws?catalog=2')
  const timer = setTimeout(() => { ws.close(); reject(new Error('Private fixture lifecycle timeout')) }, 25000)
  ws.onopen = () => ws.send(JSON.stringify({ type: 'session-wake', sessionId: id }))
  ws.onmessage = event => {
    const message = JSON.parse(String(event.data))
    if (message.sessionId !== id) return
    if (message.type.endsWith('-result') && !message.ok) { clearTimeout(timer); ws.close(); reject(new Error(JSON.stringify(message))); return }
    if (message.type === 'session-wake-result') setTimeout(() => ws.send(JSON.stringify({ type: 'session-hibernate', sessionId: id })), 1500)
    if (message.type === 'session-hibernate-result') ws.send(JSON.stringify({ type: 'session-move-to-history', sessionId: id }))
    if (message.type === 'session-move-to-history-result') { clearTimeout(timer); ws.close(); resolve() }
  }
})
let generated = false
Bun.serve({ hostname: '127.0.0.1', port: 4194, async fetch(request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/append') return new Response('Not found', { status: 404 })
  if (generated) return Response.json({ error: 'Restart the fixture before another run' }, { status: 409 })
  generated = true
  const file = await open(log, 'a')
  try {
    for (let start = 1; start <= 500000; start += 1000) {
      await file.write(Array.from({ length: 1000 }, (_, offset) => line(start + offset)).join(''))
    }
  } finally { await file.close() }
  return Response.json({ records: 500001, bytes: (await stat(log)).size })
} })
console.log('Private slow media fixture on 4194; POST /append generates 500,000 references')
