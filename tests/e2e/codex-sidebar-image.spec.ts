// Replay the Codex sidebar through a real tmux pane and the browser renderer.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { activityLine, seedActivity } from './helpers/activityFixture'
import { TINY_PNG } from './helpers/mediaFixture'
import { socketPath } from './tmuxReap'
import { sanitizedTmuxEnv } from '../../src/server/tmuxEnv'

test('Codex file viewer displays a linked image and removes it when the pane closes', async ({ page, request }) => {
  test.skip(process.env.ACTIVITY_E2E_MATRIX !== '1', 'Requires private transcript matching')
  const f = seedActivity('codex')
  try {
    await page.goto('/')
    const card = page.getByTestId('session-card').filter({ hasText: f.name }).first()
    await expect.poll(async () => {
      const sessions = await (await request.get('/api/sessions')).json()
      if (sessions.some((s: { agentSessionId: string }) => s.agentSessionId === f.sessionId)) return true
      f.refreshPrompt()
      return false
    }, { timeout: 45_000 }).toBe(true)
    await card.click()
    const file = path.join(f.project, 'live-board.png')
    fs.writeFileSync(file, Buffer.from(TINY_PNG, 'base64'))
    const link = (file: string) => activityLine({ type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '[Live board screenshot](<' + file + '>)' }] } })
    fs.appendFileSync(f.log, link(file))
    const endpoint = '/api/session-output/' + f.sessionId + '/sidebar-image?name='
    expect((await request.get(endpoint + 'unlinked.png')).status()).toBe(404)
    const tty = execFileSync('tmux', ['-S', socketPath(process.env.E2E_TMUX_TMPDIR!), 'display-message', '-p',
      '-t', process.env.E2E_TMUX_SESSION + ':' + f.name, '#{pane_tty}'], { encoding: 'utf8', env: sanitizedTmuxEnv() }).trim()
    const frame = '\x1b[H\x1b[2J\x1b[1;24H│ notes.md× \x1b[1mlive-board.png\x1b[0m× +\x1b[2;24H│ PNG · 96 × 48\x1b[3;24H│ Image preview unavailable in this terminal'
    const img = page.getByRole('img', { name: 'live-board.png', exact: true })
    await expect.poll(async () => {
      fs.writeFileSync(tty, frame)
      return img.isVisible()
    }, { timeout: 15_000 }).toBe(true)
    expect(await img.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(96)
    fs.writeFileSync(tty, '\x1b[H\x1b[2J')
    await expect(img).toHaveCount(0)
    fs.appendFileSync(f.log, link(path.join(f.project, 'other', 'live-board.png')))
    expect((await request.get(endpoint + 'live-board.png')).status()).toBe(404)
  } finally { f.stop() }
})
