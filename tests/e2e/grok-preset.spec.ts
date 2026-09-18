import { test, expect } from '@playwright/test'

test('Grok preset submits the grok launch command', async ({ page }, testInfo) => {
  let submitted: unknown
  await page.routeWebSocket('/ws', (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((data) => {
      const message = JSON.parse(data.toString())
      if (message.type === 'session-create') {
        // Verify the launch request without requiring a locally installed Grok CLI.
        submitted = message
      } else {
        server.send(data)
      }
    })
  })

  await page.goto('/')
  await expect(page.getByTestId('session-card').first()).toBeVisible()
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  const grok = dialog.getByRole('radio', { name: 'Grok', exact: true })
  await grok.click()
  await expect(grok).toHaveAttribute('aria-checked', 'true')
  await expect(grok).toHaveClass(/btn-primary/)
  await expect(dialog.getByRole('radio', { name: 'Custom', exact: true })).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByPlaceholder('Enter command...')).toHaveValue('grok')
  await dialog.screenshot({ path: testInfo.outputPath('grok-preset.png'), animations: 'disabled' })

  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(() => submitted).toMatchObject({ type: 'session-create', command: 'grok' })
})
