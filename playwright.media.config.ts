/** Focused media integration matrix; inherits private tmux/data/log isolation. */
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: ['media-rail.spec.ts', 'media-payload.spec.ts', 'media-attention.spec.ts', 'media-thumbnail.spec.ts'],
  workers: 1,
  outputDir: '.test-results-media',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
})
