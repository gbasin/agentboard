/** TLS termination in front of an HTTP board, as with Tailscale Serve. */
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
const port = Number(process.env.E2E_HTTPS_PORT) || 42771
const auto = process.env.E2E_PREVIEW_AUTO_TLS === '1'
process.env.E2E_HTTPS_PORT = String(port)
process.env.E2E_HTTPS_BACKEND_PORT = String(port + 1)
export default defineConfig({
  ...base, testMatch: 'output-https.spec.ts', workers: 1,
  use: { ...base.use, ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
  projects: auto ? [
    { name: 'chromium-tailscale', use: { browserName: 'chromium', baseURL: `https://preview.fixture.ts.net:${port}`, launchOptions: { args: ['--host-resolver-rules=MAP preview.fixture.ts.net 127.0.0.1', '--no-proxy-server'] } } },
  ] : [
    { name: 'chromium', use: { browserName: 'chromium', baseURL: `https://localhost:${port}` } },
    { name: 'webkit', use: { browserName: 'webkit', baseURL: `https://localhost:${port}` } },
  ],
  webServer: {
    command: 'bun tests/e2e/fixtures/preview-https.ts', url: `https://localhost:${port}`, ignoreHTTPSErrors: true,
    reuseExistingServer: false, timeout: 120_000,
  },
})
