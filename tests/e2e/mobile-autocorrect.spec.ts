/** Browser -> production WebSocket -> private tmux -> real readline.
 * iOS replacement replays plus Android Chromium IME and InputEvent coverage. */
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

for (const platform of ['iOS', 'Android'] as const) {
test.describe(platform, () => {
test.use({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true,
  userAgent: platform === 'iOS'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 Version/26.4 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' })
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

test('ordinary build enables native autocorrect by default', async ({ page }) => {
  await create('autocorrect-off')
  await page.goto('/')
  const input = await select(page, 'autocorrect-off')
  await expect(input).toHaveAttribute('autocorrect', 'on')
})

test('upgrade preserves the current platform preference in one switch', async ({ page }) => {
  await page.addInitScript(platform => {
    localStorage.setItem('agentboard-settings', JSON.stringify({ version: 8, state: {
      iosAutocorrect: platform !== 'iOS', androidAutocorrect: platform !== 'Android',
    } }))
  }, platform)
  await create('autocorrect-migrate')
  await page.goto('/')
  const input = await select(page, 'autocorrect-migrate')
  await expect(input).toHaveAttribute('autocorrect', 'off')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('agentboard-settings')!))
  expect(saved.version).toBe(9)
  expect(saved.state.mobileAutocorrect).toBe(false)
  expect(saved.state).not.toHaveProperty('iosAutocorrect')
  expect(saved.state).not.toHaveProperty('androidAutocorrect')
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
    return settings.getByRole('switch', { name: 'Mobile autocorrect', exact: true })
  }
  const toggle = await openSettings()
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(input).toHaveAttribute('autocorrect', 'off')
  await toggle.click()
  await expect(input).toHaveAttribute('autocorrect', 'on')
  await info.attach(`${platform.toLowerCase()}-autocorrect-settings.png`, {body: await page.screenshot({ path: info.outputPath(`${platform.toLowerCase()}-mobile-autocorrect.png`) }), contentType:'image/png'})
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


if (platform === 'Android') {
  test('Chromium composition updates and commit deliver one corrected word', async ({ page }) => {
    await create('android-composition')
    await page.goto('/')
    await select(page, 'android-composition')
    const cdp = await page.context().newCDPSession(page)
    for (const text of ['t', 'te', 'teh', 'the']) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    }
    await expect.poll(() => pane('android-composition')).toContain('prompt> the')
    await cdp.send('Input.insertText', { text: 'the' })
    await page.keyboard.press('Enter')
    await submitted('android-composition', 'the')
    await cdp.send('Input.insertText', { text: 'swipe' })
    await page.keyboard.press('Enter')
    await submitted('android-composition', 'swipe', 2)
    await cdp.detach()
  })

  test('IME-only Backspace and newline submission work after local context resets', async ({ page }) => {
    await create('android-input-events')
    await page.goto('/')
    const input = await select(page, 'android-input-events')
    await page.keyboard.type('old')
    // Moving the terminal cursor resets the adapter but preserves the terminal draft.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await expect(input).toHaveValue('')
    await input.evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })))
    await page.keyboard.type('d')
    // Android can commit a newline as insertText without a cancelable beforeinput.
    await input.evaluate(element => {
      const field = element as HTMLTextAreaElement
      field.value += '\n'
      field.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '\n', bubbles: true }))
    })
    await submitted('android-input-events', 'old')
    await page.keyboard.type('next')
    await input.evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '\n', bubbles: true, cancelable: true })))
    await submitted('android-input-events', 'next', 2)
  })
}
})
}
