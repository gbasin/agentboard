// Isolated feature matrix, including real browser touch events and WebKit.
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
process.env.AGENTBOARD_OWNERSHIP_MATCHING = 'false'
process.env.AGENTBOARD_SKIP_MATCHING_PATTERNS = ''
process.env.ACTIVITY_E2E_MATRIX = '1'
const binary = process.env.ACTIVITY_E2E_BINARY
const command = binary
  ? base.webServer.command.replace('bun src/server/index.ts', "'" + binary.replaceAll("'", "'\\''") + "'")
  : base.webServer.command
export default defineConfig({
  ...base,
  testMatch: ['session-activity.spec.ts', 'session-activity-ui.spec.ts'],
  workers: 1,
  retries: 0,
  use: { ...base.use, serviceWorkers: 'block', trace: 'on', video: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { ...base.webServer, command, reuseExistingServer: false },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'touch-chromium', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, testMatch: 'session-activity-ui.spec.ts' },
    { name: 'touch-webkit', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, testMatch: 'session-activity-ui.spec.ts' },
  ],
})
