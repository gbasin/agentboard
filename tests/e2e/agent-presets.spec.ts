import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import type { SyncedCommandPreset } from '../../src/shared/syncedSettings'
import { socketPath } from './tmuxReap'

async function selectPreset(page: Page, label: string, command: string) {
  await page.goto('/')
  await expect(page.getByTestId('session-card').first()).toBeVisible()
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  const preset = dialog.getByRole('radio', { name: label, exact: true })
  await preset.click()
  await expect(preset).toHaveAttribute('aria-checked', 'true')
  await expect(preset).toHaveClass(/btn-primary/)
  await expect(dialog.getByRole('radio', { name: 'Custom', exact: true })).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByPlaceholder('Enter command...')).toHaveValue(command)
  return dialog
}

test('Grok preset submits its launch command', async ({ page }, testInfo) => {
  let submitted: unknown
  await page.routeWebSocket(/\/ws(?:\?.*)?$/, (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((data) => {
      const message = JSON.parse(data.toString())
      if (message.type === 'session-create') {
        submitted = message
      } else {
        server.send(data)
      }
    })
  })

  const dialog = await selectPreset(page, 'Grok', 'grok')
  await dialog.screenshot({ path: testInfo.outputPath('grok-preset.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(() => submitted).toMatchObject({ type: 'session-create', command: 'grok' })
})

test('Antigravity preset launches with an alternate-screen settings argument', async ({ page }, testInfo) => {
  const root = process.env.E2E_TMUX_TMPDIR
  const session = process.env.E2E_TMUX_SESSION
  if (!root || !session) throw new Error('Private E2E tmux server required')
  const bin = join(root, 'fixture-bin')
  const env = {
    ...process.env, TMUX: undefined, TMUX_PANE: undefined,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  }
  const tmux = (...args: string[]) => spawnSync('tmux', ['-S', socketPath(root), ...args], { env, encoding: 'utf8' })
  mkdirSync(bin, { recursive: true })
  const argvFile = join(bin, 'argv')
  const settings = '{"altScreenMode":"always"}'
  writeFileSync(join(bin, 'agy'), `#!/bin/sh
printf '%s\\n' "$#" "$@" > "${'$'}{0%/*}/argv"
if [ "$#" -eq 2 ] && [ "$1" = "--settings" ] && [ "$2" = '${settings}' ]; then
  printf '\\033[?1049hAntigravity fullscreen fixture\\n'
fi
exec sleep 600
`, { mode: 0o755 })

  const name = 'antigravity-preset-e2e'
  const target = `${session}:=${name}`
  const oldShell = tmux('show-options', '-qv', '-t', session, 'default-shell').stdout.trim()
  try {
    // Avoid shell startup files that can replace the test PATH.
    const shell = tmux('set-option', '-t', session, 'default-shell', '/bin/sh')
    expect(shell.status, shell.stderr).toBe(0)

    const dialog = await selectPreset(page, 'Antigravity', `agy --settings '${settings}'`)
    await dialog.getByRole('combobox', { name: 'Project path' }).fill(root)
    await dialog.getByPlaceholder('auto-generated').fill(name)
    const screenshot = testInfo.outputPath('antigravity-preset.png')
    await dialog.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach('Antigravity preset', { path: screenshot, contentType: 'image/png' })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()

    await expect.poll(() => {
      try { return readFileSync(argvFile, 'utf8') } catch {
        return tmux('capture-pane', '-p', '-t', target).stdout.trim() || null
      }
    }).toBe(`2\n--settings\n${settings}\n`)
    await expect.poll(() => tmux('display-message', '-p', '-t', target, '#{alternate_on}').stdout.trim()).toBe('1')
  } finally {
    tmux('kill-window', '-t', target)
    if (oldShell) tmux('set-option', '-t', session, 'default-shell', oldShell)
    else tmux('set-option', '-u', '-t', session, 'default-shell')
    rmSync(join(bin, 'agy'), { force: true })
    rmSync(argvFile, { force: true })
  }
})

test('editing the built-in launcher survives reload and sync to a fresh browser', async ({ page, browser, baseURL, request }) => {
  async function commandField(client: Page) {
    await client.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = client.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('tab', { name: 'New sessions', exact: true }).click()
    return dialog.getByRole('textbox', { name: 'Command for Antigravity', exact: true })
  }

  await page.goto('/')
  const field = await commandField(page)
  const stock = `agy --settings '{"altScreenMode":"always"}'`
  await expect(field).toHaveValue(stock)
  const other = await browser.newContext({ baseURL })
  let edited: SyncedCommandPreset[] | undefined
  try {
    const saved = page.waitForResponse(res => res.url().endsWith('/api/settings/synced') &&
      res.request().method() === 'PUT' && Array.isArray(res.request().postDataJSON()?.settings?.commandPresets))
    await field.fill('agy')
    await field.press('Tab')
    const response = await saved
    expect(response.ok()).toBe(true)
    edited = response.request().postDataJSON().settings.commandPresets
    await page.reload()
    await expect(await commandField(page)).toHaveValue('agy')
    const second = await other.newPage()
    await selectPreset(second, 'Antigravity', 'agy')
  } finally {
    await other.close()
    await page.close()
    if (edited) {
      const commandPresets = edited.map(p => p.id === 'antigravity' ? { ...p, command: stock } : p)
      expect((await request.put('/api/settings/synced', { data: { settings: { commandPresets } } })).ok()).toBe(true)
    }
  }
})
