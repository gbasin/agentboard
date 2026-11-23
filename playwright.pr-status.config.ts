import { defineConfig } from '@playwright/test'
import { copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import base from './playwright.config'

const root = process.env.E2E_TMUX_TMPDIR!
const bin = join(root, 'bin')
mkdirSync(bin, { recursive: true })
copyFileSync('tests/e2e/fixtures/pr-status-gh.sh', join(bin, 'gh'))
chmodSync(join(bin, 'gh'), 0o755)
process.env.PR_STATUS_E2E = '1'

export default defineConfig({
  ...base,
  testMatch: 'shared-pr-status.spec.ts',
  retries: 0,
  use: { ...base.use, serviceWorkers: 'block' },
  webServer: {
    ...base.webServer,
    command: base.webServer.command.replace('[ -d dist/client ] || bun run build', 'bun run build'),
    reuseExistingServer: false,
    env: {
      HOSTNAME: 'localhost',
      AGENTBOARD_REMOTE_HOSTS: '',
      PATH: `${bin}:${process.env.PATH}`,
      AGENTBOARD_OWNERSHIP_MATCHING: 'true',
      AGENTBOARD_SKIP_MATCHING_PATTERNS: '',
    },
  },
})
