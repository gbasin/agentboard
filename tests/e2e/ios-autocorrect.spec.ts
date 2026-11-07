/** Browser -> production WebSocket -> private tmux -> real readline, using captured iOS event shapes. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
test.skip(process.env.E2E_AUTOCORRECT_SUITE !== '1', 'Run with playwright.autocorrect.config.ts for UTF-8 tmux')
const fixture = fileURLToPath(new URL('./fixtures/autocorrect-repl.py', import.meta.url))
const session = process.env.E2E_TMUX_SESSION!
const targets: string[] = []
const sent = new WeakMap<Page, string[]>()
function tmux(args: string[]) {
  const result = spawnSync('tmux', args, { encoding: 'utf8', env: { ...process.env, TMUX: undefined } })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
function pane(name: string) { return tmux(['capture-pane', '-p', '-S', '-100', '-t', `${session}:${name}`]) }
async function create(name: string) {
  tmux(['new-window', '-t', session, '-n', name, `python3 ${fixture}`])
  targets.push(name)
  await expect.poll(() => pane(name)).toContain('AUTOCORRECT READY')
}
async function select(page: Page, name: string) {
  const card = page.getByTestId('session-card').filter({ hasText: name }).first()
  await card.waitFor({ state: 'attached', timeout: 20000 })
  const id = await card.getAttribute('data-session-id')
  await card.evaluate(element => (element as HTMLElement).click())
  await page.waitForFunction(id => (window as unknown as {acReady?: string}).acReady === id, id)
  await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeEnabled({ timeout: 15000 })
  // iOS's initial attach repaint temporarily hides the terminal and blurs its input.
  await page.waitForTimeout(1200)
  const input = page.locator('.xterm-helper-textarea')
  await expect(async () => {
    await input.evaluate(element => { element.removeAttribute('disabled'); (element as HTMLTextAreaElement).focus() })
    await expect(input).toBeFocused({timeout:500})
  }).toPass({timeout:5000})
  return input
}
async function replacement(page: Page, value: string) {
  await page.locator('.xterm-helper-textarea').evaluate((element, text) => {
    const field = element as HTMLTextAreaElement
    field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertReplacementText', data: text }))
    field.value = text
    field.setSelectionRange(text.length, text.length)
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }))
  }, value)
}
async function submitted(name: string, value: string, count = 1) {
  await expect.poll(() => pane(name)).toContain(`SUBMITTED:${JSON.stringify(value)}`)
  expect((pane(name).match(/SUBMITTED:/g) ?? []).length).toBe(count)
}

test.use({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 Version/26.4 Mobile/15E148 Safari/604.1' })
test.beforeEach(async ({ page }) => {
  const frames: string[] = []
  sent.set(page, frames)
  page.on('websocket', socket => socket.on('framesent', event => {
    const message = JSON.parse(String(event.payload))
    if (message.type === 'terminal-input') frames.push(message.data)
  }))
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const blocked = (window as unknown as {acBlockReconnect?: boolean}).acBlockReconnect
        super(blocked ? 'ws://127.0.0.1:1' : url, protocols)
        ;(window as unknown as {acSocket: WebSocket}).acSocket = this
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return
          const message = JSON.parse(event.data)
          if (message.type === 'terminal-ready') (window as unknown as {acReady: string}).acReady = message.sessionId
        })
      }
    }
  })
})
test.afterEach(async ({ page }, info) => {
  await info.attach('terminal-input.json', {body:JSON.stringify(sent.get(page)), contentType:'application/json'})
  if (info.status !== info.expectedStatus) console.log('Terminal bytes', JSON.stringify(sent.get(page)))
  for (const name of targets.splice(0)) tmux(['kill-window', '-t', `${session}:${name}`]) })

test('ordinary build enables iOS autocorrect by default', async ({ page }) => {
  await create('autocorrect-off')
  await page.goto('/')
  const input = await select(page, 'autocorrect-off')
  await expect(input).toHaveAttribute('autocorrect', 'on')
})

test('settings toggles autocorrect live and persists across reload', async ({ page }, info) => {
  await create('autocorrect-setting')
  await page.goto('/')
  const input = await select(page, 'autocorrect-setting')
  await expect(input).toHaveAttribute('autocorrect', 'on')
  const openSettings = async () => {
    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).locator('visible=true').click()
    const settings = page.locator('[role="dialog"][data-suspends-terminal]')
    if (await settings.getByRole('button', { name: 'Terminal', exact: true }).isVisible()) {
      await settings.getByRole('button', { name: 'Terminal', exact: true }).click()
    }
    return settings.getByRole('switch', { name: 'iOS autocorrect', exact: true })
  }
  const toggle = await openSettings()
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(input).toHaveAttribute('autocorrect', 'off')
  await toggle.click()
  await expect(input).toHaveAttribute('autocorrect', 'on')
  await info.attach('ios-autocorrect-settings.png', {body: await page.screenshot(), contentType:'image/png'})
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.reload()
  await select(page, 'autocorrect-setting')
  await expect(input).toHaveAttribute('autocorrect', 'on')
  await page.keyboard.type('teh')
  await replacement(page, 'the')
  await page.keyboard.press('Enter')
  await submitted('autocorrect-setting', 'the')
  await (await openSettings()).click()
  await expect(input).toHaveAttribute('autocorrect', 'off')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.reload()
  await select(page, 'autocorrect-setting')
  await expect(input).toHaveAttribute('autocorrect', 'off')
  await page.keyboard.type('raw')
  await page.keyboard.press('Enter')
  await submitted('autocorrect-setting', 'raw', 2)
})

test.describe('native autocorrect enabled', () => {
  test('replacement, native Return ordering, and following prompt submit exactly once', async ({ page }) => {
    await create('autocorrect-order')
    await page.goto('/')
    const input = await select(page, 'autocorrect-order')
    await expect(input).toHaveAttribute('autocorrect', 'on')
    await page.keyboard.type('teh')
    // Input reaches the real editor before Return.
    await expect.poll(() => pane('autocorrect-order')).toContain('prompt> teh')
    // Use dispatchEvent for keydown: Playwright's real Enter also produces a native line break.
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })
    await replacement(page, 'the')
    await input.evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })))
    await submitted('autocorrect-order', 'the')
    await page.keyboard.type('dont')
    await replacement(page, 'don’t')
    await page.keyboard.type(' ')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await submitted('autocorrect-order', 'don’t', 2)
    await page.keyboard.type('next')
    await page.keyboard.press('Enter')
    await submitted('autocorrect-order', 'next', 3)
  })
  test('toolbar Return and manual paste reset correction context', async ({ page }) => {
    await create('autocorrect-toolbar')
    await page.goto('/')
    await select(page, 'autocorrect-toolbar')
    await page.keyboard.type('first')
    await page.getByRole('button', { name: 'Enter', exact: true }).tap()
    await submitted('autocorrect-toolbar', 'first')
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('teh')
    await replacement(page, 'the')
    await page.getByRole('button', { name: 'Enter', exact: true }).tap()
    await submitted('autocorrect-toolbar', 'the', 2)
    await page.getByRole('button', { name: 'Paste', exact: true }).tap()
    await page.getByRole('textbox', { name: 'Paste here' }).fill('prefix ')
    await page.getByRole('button', { name: 'Submit', exact: true }).click()
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('teh')
    await replacement(page, 'the')
    await page.keyboard.press('Enter')
    await submitted('autocorrect-toolbar', 'prefix the', 3)
  })
  test('reconnect starts a fresh correction context without erasing the existing draft', async ({ page }) => {
    await create('autocorrect-reconnect')
    await page.goto('/')
    await select(page, 'autocorrect-reconnect')
    await page.keyboard.type('prefix ')
    await expect.poll(() => pane('autocorrect-reconnect')).toContain('prompt> prefix')
    await page.evaluate(() => {
      const state = window as unknown as {acReady?: string; acSocket: WebSocket; acBlockReconnect: boolean}
      state.acReady = undefined
      state.acBlockReconnect = true
      state.acSocket.close()
    })
    await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('autocorrect', 'off')
    await page.evaluate(() => { (window as unknown as {acBlockReconnect: boolean}).acBlockReconnect = false })
    await select(page, 'autocorrect-reconnect')
    await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('autocorrect', 'on')
    await page.keyboard.type('teh')
    await replacement(page, 'the')
    await page.keyboard.press('Enter')
    await submitted('autocorrect-reconnect', 'prefix the')
  })
  test('session switch keeps correction bytes out of the previous pane', async ({ page }) => {
    await create('autocorrect-one')
    await create('autocorrect-two')
    await page.goto('/')
    await select(page, 'autocorrect-one')
    await page.keyboard.type('draft')
    await expect.poll(() => pane('autocorrect-one')).toContain('prompt> draft')
    await select(page, 'autocorrect-two')
    await page.keyboard.type('teh')
    await replacement(page, 'the')
    await page.keyboard.press('Enter')
    await submitted('autocorrect-two', 'the')
    expect(pane('autocorrect-one')).toContain('prompt> draft')
    expect(pane('autocorrect-one')).not.toContain('SUBMITTED:')
  })
})
