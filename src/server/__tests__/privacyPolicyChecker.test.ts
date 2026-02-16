import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPrivacyPolicyChecker } from '../privacyPolicyChecker'

const tempRoots: string[] = []

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0, tempRoots.length)) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

describe('runPrivacyPolicyChecker', () => {
  test('passes for a compliant project fixture', async () => {
    const rootDir = createFixture()

    const result = await runPrivacyPolicyChecker({ rootDir })

    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(0)
    expect(result.claimsChecked.map((claim) => claim.id)).toEqual([
      'PP-001',
      'PP-002',
      'PP-003',
      'PP-004',
      'PP-005',
    ])
  })

  test('fails PP-001 when denylisted telemetry dependency exists', async () => {
    const rootDir = createFixture({
      'package.json': JSON.stringify(
        {
          name: 'fixture',
          dependencies: {
            react: '^18.0.0',
            'posthog-js': '^1.0.0',
          },
        },
        null,
        2
      ),
    })

    const result = await runPrivacyPolicyChecker({ rootDir })

    expect(result.ok).toBe(false)
    expect(result.violations.some((violation) => violation.claimId === 'PP-001')).toBe(true)
    expect(result.violations.some((violation) => violation.message.includes('posthog-js'))).toBe(true)
  })

  test('fails PP-002 for dynamic and non-local fetch targets but allows local-relative fetch', async () => {
    const rootDir = createFixture({
      'src/client/App.tsx': [
        "void fetch('/api/health')",
        "void fetch('https://api.example.com/collect')",
        'const endpoint = window.location.href',
        'void fetch(endpoint)',
      ].join('\n'),
    })

    const result = await runPrivacyPolicyChecker({ rootDir })
    const networkViolations = result.violations.filter((violation) => violation.claimId === 'PP-002')

    expect(networkViolations.length).toBe(2)
    expect(networkViolations.some((violation) => violation.message.includes('non-local fetch target'))).toBe(true)
    expect(networkViolations.some((violation) => violation.message.includes('dynamic first argument'))).toBe(true)
  })

  test('fails PP-003 when paste-image route does not write uploaded bytes', async () => {
    const rootDir = createFixture({
      'src/server/index.ts': [
        'const app = { post: (..._args: unknown[]) => {} }',
        "app.post('/api/paste-image', async (c) => {",
        '  const filename = "paste-test.png"',
        '  const filepath = `/tmp/${filename}`',
        '  return c.json({ path: filepath })',
        '})',
      ].join('\n'),
    })

    const result = await runPrivacyPolicyChecker({ rootDir })
    const claimViolations = result.violations.filter((violation) => violation.claimId === 'PP-003')

    expect(claimViolations.some((violation) => violation.message.includes('write operation'))).toBe(true)
  })

  test('fails PP-004 when safeStorage loses in-memory fallback behavior', async () => {
    const rootDir = createFixture({
      'src/client/utils/storage.ts': [
        'import type { StateStorage } from "zustand/middleware"',
        'export const safeStorage: StateStorage = {',
        '  getItem: (key) => localStorage.getItem(key),',
        '  setItem: (key, value) => { localStorage.setItem(key, value) },',
        '  removeItem: (key) => { localStorage.removeItem(key) },',
        '}',
      ].join('\n'),
    })

    const result = await runPrivacyPolicyChecker({ rootDir })
    const claimViolations = result.violations.filter((violation) => violation.claimId === 'PP-004')

    expect(claimViolations.length).toBeGreaterThan(0)
    expect(claimViolations.some((violation) => violation.message.includes('in-memory storage fallback'))).toBe(true)
  })

  test('fails PP-004 for persisted store outside src/client/stores not using safeStorage', async () => {
    const rootDir = createFixture({
      'src/client/state/alternateStore.ts': [
        'import { create } from "zustand"',
        'import { persist, createJSONStorage } from "zustand/middleware"',
        'export const useAlternateStore = create()(',
        '  persist(',
        '    () => ({ ready: true }),',
        '    {',
        '      name: "alternate",',
        '      storage: createJSONStorage(() => localStorage),',
        '    }',
        '  )',
        ')',
      ].join('\n'),
    })

    const result = await runPrivacyPolicyChecker({ rootDir })
    const claimViolations = result.violations.filter((violation) => violation.claimId === 'PP-004')

    expect(claimViolations.length).toBeGreaterThan(0)
    expect(claimViolations.some((violation) => violation.file?.includes('src/client/state/alternateStore.ts'))).toBe(true)
  })

  test('fails PP-005 when default database path no longer uses ~/.agentboard', async () => {
    const rootDir = createFixture({
      'src/server/db.ts': [
        "import path from 'node:path'",
        "const DEFAULT_DATA_DIR = path.join(process.env.HOME || '', '.different-root')",
        "const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'agentboard.db')",
      ].join('\n'),
    })

    const result = await runPrivacyPolicyChecker({ rootDir })
    const claimViolations = result.violations.filter((violation) => violation.claimId === 'PP-005')

    expect(claimViolations.length).toBeGreaterThan(0)
    expect(claimViolations.some((violation) => violation.message.includes('DEFAULT_DATA_DIR'))).toBe(true)
  })
})

