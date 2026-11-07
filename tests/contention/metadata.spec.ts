import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

test.use({ serviceWorkers: 'block' })
test.setTimeout(90_000)

function tmux(args: string[]) {
  const root = process.env.E2E_TMUX_TMPDIR!
  const env = { ...process.env }
  delete env.TMUX
  const result = spawnSync(process.env.AB_REAL_TMUX!, ['-S', path.join(root, `tmux-${process.getuid?.() ?? 0}`, 'default'), ...args], { env, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

test('metadata stalls leave terminal input responsive and publish fresh PR/media without losing session state', async ({ page, request }, testInfo) => {
  const root = process.env.E2E_TMUX_TMPDIR!
  const gate = process.env.AB_METADATA_GATE!
  if (!root || !gate) throw new Error('Run with playwright.contention.config.ts')
  const id = randomUUID(), marker = `metadata-${id}`
  const project = path.join(root, marker)
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', project.replace(/[^a-zA-Z0-9-]/g, '-'))
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, `${id}.jsonl`)
  const session = process.env.E2E_TMUX_SESSION!
  const window = `${session}:${tmux(['new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`, '-n', marker, '-c', project,
    `printf '❯ ${marker}\\n⏺ ack\\n'; exec /bin/sh`])}`
  const rows = async () => (await (await request.get('/api/sessions')).json()) as Array<{
    id: string; name: string; agentSessionId?: string; boardSessionId?: string; lastUserMessage?: string;
    prs?: { number: number }[]; media?: unknown; mediaSummary?: { total: number; links: number; revision: string };
  }>
  const current = async () => (await rows()).find((row) => row.id === window)
  const pr = (number: number) => JSON.stringify({ type: 'pr-link', sessionId: id, prUrl: `https://github.com/agentboard-regression/fixture/pull/${number}`, prRepository: 'agentboard-regression/fixture', prNumber: number }) + '\n'
  const user = () => JSON.stringify({ type: 'user', sessionId: id, cwd: project, timestamp: new Date().toISOString(), message: { role: 'user', content: marker } }) + '\n'
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await expect.poll(async () => Boolean(await current()), { timeout: 20_000 }).toBe(true)
    fs.writeFileSync(log, user() + pr(11))
    await expect.poll(async () => (await current())?.agentSessionId, { timeout: 35_000 }).toBe(id)
    await expect.poll(async () => (await current())?.prs?.map((pr) => pr.number)).toEqual([11])
    await page.addInitScript(() => localStorage.setItem('agentboard-settings', JSON.stringify({ state: { useWebGL: false }, version: 8 })))
    let savedId: string | undefined
    await expect.poll(async () => {
      savedId = (await current())?.boardSessionId
      return Boolean(savedId)
    }, { timeout: 20_000 }).toBe(true)
    await page.goto('/')
    const card = page.locator(`[data-testid="session-card"][data-session-id="${window}"]`)
    await expect(card).toBeVisible()
    await card.click()
    await expect(page.locator('.xterm-rows')).toContainText('ack')
    await expect(page.getByTestId('media-rail-pill')).toBeVisible()

    for (const file of ['arm', 'held', 'started', 'release']) fs.rmSync(path.join(gate, file), { force: true })
    fs.writeFileSync(path.join(gate, 'arm'), log)
    fs.appendFileSync(log, JSON.stringify({ type: 'frame-link', sessionId: id, frameUrl: 'https://example.com/metadata-first', title: 'metadata first' }) + '\n')
    await expect.poll(() => fs.existsSync(path.join(gate, 'started')), { timeout: 10_000 }).toBe(true)
    const started = JSON.parse(fs.readFileSync(path.join(gate, 'started'), 'utf8'))
    let detailFinished = false
    const detail = request.get(`/api/library/${savedId}`).then(async (response) => {
      expect(response.ok()).toBe(true)
      detailFinished = true
      return response.json()
    })
    let releasedAt = 0
    releaseTimer = setTimeout(() => {
      releasedAt = Date.now()
      fs.writeFileSync(path.join(gate, 'release'), '')
    }, 1500)
    const token = `RENDERED${Date.now()}`
    const health = request.get('/api/health').then((response) => { expect(response.ok()).toBe(true); return Date.now() })
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type(`printf '%s%s\\n' 'DONE' '${token}'`)
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText(`DONE${token}`)
    const renderedAt = Date.now(), healthAt = await health
    expect(releasedAt === 0 || renderedAt < releasedAt).toBe(true)
    expect(releasedAt === 0 || healthAt < releasedAt).toBe(true)
    expect(started.isMainThread).toBe(false)
    expect(detailFinished).toBe(false)
    // Mutate live session state while metadata is still in flight.
    clearTimeout(releaseTimer)
    expect((await request.patch(`/api/library/${savedId}`, { data: { name: `${marker}-renamed` } })).ok()).toBe(true)
    fs.writeFileSync(path.join(gate, 'release'), '')
    clearTimeout(releaseTimer)
    const detailResult = await detail
    expect(detailResult.session.name).toBe(`${marker}-renamed`)
    const conversation = detailResult.conversations.find((row: { sessionId: string }) => row.sessionId === id)
    expect(conversation.displayName).toBe(`${marker}-renamed`)
    expect(conversation).not.toHaveProperty('media')
    await expect.poll(async () => (await current())?.mediaSummary?.links).toBe(1)
    const items = await request.get(`/api/session-media/${id}/items?kind=links`).then(r => r.json())
    expect(items.items[0].externalUrl).toBe('https://example.com/metadata-first')
    await expect(page.getByTestId('media-rail-pill')).toBeVisible()
    await page.getByTestId('media-rail-pill').click()
    await page.getByTestId('media-rail').getByRole('button', { name: 'Links 1', exact: true }).click()
    await expect(page.getByTestId('media-rail').getByRole('link', { name: /metadata first/ })).toBeVisible()
    await expect.poll(async () => (await current())?.name).toBe(`${marker}-renamed`)
    expect((await current())?.agentSessionId).toBe(id)
    await testInfo.attach('metadata-arrival', { body: await page.screenshot(), contentType: 'image/png' })

    // The DB size cannot distinguish these equal-length rewrites.
    const rewritten = fs.readFileSync(log, 'utf8').replace('pull/11', 'pull/22').replace('"prNumber":11', '"prNumber":22').replace('metadata-first', 'metadata-other').replace('metadata first', 'metadata other')
    fs.writeFileSync(log, rewritten)
    await expect.poll(async () => (await current())?.prs?.map((pr) => pr.number), { timeout: 10_000 }).toEqual([22])
    await page.getByTestId('media-rail').getByRole('button', { name: 'Refresh media', exact: true }).click()
    await expect(page.getByTestId('media-rail').getByRole('link', { name: /metadata other/ })).toBeVisible()
    await expect(page.getByTestId('media-rail').getByRole('link', { name: /metadata first/ })).toHaveCount(0)

    const children = path.join(dir, id, 'subagents')
    fs.mkdirSync(children, { recursive: true })
    fs.writeFileSync(path.join(children, 'agent-child.jsonl'), pr(33))
    await expect.poll(async () => (await current())?.prs?.map((pr) => pr.number), { timeout: 10_000 }).toEqual([22, 33])
    fs.rmSync(children, { recursive: true })
    fs.writeFileSync(log, user())
    await expect.poll(async () => ({ prs: (await current())?.prs, total: (await current())?.mediaSummary?.total }), { timeout: 10_000 }).toEqual({ prs: [], total: 0 })
    expect(await current()).not.toHaveProperty('media')
    await page.getByTestId('media-rail').getByRole('button', { name: 'Refresh media', exact: true }).click()
    await expect(page.getByTestId('media-rail')).toContainText('No web links in this session yet.')
    expect((await current())?.lastUserMessage).toBe(marker)
    await testInfo.attach('metadata-terminal-timeline', { body: JSON.stringify({ started, renderedAt, healthAt }), contentType: 'application/json' })
    await testInfo.attach('metadata-correctness', { body: await page.screenshot(), contentType: 'image/png' })
  } finally {
    clearTimeout(releaseTimer)
    fs.writeFileSync(path.join(gate, 'release'), '')
    tmux(['kill-window', '-t', window])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
