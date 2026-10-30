/** Release artifact regression: bun scripts/verify-media-discovery-binary.ts /path/to/agentboard */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import type { MediaPage, MediaNeighbors, MediaStreamEvent } from '../src/shared/media'

const binary = process.argv[2]
if (!binary) throw Error('Pass the compiled Agentboard executable path')
const root = mkdtempSync(path.join(tmpdir(), 'ab-media-compiled-'))
const env: Record<string, string | undefined> = {
  ...process.env, TMUX_TMPDIR: root, TMUX_SESSION: 'media-compiled',
  AGENTBOARD_DATA_DIR: root, AGENTBOARD_DB_PATH: path.join(root, 'db'),
  LOG_FILE: path.join(root, 'server.log'), AGENTBOARD_TMUX_PID_FILE: path.join(root, 'tmux.pid'),
  AGENTBOARD_TERMINAL_RELAY: '1', HOSTNAME: '127.0.0.1', AGENTBOARD_REMOTE_HOSTS: '',
  AGENTBOARD_OWNERSHIP_MATCHING: 'false', AGENTBOARD_TMUX_SET_CLIPBOARD: '0', NODE_ENV: 'production',
}
delete env.TMUX; delete env.TMUX_PANE
for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_HOME', 'PI_CODING_AGENT_DIR', 'DEVIN_CLI_DIR', 'GROK_HOME']) {
  env[key] = path.join(root, key.toLowerCase()); mkdirSync(env[key]!, { recursive: true })
}
// Initialize only this probe's database before loading modules with config/logger state.
process.env.AGENTBOARD_DATA_DIR = root
process.env.AGENTBOARD_DB_PATH = env.AGENTBOARD_DB_PATH
process.env.LOG_FILE = env.LOG_FILE
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = reservation.port!; reservation.stop(true); env.PORT = String(port)
const base = `http://127.0.0.1:${port}`
const sessionId = crypto.randomUUID(), logPath = path.join(root, 'fixture.jsonl')
const url = `${base}/api/session-media/${sessionId}`
const fullUrl = `https://example.com/compiled-report?value=${'long-value-'.repeat(500)}`
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhHGAfKmMIwAAAABJRU5ErkJggg=='
const secondPng = new PNG({ width: 1, height: 1 }); secondPng.data.set([0, 0, 255, 255])
const secondImage = PNG.sync.write(secondPng).toString('base64')
const image = (id: number) => JSON.stringify({ type: 'user', timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(), message: { content: [
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: id === 0 ? png : secondImage } },
] } })
const lines = [image(0)]
for (let i = 0; i < 120; i++) lines.push(JSON.stringify({ type: 'frame-link',
  timestamp: new Date(1_700_000_001_000 + i * 1000).toISOString(), frameUrl: i === 0 ? fullUrl : `https://example.com/item/${i}`,
  title: `Compiled item ${i}`, padding: 'x'.repeat(24 * 1024),
}))
lines.push(image(122))
writeFileSync(logPath, lines.join('\n') + '\n')
let child: ReturnType<typeof Bun.spawn> | undefined
const metrics: Record<string, unknown> = { fixtureBytes: Buffer.byteLength(lines.join('\n') + '\n'), expectedItems: 122 }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function tmux(...args: string[]) {
  const result = Bun.spawnSync(['tmux', ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode) throw Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
async function start() {
  child = Bun.spawn([path.resolve(binary)], { env, stdout: Bun.file(path.join(root, 'stdout')), stderr: Bun.file(path.join(root, 'stderr')) })
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    try { if ((await fetch(`${base}/api/server-info`)).ok) return } catch {}
    if (child.exitCode !== null) throw Error(`Compiled server exited: ${child.exitCode}`)
    await pause(50)
  }
  throw Error('Compiled server unavailable')
}
async function stop() {
  if (!child) return
  const current = child; child = undefined
  current.kill()
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([current.exited, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000) })])
  clearTimeout(timer)
  if (result === null) { current.kill('SIGKILL'); await current.exited; throw Error('Compiled shutdown exceeded 10 seconds') }
  assert.equal(result, 0); assert.equal(current.signalCode, null)
}
async function page(query = ''): Promise<MediaPage> {
  const response = await fetch(`${url}/items${query}`, { signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200)
  const text = await response.text(); assert(Buffer.byteLength(text) <= 64 * 1024)
  return JSON.parse(text)
}
try {
  const { initDatabase } = await import('../src/server/db')
  const db = initDatabase({ path: env.AGENTBOARD_DB_PATH })
  db.insertSession({ sessionId, logFilePath: logPath, projectPath: root, slug: null, agentType: 'claude',
    displayName: 'Compiled media fixture', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    lastUserMessage: null, currentWindow: null, isHibernating: false, lastResumeError: null,
    lastKnownLogSize: null, isCodexExec: false, launchCommand: null })
  db.close()
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', env.TMUX_SESSION!, 'exec /bin/cat')
  await start()
  const began = performance.now(), cold = await page()
  metrics.coldReadMs = Math.round(performance.now() - began)
  assert.equal(cold.total, 0, 'Dormant snapshot read must not scan the transcript')
  assert.equal(cold.discovery?.status, 'pending')
  const discoveryAt = performance.now()
  const response = await fetch(`${url}/items?stream=1`, { signal: AbortSignal.timeout(20_000) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /ndjson/)
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let pending = '', bytes = 0
  const events: MediaStreamEvent[] = []
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    bytes += result.value.byteLength; assert(bytes <= 512 * 1024)
    pending += decoder.decode(result.value, { stream: true })
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      assert(Buffer.byteLength(line) <= 64 * 1024)
      if (!line) continue
      const event: MediaStreamEvent = JSON.parse(line); events.push(event)
      assert.notEqual(event.type, 'error', JSON.stringify(event))
      if (event.type === 'snapshot' && event.page.items.length && metrics.firstItemsMs === undefined) metrics.firstItemsMs = Math.round(performance.now() - discoveryAt)
    }
  }
  assert.equal(pending, '')
  assert.equal(events[0]?.type, 'snapshot')
  assert.equal(events.at(-1)?.type, 'done')
  assert(events.some(event => event.type === 'progress' && event.summary.discovery?.status === 'ready'))
  metrics.discoveryMs = Math.round(performance.now() - discoveryAt); metrics.streamBytes = bytes; metrics.streamFrames = events.length
  const first = await page(), all = [...first.items]
  assert.equal(first.total, 122); assert.equal(first.discovery?.status, 'ready')
  let cursor = first.nextCursor
  while (cursor) { const next = await page(`?cursor=${encodeURIComponent(cursor)}`); all.push(...next.items); cursor = next.nextCursor }
  assert.equal(all.length, 122); assert.equal(new Set(all.map(item => item.url)).size, 122)
  const fullLink = all.find(item => item.externalUrl === fullUrl)
  assert(fullLink, 'Full link destination was truncated or lost')
  const redirect = await fetch(new URL(fullLink.url, base), { redirect: 'manual' })
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), fullUrl)
  const images = all.filter(item => item.kind === 'image'); assert.equal(images.length, 2)
  const neighborsResponse = await fetch(`${url}/neighbors?anchor=${encodeURIComponent(images[0]!.url)}`)
  assert.equal(neighborsResponse.status, 200)
  const neighbors: MediaNeighbors = await neighborsResponse.json()
  assert.equal(neighbors.current.url, images[0]!.url); assert.equal(neighbors.next?.url, images[1]!.url)
  const payload = await fetch(new URL(images[0]!.url, base))
  assert.equal(payload.status, 200); assert.deepEqual(Buffer.from(await payload.arrayBuffer()), Buffer.from(secondImage, 'base64'))
  await stop()
  // Persisted snapshots must remain readable without opening their transcript.
  renameSync(logPath, `${logPath}.offline`)
  await start()
  const warmAt = performance.now(), warm = await page()
  metrics.restartReadMs = Math.round(performance.now() - warmAt)
  assert.equal(warm.total, 122); assert.deepEqual(warm.items, first.items)
  await stop()
  const log = await Bun.file(env.LOG_FILE!).text()
  assert(!/ModuleNotFound|media_worker_failed/.test(log), 'Compiled worker failed')
  console.log('PASS: compiled media cold snapshot, finite discovery, bounded pagination, neighbors, payload, full URL, and persisted restart without source')
  console.log(JSON.stringify(metrics))
} catch (error) {
  process.exitCode = 1; console.error(error)
  for (const name of ['stderr', 'server.log']) {
    const file = Bun.file(path.join(root, name)); if (await file.exists()) console.error(name, (await file.text()).slice(-6000))
  }
} finally {
  try { await stop() } catch (error) { process.exitCode = 1; console.error(error) }
  try { for (const session of tmux('list-sessions', '-F', '#{session_name}').split('\n')) tmux('kill-session', '-t', `=${session}`) } catch {}
  rmSync(root, { recursive: true, force: true })
}
