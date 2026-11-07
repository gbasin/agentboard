/** Opt-in test build; normal Agentboard builds keep native autocorrect disabled. */
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
process.env.E2E_IOS_AUTOCORRECT = '1'
const utf8Locale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
process.env.LC_ALL = utf8Locale
process.env.LANG = utf8Locale
const server = base.webServer as { command: string }
export default defineConfig({
  ...base,
  testMatch: 'ios-autocorrect.spec.ts',
  workers: 1,
  webServer: {
    ...base.webServer,
    command: `VITE_IOS_AUTOCORRECT_PROTOTYPE=1 bun run build && ${server.command.replace('LC_ALL=C LANG=C', `LC_ALL=${utf8Locale} LANG=${utf8Locale}`)}`,
    reuseExistingServer: false,
  },
})
