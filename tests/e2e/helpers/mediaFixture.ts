/** Real transcript + private tmux fixture. No server responses are synthesized. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import type { MediaPage, MediaSummary } from '../../../src/shared/media'

export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAYAAADuFn/PAAAA00lEQVR4nO3XQRHDQBADQUMJBEMJxMDy00xsGJIq/RCB2brT6Dh/97Oc6/OdzpEG6AAFEL2AApC+oNGk/3AdUABRCReAZEGjoaEOoITjJsOCCkDS0AKYdsBg0iXKggog0tACkHbAaAwxB1DCcZNhQQUgaWgBTDtgMOkSZUEFEGloAUg7YDSGmAMo4bjJsKACkDS0AKYdMJh0ibKgAog0tACkHTAaQ8wBlHDcZFhQAUgaWgDTDhhMukRZUAFEGloA0g4YjSHmAEo4bjIsqADk+aca+gJtWqiVzVBm3gAAAABJRU5ErkJggg=='
export interface MediaSession {
  id: string
  name: string
  agentSessionId?: string
  mediaSummary?: MediaSummary
  media?: unknown[]
}
function tmux(...args: string[]) {
  const root = process.env.E2E_TMUX_TMPDIR
  if (!root || !process.env.E2E_TMUX_SESSION) throw new Error('Private E2E tmux environment required')
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE
  const result = spawnSync('tmux', ['-S', path.join(root, `tmux-${process.getuid!()}`, 'default'), ...args], { env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
export async function mediaFixture(request: APIRequestContext, count: number, image = false, options: { waitForSummary?: boolean; textBytes?: number } = {}) {
  const root = process.env.E2E_TMUX_TMPDIR, claude = process.env.CLAUDE_CONFIG_DIR
  if (!root || !claude) throw new Error('Private E2E transcript directories required')
  const sessionId = randomUUID(), name = `media-${sessionId.slice(0, 8)}`
  const project = path.join(root, name), logDir = path.join(claude, 'projects', name)
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(logDir, { recursive: true })
  const marker = `media fixture ${sessionId}`
  const windowId = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${process.env.E2E_TMUX_SESSION}:`, '-n', name, '-c', project,
    `printf '❯ ${marker}\\n⏺ ack\\n'; exec cat`)
  const logPath = path.join(logDir, `${sessionId}.jsonl`)
  const find = async () => ((await (await request.get('/api/sessions')).json()) as MediaSession[]).find(s => s.name === name)
  const prompt = () => JSON.stringify({ type: 'user', sessionId, cwd: project, timestamp: new Date().toISOString(), message: { role: 'user', content: marker } }) + '\n'
  const link = (i: number) => JSON.stringify({ type: 'frame-link', sessionId, cwd: project,
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    frameUrl: `https://example.com/${sessionId}/${String(i).padStart(5, '0')}`,
    title: `Item ${String(i).padStart(5, '0')} ${'fixture '.repeat(24)}` }) + '\n'
  try {
    await expect.poll(async () => Boolean(await find()), { timeout: 30_000 }).toBe(true)
    let body = prompt()
    if (image) body += JSON.stringify({ type: 'user', sessionId, cwd: project, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } }] },
      toolUseResult: { file: { dimensions: { originalWidth: 96, originalHeight: 48 } } } }) + '\n'
    for (let i = 0; i < count; i++) body += link(i)
    if (options.textBytes) body += JSON.stringify({ type: 'assistant', sessionId, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(options.textBytes) }] } }) + '\n'
    fs.writeFileSync(logPath, body)
    await expect.poll(async () => {
      const found = await find()
      if (found?.agentSessionId !== sessionId) fs.appendFileSync(logPath, prompt())
      return found?.agentSessionId === sessionId ? options.waitForSummary === false ? true : found.mediaSummary?.total : undefined
    }, { timeout: 120_000, intervals: [1000, 2000, 4000] }).toBe(options.waitForSummary === false ? true : count + (image ? 1 : 0))
  } catch (error) {
    try { tmux('kill-window', '-t', windowId) } finally {
      fs.rmSync(logDir, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true })
    }
    throw error
  }
  return {
    sessionId, name, logPath, windowId, find,
    async select(page: Page) {
      const session = (await find())!
      const card = page.locator(`[data-testid="session-card"][data-session-id="${session.id}"]:visible`).first()
      await expect(card).toBeVisible({ timeout: 30_000 }); await card.click()
      await expect(page.getByTestId('media-rail-pill')).toBeVisible()
    },
    append(i: number) { fs.appendFileSync(logPath, link(i)) },
    // Join soft wraps: a viewport resize must not look like terminal input.
    capture() { return tmux('capture-pane', '-p', '-J', '-t', windowId, '-S', '-100') },
    async items(cursor?: string): Promise<MediaPage> {
      const response = await request.get(`/api/session-media/${sessionId}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(response.status()).toBe(200)
      expect((await response.body()).byteLength).toBeLessThanOrEqual(64 * 1024)
      return await response.json() as MediaPage
    },
    cleanup() {
      try { tmux('kill-window', '-t', windowId) } finally {
        fs.rmSync(logDir, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true })
      }
    },
  }
}
