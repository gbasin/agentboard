import fs from 'node:fs'
import path from 'node:path'

export interface PrivacyPolicyClaim {
  id: string
  claim: string
  staticEnforcement: string
}

export interface PrivacyPolicyViolation {
  claimId: string
  message: string
  guidance: string
  evidence?: string
  filePath?: string
}

export interface PrivacyPolicyCheckReport {
  claims: PrivacyPolicyClaim[]
  violations: PrivacyPolicyViolation[]
  passed: boolean
}

interface CheckerContext {
  repoRoot: string
}

type ClaimCheck = (context: CheckerContext) => PrivacyPolicyViolation[]

type ReadRequiredSourceResult =
  | {
      ok: true
      source: string
    }
  | {
      ok: false
      violations: PrivacyPolicyViolation[]
    }

interface DependencyRule {
  label: string
  matches: (packageName: string) => boolean
}

const PRIVACY_POLICY_PATH = 'docs/privacy-policy.md'
const DB_SOURCE_PATH = 'src/server/db.ts'
const CONFIG_SOURCE_PATH = 'src/server/config.ts'
const SERVER_INDEX_PATH = 'src/server/index.ts'
const CLIENT_STORAGE_PATH = 'src/client/utils/storage.ts'
const CLIENT_STORES_DIR = 'src/client/stores'

const DEPENDENCY_RULES: DependencyRule[] = [
  { label: '@sentry/*', matches: (name) => name.startsWith('@sentry/') },
  { label: '@segment/analytics-node', matches: (name) => name === '@segment/analytics-node' },
  { label: 'analytics-node', matches: (name) => name === 'analytics-node' },
  { label: 'posthog-js', matches: (name) => name === 'posthog-js' },
  { label: 'posthog-node', matches: (name) => name === 'posthog-node' },
  { label: 'mixpanel', matches: (name) => name === 'mixpanel' },
  { label: '@amplitude/analytics-node', matches: (name) => name === '@amplitude/analytics-node' },
  { label: '@amplitude/analytics-browser', matches: (name) => name === '@amplitude/analytics-browser' },
  { label: '@rudderstack/rudder-sdk-node', matches: (name) => name === '@rudderstack/rudder-sdk-node' },
]

const CLAIM_CHECKS: Record<string, ClaimCheck> = {
  'PP-001': checkDefaultDatabasePath,
  'PP-002': checkDefaultLogPath,
  'PP-003': checkPasteImageTempPath,
  'PP-004': checkBrowserStoragePersistence,
  'PP-005': checkTelemetryDependencyDenylist,
  'PP-006': checkOutboundNetworkTargets,
}

const NETWORK_CALL_PATTERNS = [
  {
    label: 'fetch',
    regex: /\bfetch\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  },
  {
    label: 'Request',
    regex: /\bnew\s+Request\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  },
  {
    label: 'WebSocket',
    regex: /\bnew\s+WebSocket\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  },
]

const DISALLOWED_CLIENT_PERSISTENCE_PATTERNS = [
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /document\.cookie/,
]

export function runPrivacyPolicyChecker(
  options: { repoRoot?: string } = {}
): PrivacyPolicyCheckReport {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd())
  const policyPath = path.join(repoRoot, PRIVACY_POLICY_PATH)
  const policySource = safeReadText(policyPath)

  if (policySource === null) {
    return {
      claims: [],
      violations: [
        {
          claimId: 'PP-DOC',
          message: 'Missing privacy policy document at docs/privacy-policy.md.',
          guidance: 'Add docs/privacy-policy.md with PP-### claim rows.',
          filePath: PRIVACY_POLICY_PATH,
        },
      ],
      passed: false,
    }
  }

  const { claims, parseErrors } = parseClaimsFromPolicy(policySource)
  const violations: PrivacyPolicyViolation[] = []

  for (const error of parseErrors) {
    violations.push({
      claimId: 'PP-DOC',
      message: error,
      guidance:
        'Fix docs/privacy-policy.md rows to use `| PP-### | claim | enforcement |` format with unique IDs.',
      filePath: PRIVACY_POLICY_PATH,
    })
  }

  for (const claim of claims) {
    const check = CLAIM_CHECKS[claim.id]
    if (!check) {
      violations.push({
        claimId: claim.id,
        message: `No checker is implemented for claim ${claim.id}.`,
        guidance: `Add a checker in src/server/privacyPolicyChecker.ts for ${claim.id}, or remove the claim row from docs/privacy-policy.md.`,
        filePath: 'src/server/privacyPolicyChecker.ts',
      })
      continue
    }
    violations.push(...check({ repoRoot }))
  }

  return {
    claims,
    violations,
    passed: violations.length === 0,
  }
}

