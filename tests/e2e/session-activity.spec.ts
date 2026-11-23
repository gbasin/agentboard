// Complete log -> private tmux association -> worker -> WS -> actual UI path.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { seedActivity, activityLine } from './helpers/activityFixture'

// Real fixture processes have no harness ownership files. Exercise the existing
// text-association fallback explicitly; no session/activity WS frames are mocked.
test.describe.configure({ timeout: 90_000 })
test.skip(process.env.ACTIVITY_E2E_MATRIX !== '1', 'Lifecycle fixtures run in the isolated activity matrix with temporary-path matching enabled')
for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: independent child completion, resume, main activity and mobile popover`, async ({ page, request }, info) => {
    const fixture = seedActivity(kind)
    const associationPath = info.outputPath('fixture-association.json')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const observed: { at: string; type: string; running: number; phase: string }[] = []
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload))
        const rows = frame.sessions ?? (frame.session ? [frame.session] : [])
        const s = rows.find((s: { name: string }) => s.name === fixture.name)
        if (s?.activity) observed.push({ at: new Date().toISOString(), type: frame.type, running: s.activity.running, phase: s.activity.main.phase })
      } catch { /* terminal/binary frames */ }
    }))
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/')
      const card = page.locator('[data-testid="session-card"]:visible').filter({ hasText: fixture.name }).first()
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => {
        const sessions = await (await request.get('/api/sessions')).json()
        const session = sessions.find((s: { name: string }) => s.name === fixture.name)
        fs.writeFileSync(associationPath, JSON.stringify({ session, terminal: fixture.capture(),
          parentLog: fs.readFileSync(fixture.log, 'utf8'), childLog: fs.readFileSync(fixture.child, 'utf8'),
        }, null, 2))
        if (session?.agentSessionId !== fixture.sessionId) fixture.refreshPrompt()
        return session?.activity?.running
      }, { timeout: 60_000 }).toBe(1)
      const trigger = card.getByTestId('session-activity-counter')
      await expect(trigger).toHaveText('+1')
      const height = (await card.boundingBox())!.height
      await trigger.click()
      const popover = page.getByTestId('session-activity-popover')
      await expect(popover).toContainText(kind === 'claude' ? 'Review activity parser' : '/root/review-parser')
      await expect(popover).toContainText(kind === 'claude' ? 'Tool pending: Bash' : 'Tool pending: exec')
      await expect(popover).not.toContainText('secret body')
      await expect(popover).not.toContainText('private command')
      expect((await card.boundingBox())!.height).toBeCloseTo(height, 2)
      const parentBefore = fs.readFileSync(fixture.log, 'utf8')
      fixture.append(kind === 'claude'
        ? { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }
        : { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child1' } })
      await expect(popover).toContainText('0 running', { timeout: 20_000 })
      await expect(trigger).toHaveText('+0')
      expect(fs.readFileSync(fixture.log, 'utf8')).toBe(parentBefore)
      fixture.append(kind === 'claude' ? { type: 'api-request' } : { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child2' } })
      await expect(popover).toContainText('1 running', { timeout: 20_000 })
      await expect(trigger).toHaveText('+1')
      await page.screenshot({ path: info.outputPath(`${kind}-desktop.png`) })
      await page.keyboard.press('Escape')
      await expect(popover).toBeHidden()
      await expect(trigger).toBeFocused()
      // Main-only changes publish without inventing a child change.
      fs.appendFileSync(fixture.log, activityLine(kind === 'claude'
        ? { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'main-tool', name: 'Read', input: {} }] } }
        : { type: 'response_item', payload: { type: 'function_call', call_id: 'main-tool', name: 'read_file' } }))
      await card.getByTestId('session-activity-status').click()
      await expect(popover).toContainText(kind === 'claude' ? 'Tool pending: Read' : 'Tool pending: read_file', { timeout: 20_000 })
      await popover.getByRole('button', { name: 'Close activity' }).click()
      await card.click({ position: { x: 100, y: 12 } })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByLabel('Open session menu', { exact: true }).click()
      await expect.poll(async () => (await page.locator('.session-drawer.open').boundingBox())?.x ?? -999).toBeGreaterThanOrEqual(-1)
      const mobileCard = page.locator('.session-drawer [data-testid="session-card"]').filter({ hasText: fixture.name }).first()
      await mobileCard.getByTestId('session-activity-counter').click()
      await expect(popover).toBeVisible()
      await expect(popover).toContainText('Main session')
      const box = (await popover.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(box.y + box.height).toBeLessThanOrEqual(844)
      await page.screenshot({ path: info.outputPath(`${kind}-mobile.png`) })
      expect(errors).toEqual([])
      expect(observed.some(s => s.running === 0)).toBe(true)
      expect(observed.some(s => s.running === 1)).toBe(true)
      await info.attach('activity-lifecycle-observations', { body: JSON.stringify({ kind, windowSize: fixture.windowSize, parentUnchangedDuringCompletion: true, observed, errors }, null, 2), contentType: 'application/json' })
    } catch (error) {
      // Preserve the association evidence before private tmux/data teardown.
      try {
        await info.attach('fixture-association', { path: associationPath, contentType: 'application/json' })
      } catch { /* retain the original assertion failure */ }
      throw error
    } finally { fixture.stop() }
  })
}

test('Claude parked continuation rebinds identity, prompt and children; unpark restores the original', async ({ page, request }, info) => {
  test.skip(process.platform !== 'darwin', 'Process ownership matching is enabled only on macOS')
  // Two ownership transitions use the production 30-second observation cadence.
  test.setTimeout(150_000)
  const fixture = seedActivity('claude', true)
  const { randomUUID } = await import('node:crypto')
  const path = await import('node:path')
  const nextId = randomUUID(), jobId = nextId.slice(0, 8)
  const nextLog = path.join(path.dirname(fixture.log), nextId + '.jsonl')
  const childDir = path.join(path.dirname(fixture.log), nextId, 'subagents')
  const jobDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'jobs', jobId)
  const prompt = 'Continue the parked fixture'
  const session = async () => (await (await request.get('/api/sessions')).json()).find((s: { name: string }) => s.name === fixture.name)
  try {
    await page.goto('/')
    await expect.poll(async () => (await session())?.agentSessionId, { timeout: 60_000 }).toBe(fixture.sessionId)
    const card = page.locator('[data-testid="session-card"]:visible').filter({ hasText: fixture.name }).first()
    await expect(card.getByTestId('session-activity-counter')).toHaveText('+1', { timeout: 20_000 })
    await card.getByTestId('session-activity-counter').click()
    const popup = page.getByTestId('session-activity-popover')
    fixture.append({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
    await expect(popup).toContainText('Interrupted', { timeout: 20_000 })
    await expect.poll(async () => (await session())?.activity?.unknown).toBe(0)
    fixture.append({ type: 'api-request' })
    await expect(popup).toContainText('1 running', { timeout: 20_000 })
    await page.keyboard.press('Escape')

    fs.mkdirSync(childDir, { recursive: true })
    fs.mkdirSync(jobDir, { recursive: true })
    fs.writeFileSync(nextLog, activityLine({ type: 'user', sessionId: nextId, cwd: fixture.project, message: { role: 'user', content: prompt } }))
    for (const name of ['one', 'two']) {
      fs.writeFileSync(path.join(childDir, `agent-${name}.jsonl`), activityLine({ type: 'api-request' }))
    }
    fs.writeFileSync(path.join(jobDir, 'state.json'), JSON.stringify({ template: 'bg', daemonShort: jobId, sessionId: nextId }))
    fs.appendFileSync(fixture.log, activityLine({ type: 'continued-in', sessionId: fixture.sessionId, continuedInSessionId: nextId }))
    fixture.park(jobId)
    await expect.poll(async () => (await session())?.agentSessionId, { timeout: 60_000 }).toBe(nextId)
    await expect.poll(async () => {
      const s = await session()
      return { path: s?.logFilePath, prompt: s?.lastUserMessage, running: s?.activity?.running, total: s?.activity?.total }
    }, { timeout: 30_000 }).toEqual({ path: nextLog, prompt, running: 2, total: 2 })
    await expect(card.getByTestId('session-activity-counter')).toHaveText('+2')
    await card.getByTestId('session-activity-counter').click()
    await expect(popup).toContainText('2 running')
    await page.screenshot({ path: info.outputPath('claude-parked-desktop.png') })
    await info.attach('parked-session', { body: JSON.stringify(await session(), null, 2), contentType: 'application/json' })
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Open session menu', { exact: true }).click()
    const mobile = page.locator('.session-drawer [data-testid="session-card"]').filter({ hasText: fixture.name }).first()
    await mobile.getByTestId('session-activity-counter').click()
    await expect(popup).toContainText('2 running')
    await page.screenshot({ path: info.outputPath('claude-parked-mobile.png') })
    await page.keyboard.press('Escape')
    // Historical continued-in remains present: only the current parked link
    // authorizes rebinding, so resuming the original cannot redirect again.
    fixture.park(null)
    await expect.poll(async () => (await session())?.agentSessionId, { timeout: 60_000 }).toBe(fixture.sessionId)
    await expect.poll(async () => (await session())?.activity?.running, { timeout: 20_000 }).toBe(1)
  } catch (error) {
    await info.attach('parked-association-failure', {
      body: JSON.stringify({ session: await session(), terminal: fixture.capture() }, null, 2),
      contentType: 'application/json',
    })
    throw error
  } finally { fixture.stop() }
})

test('Claude activity retains completed children outside the read cap and detects a resume', async ({ page, request }, info) => {
  const fixture = seedActivity('claude')
  const childDir = dirname(fixture.child)
  const ended = { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }
  const started = { type: 'api-request' }
  const writeChild = (name: string, activity: object) => fs.writeFileSync(join(childDir, `agent-${name}.jsonl`), activityLine(activity))
  try {
    for (let index = 0; index < 255; index++) writeChild(`worker-${index}`, ended)
    await page.goto('/')
    const card = page.locator('[data-testid="session-card"]:visible').filter({ hasText: fixture.name }).first()
    const counter = card.getByTestId('session-activity-counter')
    const popover = page.getByTestId('session-activity-popover')
    await expect.poll(async () => {
      const sessions = await (await request.get('/api/sessions')).json()
      const session = sessions.find((s: { name: string }) => s.name === fixture.name)
      if (session?.agentSessionId !== fixture.sessionId) fixture.refreshPrompt()
      return session?.activity?.total
    }, { timeout: 30_000 }).toBe(256)
    await expect(counter).toHaveText('+1')
    await counter.click()
    await expect(popover).toContainText('Review activity parser')

    fixture.append(ended)
    const oldTime = (Date.now() - 60_000) / 1000
    fs.utimesSync(fixture.child, oldTime, oldTime)
    await expect(counter).toHaveText('+0', { timeout: 20_000 })
    await expect(popover).toContainText('Review activity parser')
    // More than a hot set of fresh logs pushes the finished child to the slow scan.
    for (let index = 0; index < 16; index++) writeChild(`recent-worker-${index}`, ended)
    writeChild('new-worker', started)
    await expect(counter).toHaveText('+1', { timeout: 20_000 })
    await expect(counter).toHaveAttribute('aria-label', 'Show subagents: 1 running')
    await expect(popover.getByRole('heading', { name: 'Subagents 273' })).toBeVisible()
    await expect(popover.getByText('new-worker', { exact: true })).toBeVisible()

    fixture.append(started)
    await expect(counter).toHaveText('+2', { timeout: 45_000 })
    await expect(counter).toHaveAttribute('aria-label', 'Show subagents: 2 running')
    await expect(popover.getByText('Review activity parser', { exact: true })).toBeVisible()
    await expect(popover.getByText('new-worker', { exact: true })).toBeVisible()
    await expect(popover.getByText('2 running', { exact: true })).toBeVisible()
    await info.attach('resumed-subagent', { body: await page.screenshot({ path: info.outputPath('resumed-subagent.png') }), contentType: 'image/png' })
  } finally { fixture.stop() }
})

test('Antigravity associates the parent, updates delegated work, and serves child images', async ({ page, request }, info) => {
  const fixture = seedActivity('antigravity')
  try {
    await page.goto('/')
    const card = page.getByTestId('session-card').filter({ hasText: fixture.name }).first()
    await expect.poll(async () => {
      const rows = await (await request.get('/api/sessions')).json()
      const row = rows.find((s: { name: string }) => s.name === fixture.name)
      if (row?.agentSessionId !== fixture.sessionId) fixture.refreshPrompt()
      return row?.activity?.running
    }, { timeout: 60_000 }).toBe(1)
    await card.getByTestId('session-activity-counter').click()
    const popover = page.getByTestId('session-activity-popover')
    await expect(popover).toContainText('research')
    await expect(popover).toContainText('Tool pending: read_file')
    await expect(popover).not.toContainText('secret body')
    const { TINY_PNG } = await import('./helpers/mediaFixture')
    const { pathToFileURL } = await import('node:url')
    const file = join(dirname(fixture.child), 'media', 'step_2_media_0.png')
    fs.mkdirSync(dirname(file))
    fs.writeFileSync(file, Buffer.from(TINY_PNG, 'base64'))
    fixture.append({ type: 'GENERIC', source: 'MODEL', status: 'DONE', step_index: 2,
      media: [{ mime_type: 'image/png', uri: pathToFileURL(file).href }] })
    fixture.append({ type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', step_index: 3, content: 'Finished.' })
    await expect(popover).toContainText('0 running', { timeout: 20_000 })
    const endpoint = '/api/session-media/' + fixture.sessionId + '/items'
    expect((await request.get(endpoint + '?stream=1')).ok()).toBe(true)
    const { items } = await (await request.get(endpoint)).json()
    const image = items.find((item: { kind: string }) => item.kind === 'image')
    expect(image).toBeDefined()
    expect(await (await request.get(image.url)).body()).toEqual(Buffer.from(TINY_PNG, 'base64'))
    expect((await request.get(image.url + '&thumbnail=1')).headers()['content-type']).toBe('image/png')
    await page.screenshot({ path: info.outputPath('antigravity-activity.png') })
    fs.writeFileSync(file, 'changed since indexing')
    expect((await request.get(image.url)).status()).toBe(409)
    expect((await request.get(image.url + '&thumbnail=1')).status()).toBe(409)
  } finally { fixture.stop() }
})

test('Antigravity hibernates and wakes in its workspace with the same conversation and child', async ({ page, request }) => {
  // The summary has a parent and child but no workspace URI at hibernate time.
  const fixture = seedActivity('antigravity', false, false)
  const card = page.getByTestId('session-card').filter({ hasText: fixture.name }).first()
  const session = async () => {
    const rows = await (await request.get('/api/sessions')).json()
    return rows.find((row: { name: string }) => row.name === fixture.name)
  }
  const hibernate = async () => {
    await page.getByRole('button', { name: 'Session actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Hibernate', exact: true }).click()
    await expect.poll(session).toBeUndefined()
  }
  try {
    await page.goto('/')
    await expect.poll(async () => {
      const row = await session()
      if (!row?.agentSessionId) fixture.refreshPrompt()
      return row?.agentSessionId
    }, { timeout: 60_000 }).toBe(fixture.sessionId)
    const original = await session()
    await card.click()
    await hibernate()
    await page.locator('footer').getByRole('button', { name: 'Wake', exact: true }).click()
    const marker = join(fixture.project, 'resumed-id')
    await expect.poll(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8')).toBe(fixture.sessionId)
    await expect.poll(session).toMatchObject({
      agentSessionId: fixture.sessionId,
      projectPath: original.projectPath,
      activity: { subagents: [{ name: 'research', id: original.activity.subagents[0].id }] },
    })
    expect((await session()).id).not.toBe(original.id)
    await hibernate()
  } finally { fixture.stop() }
})
