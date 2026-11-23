import { test, expect } from '@playwright/test'

for (const { label, command } of [
  { label: 'Grok', command: 'grok' },
  { label: 'Antigravity', command: 'agy' },
]) {
  test(`${label} preset submits the ${command} launch command`, async ({ page }, testInfo) => {
    let submitted: unknown
    await page.routeWebSocket(/\/ws(?:\?.*)?$/, (socket) => {
      const server = socket.connectToServer()
      socket.onMessage((data) => {
        const message = JSON.parse(data.toString())
        if (message.type === 'session-create') {
          // Verify the launch request without requiring a locally installed CLI.
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
    const preset = dialog.getByRole('radio', { name: label, exact: true })
    await preset.click()
    await expect(preset).toHaveAttribute('aria-checked', 'true')
    await expect(preset).toHaveClass(/btn-primary/)
    await expect(dialog.getByRole('radio', { name: 'Custom', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(dialog.getByPlaceholder('Enter command...')).toHaveValue(command)
    await dialog.screenshot({ path: testInfo.outputPath(`${command}-preset.png`), animations: 'disabled' })

    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect.poll(() => submitted).toMatchObject({ type: 'session-create', command })
  })
}
