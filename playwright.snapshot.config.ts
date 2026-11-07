// Snapshot selection/link gestures must work in Chromium and mobile WebKit.
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: 'snapshot-links.spec.ts',
  workers: 1,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { ...base.webServer, reuseExistingServer: false },
})
