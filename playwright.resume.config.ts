// Run the real application recovery regressions in both browser engines.
// The base config supplies private tmux, data, and transcript directories.
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// The server's test-mode compatibility path must not silently bypass the relay.
process.env.AGENTBOARD_TERMINAL_RELAY = '1'

export default defineConfig({
  ...base,
  testMatch: 'terminal-resume.spec.ts',
  testIgnore: [],
  timeout: 45_000,
  workers: 1,
  retries: 0,
  use: {
    ...base.use,
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { ...base.webServer, reuseExistingServer: false },
})
