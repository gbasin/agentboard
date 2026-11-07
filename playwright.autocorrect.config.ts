/** iOS and Android native autocorrect regression suite against an ordinary build, with UTF-8 tmux. */
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
process.env.E2E_AUTOCORRECT_SUITE = '1'
const utf8Locale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
process.env.LC_ALL = utf8Locale
process.env.LANG = utf8Locale
const server = base.webServer as { command: string }
export default defineConfig({
  ...base,
  testMatch: 'mobile-autocorrect.spec.ts',
  workers: 1,
  webServer: {
    ...base.webServer,
    command: `bun run build && ${server.command.replace('LC_ALL=C LANG=C', `LC_ALL=${utf8Locale} LANG=${utf8Locale}`)}`,
    reuseExistingServer: false,
  },
})
