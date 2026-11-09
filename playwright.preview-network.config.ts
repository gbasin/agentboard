/** Reproduce Tailscale Serve's dashboard-port conflict on private loopback only. */
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

const port = Number(process.env.E2E_PORT) || 4196
process.env.E2E_PREVIEW_BIND_CONFLICT = '1'
export default defineConfig({
  ...base,
  testMatch: 'output-previews.spec.ts',
  grep: /live app preview/,
  workers: 1,
  use: { ...base.use, baseURL: `http://[::1]:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `[ -d dist/client ] || bun run build && PORT=${port} bun tests/e2e/fixtures/preview-network.ts`,
    url: `http://[::1]:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
