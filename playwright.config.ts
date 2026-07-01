import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT) || 4173
const tmuxSession =
  process.env.E2E_TMUX_SESSION || `agentboard-e2e-${Date.now()}`

process.env.E2E_TMUX_SESSION = tmuxSession

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    // AGENTBOARD_STATIC_DIR is pinned to the repo build: when e2e runs from a
    // shell inside a live agentboard session, the inherited env points at the
    // installed npm package's bundle and the tests would exercise stale code.
    command: `[ -d dist/client ] || bun run build && PORT=${port} TMUX_SESSION=${tmuxSession} AGENTBOARD_STATIC_DIR=dist/client bun src/server/index.ts`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  globalTeardown: './tests/e2e/teardown.ts',
})
