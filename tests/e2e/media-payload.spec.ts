/** Payload access remains correct after moving descriptors out of the catalog. */
import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MediaPage } from '../../src/shared/media'
import { mediaFixture, TINY_PNG } from './helpers/mediaFixture'

test.describe.configure({ timeout: 180_000 })

async function discover(request: APIRequestContext, id: string) {
  // Snapshot reads deliberately do not scan. Explicit discovery owns freshness.
  const response = await request.get(`/api/session-media/${id}/items?stream=1`, { timeout: 75_000 })
  expect(response.status()).toBe(200)
  const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  expect(frames.some(frame => frame.type === 'error')).toBe(false)
  expect(frames.some(frame => frame.type === 'progress' && frame.summary?.discovery?.status === 'ready')).toBe(true)
  expect(frames.at(-1)?.type).toBe('done')
}

test('real Codex images and Claude documents retain their payloads and path restrictions', async ({ request }) => {
  const root = process.env.E2E_TMUX_TMPDIR, codex = process.env.CODEX_HOME, claude = process.env.CLAUDE_CONFIG_DIR
  if (!root || !codex || !claude) throw new Error('Private E2E transcript directories required')
  const timestamp = new Date().toISOString(), imageId = randomUUID(), documentId = randomUUID()
  const imageDir = path.join(codex, 'sessions', '2026', '10', '25'), docDir = path.join(claude, 'projects', `media-${documentId}`)
  fs.mkdirSync(imageDir, { recursive: true }); fs.mkdirSync(docDir, { recursive: true })
  const imagePath = path.join(imageDir, `rollout-${imageId}.jsonl`), docPath = path.join(docDir, `${documentId}.jsonl`)
  const pdf = Buffer.from('%PDF-1.4 e2e document bytes')
  fs.writeFileSync(imagePath, [
    { type: 'session_meta', timestamp, payload: { id: imageId, timestamp, cwd: root, source: 'cli' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `media fixture ${imageId}` }, { type: 'input_image', image_url: `data:image/png;base64,${TINY_PNG}` }] } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n')
  fs.writeFileSync(docPath, JSON.stringify({ type: 'user', sessionId: documentId, cwd: root, timestamp,
    message: { role: 'user', content: [{ type: 'text', text: `media fixture ${documentId}` }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }] } }) + '\n')
  try {
    for (const [id, mime, bytes] of [[imageId, 'image/png', Buffer.from(TINY_PNG, 'base64')], [documentId, 'application/pdf', pdf]] as const) {
      const endpoint = `/api/session-media/${id}/items`
      await expect.poll(async () => (await request.get(endpoint)).status(), { timeout: 60_000, intervals: [1000, 2000] }).toBe(200)
      await discover(request, id)
      const data = await (await request.get(endpoint)).json() as MediaPage
      expect(data.items).toHaveLength(1)
      const response = await request.get(data.items[0].url)
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toBe(mime)
      expect(await response.body()).toEqual(bytes)
      const invalid = new URL(data.items[0].url, 'http://localhost')
      invalid.searchParams.set('path', '/etc/hosts')
      expect((await request.get(invalid.pathname + invalid.search)).status()).toBe(400)
    }
  } finally {
    fs.rmSync(imagePath, { force: true }); fs.rmSync(docDir, { recursive: true, force: true })
  }
})

test('same-size transcript rewrites invalidate old cursors and immutable payload references', async ({ request }) => {
  const fixture = await mediaFixture(request, 80)
  try {
    // Matching can append a prompt after the first media-count publication.
    // Commit that tail before testing a same-size rewrite of the indexed file.
    await discover(request, fixture.sessionId)
    const first = await fixture.items()
    expect(first.nextCursor).not.toBeNull()
    const body = fs.readFileSync(fixture.logPath, 'utf8')
    const replacement = body.replace('Item 00079 ', 'Item 99999 ')
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(body))
    fs.writeFileSync(fixture.logPath, replacement)
    await discover(request, fixture.sessionId)
    const second = await fixture.items()
    expect(second.revision).not.toBe(first.revision)
    expect(second.items[0].label).toMatch(/^Item 99999 /)
    const stalePage = await request.get(`/api/session-media/${fixture.sessionId}/items?cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(stalePage.status()).toBe(409)
    const staleBytes = await request.get(first.items[0].url, { maxRedirects: 0 })
    expect(staleBytes.status()).toBe(409)
    const freshBytes = await request.get(second.items[0].url, { maxRedirects: 0 })
    expect(freshBytes.status()).toBe(302)
    expect(freshBytes.headers().location).toContain(`/00079`)
  } finally { fixture.cleanup() }
})

test('all 258 payloads in one transcript record remain addressable beyond the legacy index cap', async ({ request }) => {
  const fixture = await mediaFixture(request, 0)
  const bodies = Array.from({ length: 258 }, (_, index) => Buffer.from(`%PDF-1.4 single-record document ${index}`))
  try {
    fs.appendFileSync(fixture.logPath, JSON.stringify({
      type: 'assistant', sessionId: fixture.sessionId, timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: bodies.map(body => ({
        type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.toString('base64') },
      })) },
    }) + '\n')
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.total, { timeout: 30_000 }).toBe(258)
    const items: MediaPage['items'] = []
    let cursor: string | undefined
    do {
      const page = await fixture.items(cursor)
      expect(page.items.length).toBeLessThanOrEqual(40)
      items.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(items).toHaveLength(258)
    expect(items.map(item => Number(new URL(item.url, 'http://localhost').searchParams.get('index'))))
      .toEqual(Array.from({ length: 258 }, (_, n) => 257 - n))
    const last = items[0]
    const reference = new URL(last.url, 'http://localhost')
    expect(reference.searchParams.get('index')).toBe('257')
    expect(reference.searchParams.get('digest')).toMatch(/^[a-f0-9]{64}$/)
    const response = await request.get(last.url)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('application/pdf')
    expect(await response.body()).toEqual(bodies[257])
    reference.searchParams.delete('digest')
    expect((await request.get(reference.pathname + reference.search)).status()).toBe(400)
  } finally { fixture.cleanup() }
})
