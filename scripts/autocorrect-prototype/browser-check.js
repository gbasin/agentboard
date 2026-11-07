// Run: dev-browser --headless --browser ab-autocorrect run scripts/autocorrect-prototype/browser-check.js
const page = await browser.getPage('prototype')
await page.goto('http://localhost:18497/?adapter=1')
await page.getByRole('button', { name: 'Type in terminal' }).click()
async function expectLine(expected) {
  const state = JSON.parse(await page.locator('#state').textContent())
  if (state.line !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(state.line)}`)
}
await page.keyboard.type('teh')
await expectLine('teh')
await page.evaluate(() => {
  const field = document.querySelector('textarea')
  field.value = 'the'
  field.setSelectionRange(3, 3)
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'the' }))
})
await page.keyboard.type(' ')
await expectLine('the ')
await page.keyboard.press('Enter')
await expectLine('')
await page.keyboard.type('next')
await page.keyboard.press('Backspace')
await expectLine('nex')
await page.keyboard.press('Enter')
await page.keyboard.type('word')
// An arrow invalidates the tracked context. The next letter must not erase 'word'.
await page.keyboard.press('ArrowLeft')
await page.keyboard.type('x')
const state = JSON.parse(await page.locator('#state').textContent())
if (!state.line.endsWith('x') || state.textarea !== 'x') throw new Error('Navigation failed to reset context')
console.log('PASS: streaming input, replacement, Enter, backspace, navigation reset')
console.log(await saveScreenshot(await page.screenshot(), 'ab-autocorrect-browser.png'))
