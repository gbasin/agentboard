import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseClaimsFromPolicy,
  runPrivacyPolicyChecker,
  type PrivacyPolicyCheckReport,
} from '../privacyPolicyChecker'

const tempRoots: string[] = []

const BASE_POLICY = `# Privacy Policy

## Machine-Checkable Claims
| Claim ID | Claim | Static Enforcement |
| --- | --- | --- |
| PP-001 | DB path | checker |
| PP-002 | Log path | checker |
| PP-003 | Paste image temp path | checker |
| PP-004 | Browser persistence | checker |
| PP-005 | Dependency denylist | checker |
| PP-006 | Outbound network calls | checker |
`

const BASE_FILES: Record<string, string> = {
  'docs/privacy-policy.md': BASE_POLICY,
  'package.json': JSON.stringify(
    {
      name: 'fixture-app',
      dependencies: {
        hono: '^4.0.0',
      },
      devDependencies: {
        typescript: '^5.0.0',
      },
    },
    null,
    2
  ),
  'src/server/db.ts': `import path from 'node:path'
const DEFAULT_DATA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.agentboard')
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'agentboard.db')
`,
  'src/server/config.ts': `import path from 'node:path'
const homeDir = process.env.HOME || process.env.USERPROFILE || ''
const defaultLogFile = path.join(homeDir, '.agentboard', 'agentboard.log')
const logFile = process.env.LOG_FILE ?? defaultLogFile
`,
  'src/server/index.ts': `app.post('/api/paste-image', async (c) => {
  const filename = 'image.png'
  const filepath = \`/tmp/\${filename}\`
  return c.json({ path: filepath })
})
`,
  'src/client/utils/storage.ts': `import type { StateStorage } from 'zustand/middleware'
export const safeStorage: StateStorage = {
  getItem: (key) => {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  },
  setItem: (key, value) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  },
  removeItem: (key) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  },
}
`,
  'src/client/stores/settingsStore.ts': `import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'
const state = persist(() => ({}), {
  name: 'settings',
  storage: createJSONStorage(() => safeStorage),
})
export default state
`,
  'src/client/stores/sessionStore.ts': `import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'
const state = persist(() => ({}), {
  name: 'sessions',
  storage: createJSONStorage(() => safeStorage),
})
export default state
`,
  'src/client/stores/themeStore.ts': `import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'
const state = persist(() => ({}), {
  name: 'theme',
  storage: createJSONStorage(() => safeStorage),
})
export default state
`,
  'src/client/App.tsx': `async function run() {
  await fetch('/api/health')
  await fetch('./api/directories')
  await new Request('../api/session-preview/1')
}
run()
`,
}

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
})

describe('parseClaimsFromPolicy', () => {
  test('parses machine-checkable claim rows', () => {
    const parsed = parseClaimsFromPolicy(BASE_POLICY)
    expect(parsed.parseErrors).toEqual([])
    expect(parsed.claims.map((claim) => claim.id)).toEqual([
      'PP-001',
      'PP-002',
      'PP-003',
      'PP-004',
      'PP-005',
      'PP-006',
    ])
  })
})

describe('runPrivacyPolicyChecker', () => {
  test('passes for compliant fixture', () => {
    const fixtureRoot = createFixture()
    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(report.passed).toBe(true)
    expect(report.violations).toEqual([])
  })

  test('flags denylisted telemetry dependencies', () => {
    const fixtureRoot = createFixture({
      'package.json': JSON.stringify(
        {
          name: 'fixture-app',
          dependencies: {
            'posthog-js': '^1.0.0',
          },
        },
        null,
        2
      ),
    })

    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(report.passed).toBe(false)
    expect(findClaim(report, 'PP-005').length).toBe(1)
  })

  test('flags hardcoded outbound network targets', () => {
    const fixtureRoot = createFixture({
      'src/client/App.tsx': `async function run() {
  await fetch('https://example.com/api')
}
run()
`,
    })

    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(findClaim(report, 'PP-006').length).toBe(1)
  })

  test('allows local-relative network targets', () => {
    const fixtureRoot = createFixture({
      'src/client/App.tsx': `async function run() {
  await fetch('/api/health')
  await fetch('./api/directories')
  await fetch('../api/session-preview')
}
run()
`,
    })

    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(findClaim(report, 'PP-006')).toEqual([])
  })

  test('flags missing default db path pattern', () => {
    const fixtureRoot = createFixture({
      'src/server/db.ts': `const DEFAULT_DB_PATH = '/var/lib/agentboard.db'
`,
    })

    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(findClaim(report, 'PP-001').length).toBe(1)
  })

  test('flags missing default log path pattern', () => {
    const fixtureRoot = createFixture({
      'src/server/config.ts': `const logFile = process.env.LOG_FILE || '/var/log/agentboard.log'
`,
    })

    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(findClaim(report, 'PP-002').length).toBe(1)
  })

  test('flags paste-image route when temp path is not under /tmp', () => {
    const fixtureRoot = createFixture({
      'src/server/index.ts': `app.post('/api/paste-image', async (c) => {
  const filename = 'image.png'
  const filepath = \`/var/tmp/\${filename}\`
  return c.json({ path: filepath })
})
`,
    })

    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(findClaim(report, 'PP-003').length).toBe(1)
  })

  test('flags persisted stores not using safeStorage', () => {
    const fixtureRoot = createFixture({
      'src/client/stores/settingsStore.ts': `import { persist, createJSONStorage } from 'zustand/middleware'
const state = persist(() => ({}), {
  name: 'settings',
  storage: createJSONStorage(() => localStorage),
})
export default state
`,
    })

    const report = runPrivacyPolicyChecker({ repoRoot: fixtureRoot })
    expect(findClaim(report, 'PP-004').length).toBeGreaterThan(0)
  })
})

function createFixture(overrides: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-policy-checker-'))
  tempRoots.push(root)

  const files = {
    ...BASE_FILES,
    ...overrides,
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content, 'utf8')
  }

  return root
}

function findClaim(
  report: PrivacyPolicyCheckReport,
  claimId: string
) {
  return report.violations.filter((violation) => violation.claimId === claimId)
}
