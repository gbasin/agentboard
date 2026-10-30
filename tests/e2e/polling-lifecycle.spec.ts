import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { HistoryDetail, HistoryPage, SavedSession } from '../../src/shared/persistence'

// Real logs -> read worker -> match worker -> provider DB -> recurring catalog
// import -> HTTP/WebSocket -> browser. No route or worker mocks, DB seeding,
// external agent process, or performance thresholds.
test.describe.configure({ timeout: 90_000 })
test.use({ serviceWorkers: 'block' })

type Provider = 'claude' | 'codex'
function seed(provider: Provider) {
  const root = process.env.E2E_TMUX_TMPDIR
  if (!root) throw new Error('Private E2E directory is required')
  const id = randomUUID()
  // Metadata only: keep it unrelated to the bootstrap window's cwd so the
  // intentional no-message/booting-window deferral cannot hide the fixture.
  const project = `/agentboard-e2e-${id}`
  const logRoot = provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME
  if (!logRoot || !path.resolve(logRoot).startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Refusing to seed outside the isolated log directory')
  }
  const dir = provider === 'claude'
    ? path.join(logRoot, 'projects', project.replace(/[^a-zA-Z0-9-]/g, '-'))
    : path.join(logRoot, 'sessions', '2026', '10', '15')
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, provider === 'claude' ? `${id}.jsonl` : `rollout-2026-10-15T00-00-00-${id}.jsonl`)
  const append = (message: string) => {
    const timestamp = new Date().toISOString()
    fs.appendFileSync(log, JSON.stringify(provider === 'claude'
      ? { type: 'user', sessionId: id, cwd: project, timestamp, message: { role: 'user', content: message } }
      : { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] } }) + '\n')
  }
  if (provider === 'codex') {
    const timestamp = new Date().toISOString()
    fs.writeFileSync(log, JSON.stringify({ type: 'session_meta', timestamp, payload: { id, timestamp, cwd: project, source: 'cli' } }) + '\n')
  }
  const initial = `polling initial ${id} ${'preserve full message 🙂 '.repeat(110)}END-${id}`
  append(initial)
  return { id, project, log, initial, append }
}

async function findSaved(request: APIRequestContext, project: string, providerId: string) {
  let saved: SavedSession | undefined
  await expect.poll(async () => {
    const response = await request.get('/api/library', { params: { project, state: 'all' } })
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as HistoryPage
    const matches = body.sessions.filter((row) => row.providerId === providerId)
    expect(matches.length).toBeLessThanOrEqual(1)
    saved = matches[0]
    return Boolean(saved)
  }, { timeout: 45_000 }).toBe(true)
  return saved!
}