function createFixture(overrides: Record<string, string> = {}): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-policy-checker-'))
  tempRoots.push(rootDir)

  const baseFiles = createBaseFixtureFiles()
  const files = {
    ...baseFiles,
    ...overrides,
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content)
  }

  return rootDir
}

function createBaseFixtureFiles(): Record<string, string> {
  return {
    'docs/privacy-policy.md': [
      '# Privacy Policy',
      '',
      '## PP-001 Telemetry and analytics dependencies are denylisted',
      '',
      '## PP-002 Runtime fetch calls are local-relative only',
      '',
      '## PP-003 /api/paste-image writes image data to /tmp and returns that path',
      '',
      '## PP-004 Persisted browser state must use safeStorage with in-memory fallback',
      '',
      '## PP-005 Default server persistence paths resolve under ~/.agentboard',
      '',
    ].join('\n'),
    'package.json': JSON.stringify(
      {
        name: 'fixture',
        dependencies: {
          react: '^18.0.0',
        },
      },
      null,
      2
    ),
    'src/client/App.tsx': "void fetch('/api/health')\n",
    'src/client/stores/settingsStore.ts': [
      "import { create } from 'zustand'",
      "import { persist, createJSONStorage } from 'zustand/middleware'",
      "import { safeStorage } from '../utils/storage'",
      '',
      'export const useSettingsStore = create()(',
      '  persist(',
      '    () => ({ enabled: true }),',
      '    {',
      "      name: 'settings',",
      '      storage: createJSONStorage(() => safeStorage),',
      '    }',
      '  )',
      ')',
      '',
    ].join('\n'),
    'src/client/utils/storage.ts': [
      "import type { StateStorage } from 'zustand/middleware'",
      '',
      'function createMemoryStorage(): StateStorage {',
      '  const store = new Map<string, string>()',
      '  return {',
      '    getItem: (key) => store.get(key) ?? null,',
      '    setItem: (key, value) => {',
      '      store.set(key, value)',
      '    },',
      '    removeItem: (key) => {',
      '      store.delete(key)',
      '    },',
      '  }',
      '}',
      '',
      'const memoryStorage = createMemoryStorage()',
      '',
      'export const safeStorage: StateStorage = {',
      '  getItem: (key) => {',
      "    if (typeof localStorage === 'undefined') {",
      '      return memoryStorage.getItem(key)',
      '    }',
      '    try {',
      '      return localStorage.getItem(key)',
      '    } catch {',
      '      return memoryStorage.getItem(key)',
      '    }',
      '  },',
      '  setItem: (key, value) => {',
      "    if (typeof localStorage === 'undefined') {",
      '      memoryStorage.setItem(key, value)',
      '      return',
      '    }',
      '    try {',
      '      localStorage.setItem(key, value)',
      '    } catch {',
      '      memoryStorage.setItem(key, value)',
      '    }',
      '  },',
      '  removeItem: (key) => {',
      "    if (typeof localStorage === 'undefined') {",
      '      memoryStorage.removeItem(key)',
      '      return',
      '    }',
      '    try {',
      '      localStorage.removeItem(key)',
      '    } catch {',
      '      memoryStorage.removeItem(key)',
      '    }',
      '  },',
      '}',
      '',
    ].join('\n'),
    'src/server/config.ts': [
      "import path from 'node:path'",
      "const homeDir = process.env.HOME || process.env.USERPROFILE || ''",
      "const defaultLogFile = path.join(homeDir, '.agentboard', 'agentboard.log')",
      'export const config = {',
      '  logFile: process.env.LOG_FILE ?? defaultLogFile,',
      '}',
      '',
    ].join('\n'),
    'src/server/db.ts': [
      "import path from 'node:path'",
      "const DEFAULT_DATA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.agentboard')",
      "const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'agentboard.db')",
      'export function getDbPath() {',
      '  return DEFAULT_DB_PATH',
      '}',
      '',
    ].join('\n'),
    'src/server/index.ts': [
      'const app = { post: (..._args: unknown[]) => {} }',
      "app.post('/api/paste-image', async (c) => {",
      '  const filename = `paste-${Date.now()}.png`',
      '  const filepath = `/tmp/${filename}`',
      '  const buffer = await (new Blob()).arrayBuffer()',
      '  await Bun.write(filepath, buffer)',
      '  return c.json({ path: filepath })',
      '})',
      '',
    ].join('\n'),
  }
}
