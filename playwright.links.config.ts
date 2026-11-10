import { defineConfig } from '@playwright/test'
import base from './playwright.config'
export default defineConfig({ ...base, webServer: { ...base.webServer, reuseExistingServer: false }, testMatch: ['link-previews.spec.ts', 'session-links.spec.ts', 'media-*.spec.ts', 'output-file-resolution.spec.ts'], workers: 1, projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }] })