export function parseClaimsFromPolicy(source: string): {
  claims: PrivacyPolicyClaim[]
  parseErrors: string[]
} {
  const lines = source.split(/\r?\n/)
  const claims: PrivacyPolicyClaim[] = []
  const parseErrors: string[] = []
  const seenIds = new Set<string>()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      continue
    }

    const cells = trimmed
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)

    if (cells.length < 3) {
      continue
    }

    const claimId = cells[0]
    if (!/^PP-\d{3}$/.test(claimId)) {
      continue
    }

    if (seenIds.has(claimId)) {
      parseErrors.push(`Duplicate claim ID in privacy policy: ${claimId}.`)
      continue
    }

    const claim = cells[1]
    const staticEnforcement = cells[2]
    if (!claim || !staticEnforcement) {
      parseErrors.push(`Malformed policy row for ${claimId}.`)
      continue
    }

    claims.push({ id: claimId, claim, staticEnforcement })
    seenIds.add(claimId)
  }

  if (claims.length === 0) {
    parseErrors.push('No claim rows found in docs/privacy-policy.md.')
  }

  return { claims, parseErrors }
}

function checkDefaultDatabasePath(context: CheckerContext): PrivacyPolicyViolation[] {
  const dbSource = readRequiredSource(context, 'PP-001', DB_SOURCE_PATH)
  if (!dbSource.ok) {
    return dbSource.violations
  }

  const hasDefaultDataDir = /const\s+DEFAULT_DATA_DIR\s*=\s*path\.join\([\s\S]*?['"]\.agentboard['"]\s*\)/.test(
    dbSource.source
  )
  const hasDefaultDbPath = /const\s+DEFAULT_DB_PATH\s*=\s*path\.join\(\s*DEFAULT_DATA_DIR\s*,\s*['"]agentboard\.db['"]\s*\)/.test(
    dbSource.source
  )

  if (hasDefaultDataDir && hasDefaultDbPath) {
    return []
  }

  return [
    {
      claimId: 'PP-001',
      message:
        'Server database default path does not match expected `~/.agentboard/agentboard.db` pattern.',
      guidance:
        'Define DEFAULT_DATA_DIR using `.agentboard` and DEFAULT_DB_PATH using `agentboard.db` in src/server/db.ts.',
      filePath: DB_SOURCE_PATH,
    },
  ]
}

function checkDefaultLogPath(context: CheckerContext): PrivacyPolicyViolation[] {
  const configSource = readRequiredSource(context, 'PP-002', CONFIG_SOURCE_PATH)
  if (!configSource.ok) {
    return configSource.violations
  }

  const hasDefaultLogFile = /const\s+defaultLogFile\s*=\s*path\.join\(\s*homeDir\s*,\s*['"]\.agentboard['"]\s*,\s*['"]agentboard\.log['"]\s*\)/.test(
    configSource.source
  )
  const hasEnvOverride = /const\s+logFile\s*=\s*process\.env\.LOG_FILE\s*\?\?\s*defaultLogFile/.test(
    configSource.source
  )

  if (hasDefaultLogFile && hasEnvOverride) {
    return []
  }

  return [
    {
      claimId: 'PP-002',
      message:
        'Server log default path does not match expected `~/.agentboard/agentboard.log` + LOG_FILE override pattern.',
      guidance:
        'Define `defaultLogFile` using `.agentboard/agentboard.log` and assign `logFile = process.env.LOG_FILE ?? defaultLogFile` in src/server/config.ts.',
      filePath: CONFIG_SOURCE_PATH,
    },
  ]
}

function checkPasteImageTempPath(context: CheckerContext): PrivacyPolicyViolation[] {
  const indexSource = readRequiredSource(context, 'PP-003', SERVER_INDEX_PATH)
  if (!indexSource.ok) {
    return indexSource.violations
  }

  const hasRoute = /app\.post\(\s*['"]\/api\/paste-image['"]/.test(indexSource.source)
  const hasTempPath = /app\.post\(\s*['"]\/api\/paste-image['"][\s\S]*?const\s+filepath\s*=\s*[`'"]\/tmp\/\$\{filename\}[`'"]/s.test(
    indexSource.source
  )
  const returnsPath = /app\.post\(\s*['"]\/api\/paste-image['"][\s\S]*?return\s+c\.json\(\{\s*path:\s*filepath\s*\}\)/s.test(
    indexSource.source
  )

  if (hasRoute && hasTempPath && returnsPath) {
    return []
  }

  return [
    {
      claimId: 'PP-003',
      message:
        'Paste image endpoint is missing route, `/tmp` write path, or returned temporary path contract.',
      guidance:
        'Ensure `POST /api/paste-image` writes to `/tmp` and returns `{ path: filepath }` in src/server/index.ts.',
      filePath: SERVER_INDEX_PATH,
    },
  ]
}

function checkBrowserStoragePersistence(
  context: CheckerContext
): PrivacyPolicyViolation[] {
  const violations: PrivacyPolicyViolation[] = []

  const storageSource = readRequiredSource(context, 'PP-004', CLIENT_STORAGE_PATH)
  if (!storageSource.ok) {
    violations.push(...storageSource.violations)
    return violations
  }

  const hasSafeStorageExport =
    /export\s+const\s+safeStorage\s*:\s*StateStorage\s*=/.test(
      storageSource.source
    )
  const hasLocalStorageRead = /\blocalStorage\.getItem\(/.test(storageSource.source)
  const hasLocalStorageWrite = /\blocalStorage\.setItem\(/.test(
    storageSource.source
  )
  const hasLocalStorageRemove = /\blocalStorage\.removeItem\(/.test(
    storageSource.source
  )

  if (
    !hasSafeStorageExport ||
    !hasLocalStorageRead ||
    !hasLocalStorageWrite ||
    !hasLocalStorageRemove
  ) {
    violations.push({
      claimId: 'PP-004',
      message:
        'safeStorage no longer enforces localStorage-backed persistence with in-memory fallback.',
      guidance:
        'Keep `safeStorage` in src/client/utils/storage.ts and route get/set/remove through localStorage with fallback.',
      filePath: CLIENT_STORAGE_PATH,
    })
  }

  for (const pattern of DISALLOWED_CLIENT_PERSISTENCE_PATTERNS) {
    if (pattern.test(storageSource.source)) {
      violations.push({
        claimId: 'PP-004',
        message:
          'Disallowed browser persistence API detected in src/client/utils/storage.ts.',
        guidance:
          'Do not persist app state via cookies, sessionStorage, or IndexedDB.',
        filePath: CLIENT_STORAGE_PATH,
        evidence: pattern.source,
      })
    }
  }

  const storeFiles = listFiles(path.join(context.repoRoot, CLIENT_STORES_DIR)).filter(
    (file) => file.endsWith('.ts') || file.endsWith('.tsx')
  )

  for (const absoluteFile of storeFiles) {
    const relativeFile = normalizeRelativePath(context.repoRoot, absoluteFile)
    const source = safeReadText(absoluteFile)
    if (source === null || !/\bpersist\s*\(/.test(source)) {
      continue
    }

    const usesSafeStorage =
      /storage:\s*createJSONStorage\(\(\)\s*=>\s*safeStorage\)/s.test(source)

    if (!usesSafeStorage) {
      violations.push({
        claimId: 'PP-004',
        message: 'A persisted Zustand store is not backed by safeStorage.',
        guidance:
          'Use `storage: createJSONStorage(() => safeStorage)` for persisted stores.',
        filePath: relativeFile,
      })
    }
  }

  for (const runtimeFile of listRuntimeSourceFiles(context.repoRoot, 'src/client')) {
    const source = safeReadText(path.join(context.repoRoot, runtimeFile))
    if (source === null) continue
    for (const pattern of DISALLOWED_CLIENT_PERSISTENCE_PATTERNS) {
      if (pattern.test(source)) {
        violations.push({
          claimId: 'PP-004',
          message:
            'Disallowed browser persistence API detected in client runtime source.',
          guidance:
            'Do not use cookies, sessionStorage, or IndexedDB for persisted app state.',
          filePath: runtimeFile,
          evidence: pattern.source,
        })
      }
    }
  }

  return dedupeViolations(violations)
}

function checkTelemetryDependencyDenylist(
  context: CheckerContext
): PrivacyPolicyViolation[] {
  const packagePath = path.join(context.repoRoot, 'package.json')
  const packageSource = safeReadText(packagePath)

  if (packageSource === null) {
    return [
      {
        claimId: 'PP-005',
        message: 'Missing package.json required for dependency policy check.',
        guidance: 'Restore package.json in repository root.',
        filePath: 'package.json',
      },
    ]
  }

  let packageJson: Record<string, unknown>
  try {
    packageJson = JSON.parse(packageSource) as Record<string, unknown>
  } catch {
    return [
      {
        claimId: 'PP-005',
        message: 'Failed to parse package.json during dependency policy check.',
        guidance: 'Ensure package.json contains valid JSON.',
        filePath: 'package.json',
      },
    ]
  }

  const dependencySections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const
  const packageNames = new Set<string>()

  for (const section of dependencySections) {
    const value = packageJson[section]
    if (!value || typeof value !== 'object') {
      continue
    }
    for (const name of Object.keys(value as Record<string, unknown>)) {
      packageNames.add(name)
    }
  }

  const matches: string[] = []
  for (const packageName of packageNames) {
    const matchingRule = DEPENDENCY_RULES.find((rule) =>
      rule.matches(packageName)
    )
    if (matchingRule) {
      matches.push(`${packageName} (rule: ${matchingRule.label})`)
    }
  }

  if (matches.length === 0) {
    return []
  }

  return [
    {
      claimId: 'PP-005',
      message: 'Denylisted telemetry/analytics dependency found.',
      guidance:
        'Remove telemetry/analytics dependencies or update docs/privacy-policy.md and checker rules together.',
      filePath: 'package.json',
      evidence: matches.sort().join(', '),
    },
  ]
}

function checkOutboundNetworkTargets(context: CheckerContext): PrivacyPolicyViolation[] {
  const findings: string[] = []

  for (const runtimeFile of listRuntimeSourceFiles(context.repoRoot)) {
    const absolutePath = path.join(context.repoRoot, runtimeFile)
    const source = safeReadText(absolutePath)
    if (source === null) {
      continue
    }

    for (const pattern of NETWORK_CALL_PATTERNS) {
      pattern.regex.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = pattern.regex.exec(source)) !== null) {
        const rawTarget = match[2].trim()
        if (!isDisallowedOutboundTarget(rawTarget)) {
          continue
        }
        const line = lineNumberForIndex(source, match.index)
        findings.push(`${runtimeFile}:${line} ${pattern.label}(${rawTarget})`)
      }
    }
  }

  if (findings.length === 0) {
    return []
  }

  const evidence = findings.slice(0, 8).join('\n')
  const remainder = findings.length > 8 ? `\n...and ${findings.length - 8} more` : ''

  return [
    {
      claimId: 'PP-006',
      message:
        'Hardcoded outbound HTTP(S)/WS(S) network targets detected in runtime source.',
      guidance:
        'Use local-relative targets (for example `/api/...`) for runtime fetch/Request/WebSocket calls.',
      evidence: `${evidence}${remainder}`,
    },
  ]
}

function isDisallowedOutboundTarget(target: string): boolean {
  if (
    target.startsWith('/') ||
    target.startsWith('./') ||
    target.startsWith('../')
  ) {
    return false
  }

  if (/^(https?|wss?):\/\//i.test(target)) {
    return true
  }

  if (target.startsWith('//')) {
    return true
  }

  return false
}

function readRequiredSource(
  context: CheckerContext,
  claimId: string,
  relativePath: string
): ReadRequiredSourceResult {
  const absolutePath = path.join(context.repoRoot, relativePath)
  const source = safeReadText(absolutePath)

  if (source === null) {
    return {
      ok: false,
      violations: [
        {
          claimId,
          message: `Missing source file required for claim check: ${relativePath}.`,
          guidance: `Restore ${relativePath} or update claim/checker mappings.`,
          filePath: relativePath,
        },
      ],
    }
  }

  return { ok: true, source }
}

function listRuntimeSourceFiles(
  repoRoot: string,
  sourceRoot = ''
): string[] {
  const roots = sourceRoot
    ? [sourceRoot]
    : ['src/server', 'src/client', 'src/shared']

  const files: string[] = []
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, root)
    if (!fs.existsSync(absoluteRoot)) {
      continue
    }
    for (const absoluteFile of listFiles(absoluteRoot)) {
      const relativeFile = normalizeRelativePath(repoRoot, absoluteFile)
      if (
        !relativeFile.endsWith('.ts') &&
        !relativeFile.endsWith('.tsx')
      ) {
        continue
      }
      if (relativeFile.includes('/__tests__/')) {
        continue
      }
      files.push(relativeFile)
    }
  }
  return files
}

function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath))
      continue
    }
    if (entry.isFile()) {
      files.push(absolutePath)
    }
  }

  return files
}

function lineNumberForIndex(source: string, index: number): number {
  if (index <= 0) {
    return 1
  }
  let line = 1
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1
    }
  }
  return line
}

function safeReadText(absolutePath: string): string | null {
  try {
    return fs.readFileSync(absolutePath, 'utf8')
  } catch {
    return null
  }
}

function normalizeRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/')
}

function dedupeViolations(
  violations: PrivacyPolicyViolation[]
): PrivacyPolicyViolation[] {
  const seen = new Set<string>()
  const deduped: PrivacyPolicyViolation[] = []

  for (const violation of violations) {
    const key = [
      violation.claimId,
      violation.message,
      violation.filePath ?? '',
      violation.evidence ?? '',
    ].join('|')

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(violation)
  }

  return deduped
}
