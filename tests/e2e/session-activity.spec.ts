// Real isolated tmux + logs + matching + tracker + WebSocket + browser.
// The pane prints a unique user message so ordinary transcript matching
// associates it; no injected activity frames or production state.
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { socketPath } from './tmuxReap'

const jsonl = (value: object) => JSON.stringify({ timestamp: new Date().toISOString(), ...value }) + '\n'
function tmux(args: string[]) {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (!dir || !process.env.E2E_TMUX_SESSION) throw new Error('Requires isolated E2E environment')
  const env = { ...process.env }
  delete env.TMUX
  const result = spawnSync('tmux', ['-S', socketPath(dir), ...args], { env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

test.describe.configure({ timeout: 120_000 })
for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: child activity updates independently and resumes`, async ({ page, request }) => {
    const root = process.env.E2E_TMUX_TMPDIR!
    const sessionId = randomUUID(), childId = randomUUID()
    const name = `activity-${kind}-${sessionId.slice(0, 8)}`
    const project = path.join(root, name)
    fs.mkdirSync(project)
    const prompt = `Inspect the activity fixture ${sessionId}`
    const textFile = path.join(project, 'prompt.txt')
    fs.writeFileSync(textFile, `${kind === 'claude' ? '❯' : '›'} ${prompt}\n`)
    const fixtureCli = path.join(project, kind)
    fs.writeFileSync(fixtureCli, `#!/bin/sh\ncat '${textFile}'\nsleep 600\n`, { mode: 0o755 })
    const windowId = tmux(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `=${process.env.E2E_TMUX_SESSION}`, '-n', name, '-c', project, fixtureCli])
    let log: string, child: string
    if (kind === 'claude') {
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', project.replace(/\//g, '-'))
      fs.mkdirSync(dir, { recursive: true })
      log = path.join(dir, `${sessionId}.jsonl`)
      fs.writeFileSync(log, jsonl({ type: 'user', sessionId, cwd: project, message: { role: 'user', content: prompt } }) + jsonl({ type: 'api-request' }))
      const childDir = path.join(dir, sessionId, 'subagents')
      fs.mkdirSync(childDir, { recursive: true })
      child = path.join(childDir, `agent-${childId}.jsonl`)
      fs.writeFileSync(child, jsonl({ type: 'assistant', sessionId, agentId: childId, isSidechain: true, cwd: project, message: { content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'private command must not appear' } }] } }))
      fs.writeFileSync(child.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'Review activity parser' }))
    } else {
      const dir = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '10', '30')
      fs.mkdirSync(dir, { recursive: true })
      log = path.join(dir, `rollout-${sessionId}.jsonl`)
      fs.writeFileSync(log, jsonl({ type: 'session_meta', payload: { id: sessionId, cwd: project, source: 'cli' } }) + jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }) + jsonl({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'main1' } }))
      child = path.join(dir, `rollout-${childId}.jsonl`)
      fs.writeFileSync(child, jsonl({ type: 'session_meta', payload: { id: childId, cwd: project, source: { subagent: { thread_spawn: { parent_thread_id: sessionId, agent_path: '/root/review-parser' } } } } }) + jsonl({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child1' } }) + jsonl({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'exec1', name: 'exec', input: 'secret body' } }))
    }
    try {
      await page.goto('/')
      const card = page.getByTestId('session-card').filter({ hasText: name }).first()
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => {
        const sessions = await (await request.get('/api/sessions')).json()
        return sessions.find((s: { name: string }) => s.name === name)?.activity?.running
      }, { timeout: 60_000 }).toBe(1)
      const activity = card.getByTestId('session-activity')
      await expect(activity).toContainText('1 running')
      await activity.getByRole('button').click()
      await expect(activity.getByRole('list')).toContainText(kind === 'claude' ? 'Review activity parser' : '/root/review-parser')
      await expect(activity).toContainText(kind === 'claude' ? 'Tool pending: Bash' : 'Tool pending: exec')
      await expect(activity).not.toContainText('secret body')
      const complete = kind === 'claude'
        ? { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }
        : { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child1' } }
      fs.appendFileSync(child, jsonl(complete))
      await expect(activity).toContainText('1 finished', { timeout: 20_000 })
      const restart = kind === 'claude' ? { type: 'api-request' } : { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child2' } }
      fs.appendFileSync(child, jsonl(restart))
      await expect(activity).toContainText('1 running', { timeout: 20_000 })
      await page.screenshot({ path: `artifacts/activity-designs/${kind}-live-desktop.png` })
      await card.click({ position: { x: 100, y: 12 } })
      await page.setViewportSize({ width: 390, height: 844 })
      const drawerButton = page.getByLabel('Open session menu', { exact: true })
      if (await drawerButton.isVisible()) await drawerButton.click()
      await expect(page.locator('.session-drawer.open')).toBeVisible()
      await expect.poll(async () => (await page.locator('.session-drawer.open').boundingBox())?.x ?? -999).toBeGreaterThanOrEqual(-1)
      const mobileCard = page.locator('[data-testid="session-card"]:visible').filter({ hasText: name }).first()
      await expect(mobileCard.getByTestId('session-activity')).toContainText('1 running')
      await page.screenshot({ path: `artifacts/activity-designs/${kind}-live-mobile.png` })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      // Server evidence remains available after the mobile layout remount.
      await expect.poll(async () => {
        const sessions = await (await request.get('/api/sessions')).json()
        return sessions.find((s: { name: string }) => s.name === name)?.activity?.running
      }).toBe(1)
    } finally {
      tmux(['kill-window', '-t', windowId])
    }
  })
}
