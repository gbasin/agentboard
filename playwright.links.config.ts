import { defineConfig } from '@playwright/test'
import base from './playwright.config'
export default defineConfig({ ...base, webServer: { ...base.webServer, reuseExistingServer: false }, testMatch: ['session-links.spec.ts', 'media-*.spec.ts'], workers: 1, projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }] })
