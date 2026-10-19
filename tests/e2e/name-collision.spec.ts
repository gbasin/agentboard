import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { desktopSidebar, cardByName } from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })

// Real transcript discovery, database name checks, WebSocket rename, and tmux
// creation. The reserved name exists only in history, not in a live window.
test('archived names reject collisions and reserve names during window creation', async ({ page, request }) => {
  test.setTimeout(90_000)
  const root = process.env.E2E_TMUX_TMPDIR
  const logs = process.env.CLAUDE_CONFIG_DIR
  if (!root || !logs || !path.resolve(logs).startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Private E2E logs are required')
  }
  const tag = randomUUID()
  const windowProject = path.join(root, `name-window-${tag}`)
  fs.mkdirSync(windowProject, { recursive: true })
  const reserved = `reserved-${tag}x`
  const ids = [randomUUID(), randomUUID()]
  const project = `/name-collision-${tag}`
  const dir = path.join(logs, 'projects', project.replaceAll('/', '-'))
  fs.mkdirSync(dir, { recursive: true })
  for (const id of ids) {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({
      type: 'user', sessionId: id, cwd: project, timestamp: new Date().toISOString(),
      message: { role: 'user', content: `name fixture ${id}` },
    }) + '\n')
  }
  try {
    await expect.poll(async () => {
      const body = await (await request.get('/api/library', { params: { project, state: 'all' } })).json()
      return body.sessions.filter((s: { providerId: string }) => ids.includes(s.providerId)).length
    }, { timeout: 45_000 }).toBe(2)
    await page.goto('/')
    // Keep one socket so the second rename is ordered after the first result.
    const result = await page.evaluate(async ({ ids, reserved }) => {
      return new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
        let stage = 0
        const timer = setTimeout(() => { ws.close(); reject(new Error('rename timeout')) }, 15_000)
        ws.onopen = () => ws.send(JSON.stringify({ type: 'session-rename', sessionId: ids[0], newName: reserved }))
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (stage === 0 && msg.type === 'agent-sessions' && msg.history.some((s: { sessionId: string; displayName: string }) => s.sessionId === ids[0] && s.displayName === reserved)) {
            stage = 1
            ws.send(JSON.stringify({ type: 'session-rename', sessionId: ids[1], newName: reserved }))
          } else if (stage === 1 && msg.type === 'error') {
            clearTimeout(timer); ws.close(); resolve(msg.message)
          }
        }
      })
    }, { ids, reserved })
    expect(result).toBe('Name already exists')
    await desktopSidebar(page).locator('button[aria-label="New session"]').click()
    const dialog = page.locator('[aria-labelledby="new-session-title"]')
    await dialog.getByPlaceholder('Enter command...').fill('sh')
    await dialog.locator('input.flex-1').fill(windowProject)
    await dialog.getByPlaceholder('auto-generated').fill(reserved)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(cardByName(desktopSidebar(page), `${reserved}-2`).first()).toBeVisible({ timeout: 20_000 })
    const live = await (await request.get('/api/sessions')).json()
    expect(live.some((s: { name: string }) => s.name === reserved)).toBe(false)
    expect(live.some((s: { name: string }) => s.name === `${reserved}-2`)).toBe(true)
  } finally {
    // An unclaimed shell in a shared parent such as /tmp can defer another
    // test's transcript matching. Isolate its cwd and remove only our window.
    const env = { ...process.env }
    delete env.TMUX
    const socket = path.join(root, `tmux-${process.getuid?.() ?? 0}`, 'default')
    const listed = spawnSync('tmux', ['-S', socket, 'list-windows', '-a', '-F', '#{window_id}\t#{window_name}'], { env, encoding: 'utf-8' })
    for (const row of listed.stdout?.trim().split('\n') ?? []) {
      const [id, name] = row.split('\t')
      if (name === `${reserved}-2`) {
        spawnSync('tmux', ['-S', socket, 'kill-window', '-t', id], { env })
        break
      }
    }
    fs.rmSync(windowProject, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