async function detail(request: APIRequestContext, id: string): Promise<HistoryDetail> {
  const response = await request.get(`/api/library/${id}`)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function expandHistory(page: Page) {
  const toggle = page.getByRole('button', { name: /^History \d+/ })
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  if (await page.locator('[title="Click to preview"]').count() === 0) await toggle.click()
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: discover after startup, import once, preserve rename, and refresh full messages`, async ({ page, request }, testInfo) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    const fixture = seed(provider)
    try {
      const saved = await findSaved(request, fixture.project, fixture.id)
      expect(saved.state).toBe('archived')
      // Summary APIs intentionally expose 250 characters; the preview below
      // must still render the full transcript, including its tail.
      const first = await detail(request, saved.id)
      expect(first.conversations.find((row) => row.sessionId === fixture.id)?.lastUserMessage).toBe(fixture.initial.slice(0, 250))
      const customName = `polling-custom-${fixture.id.slice(0, 8)}`
      const renamed = await request.patch(`/api/library/${saved.id}`, { data: { name: customName } })
      expect(renamed.ok()).toBeTruthy()

      const latest = `updated-${fixture.id} ${'full text 🦊 '.repeat(220)}TAIL-${fixture.id}`
      fixture.append(latest)
      await expect.poll(async () => (await detail(request, saved.id)).conversations
        .find((row) => row.sessionId === fixture.id)?.lastUserMessage, { timeout: 30_000 }).toBe(latest.slice(0, 250))
      await expandHistory(page)
      const row = page.locator('[title="Click to preview"]').filter({ hasText: customName })
      await expect(row).toBeVisible({ timeout: 15_000 })
      await expect(row).toContainText(`updated-${fixture.id}`)
      await row.click()
      await expect(page.getByRole('dialog')).toContainText(`TAIL-${fixture.id}`, { timeout: 15_000 })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()

      // A later import pass must keep the original catalog identity and name.
      const after = await findSaved(request, fixture.project, fixture.id)
      expect(after.id).toBe(saved.id)
      expect(after.name).toBe(customName)
      expect(after.preview).toBe(latest)
      await page.reload()
      await expandHistory(page)
      await expect(row).toBeVisible({ timeout: 15_000 })
      await expect(row).toContainText(`updated-${fixture.id}`)
      await row.click()
      await expect(page.getByRole('dialog')).toContainText(`TAIL-${fixture.id}`)
      await testInfo.attach(`${provider}-updated-preview`, { body: await page.screenshot(), contentType: 'image/png' })
    } finally {
      fs.rmSync(fixture.log, { force: true })
    }
  })
}

function privateTmux(args: string[]) {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (!dir) throw new Error('Private tmux directory is required')
  const env = { ...process.env }
  delete env.TMUX
  return spawnSync('tmux', ['-S', path.join(dir, `tmux-${process.getuid?.() ?? 0}`, 'default'), ...args], { env, encoding: 'utf-8' })
}

test('hibernation survives new log activity and a matching unclaimed window', async ({ page, request }, testInfo) => {
  const fixture = seed('claude')
  const session = process.env.E2E_TMUX_SESSION
  if (!session) throw new Error('Private tmux session is required')
  let target: string | undefined
  try {
    const saved = await findSaved(request, fixture.project, fixture.id)
    const name = `polling-sleep-${fixture.id.slice(0, 8)}`
    const response = await request.patch(`/api/library/${saved.id}`, { data: { name, state: 'hibernating' } })
    expect(response.ok()).toBeTruthy()
    await page.goto('/')
    const card = page.getByTestId('hibernating-session-card').filter({ hasText: name })
    const toggle = page.getByRole('button', { name: /^Hibernating \d+/ })
    await expect(toggle).toBeVisible({ timeout: 15_000 })
    if (await card.count() === 0) await toggle.click()
    await expect(card).toBeVisible()

    const prompt = `keep this session dormant ${fixture.id}`
    const created = privateTmux(['new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`, '-n', name,
      `printf '%s\\n' '❯ ${prompt}'; sleep 120`])
    expect(created.status, created.stderr).toBe(0)
    target = `${session}:${created.stdout.trim()}`
    // Positive message-update assertions prove that multiple actual polling
    // cycles completed; an idle/broken worker cannot pass this negative check.
    for (const suffix of ['first', 'second']) {
      const message = `${prompt} ${suffix}`
      const printed = privateTmux(['respawn-pane', '-k', '-t', target,
        `printf '%s\\n' '❯ ${message}'; sleep 120`])
      expect(printed.status, printed.stderr).toBe(0)
      fixture.append(message)
      await expect.poll(async () => (await detail(request, saved.id)).conversations
        .find((row) => row.sessionId === fixture.id)?.lastUserMessage, { timeout: 30_000 }).toBe(message)
      const current = await detail(request, saved.id)
      expect(current.session.state).toBe('hibernating')
      expect(current.session.window).toBeNull()
      expect(current.conversations.find((row) => row.sessionId === fixture.id)?.isHibernating).toBe(true)
      await expect(card).toBeVisible()
      await expect(card).toContainText(message)
      const live = await (await request.get('/api/sessions')).json() as { agentSessionId?: string }[]
      expect(live.some((row) => row.agentSessionId === fixture.id)).toBe(false)
    }
    await testInfo.attach('hibernated-after-log-updates', { body: await page.screenshot(), contentType: 'image/png' })
    // Positive control: the same window can reclaim the conversation once
    // the explicit hibernation flag is cleared. This catches a broken matcher
    // that would otherwise make all of the non-reclaim checks pass.
    const archived = await request.patch(`/api/library/${saved.id}`, { data: { state: 'archived' } })
    expect(archived.ok()).toBeTruthy()
    fixture.append(`${prompt} second`)
    await expect.poll(async () => {
      const live = await (await request.get('/api/sessions')).json() as { agentSessionId?: string }[]
      return live.some((row) => row.agentSessionId === fixture.id)
    }, { timeout: 30_000 }).toBe(true)
  } finally {
    if (target) privateTmux(['kill-window', '-t', target])
    fs.rmSync(fixture.log, { force: true })
  }
})
