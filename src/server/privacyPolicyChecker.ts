import fs from 'node:fs'
import path from 'node:path'

export interface PrivacyPolicyClaim {
  id: string
  title: string
}

export interface PrivacyPolicyViolation {
  claimId: string
  message: string
  fix: string
  file?: string
}

export interface PrivacyPolicyCheckResult {
  ok: boolean
  claimsChecked: PrivacyPolicyClaim[]
  violations: PrivacyPolicyViolation[]
}

export interface PrivacyPolicyCheckerOptions {
  rootDir?: string
}

const TELEMETRY_DEPENDENCY_DENYLIST = [
  /^@sentry\//,
  /^posthog($|-)/,
  /^mixpanel($|-)/,
  /^analytics($|-)/,
  /^@segment\//,
  /^amplitude($|-)/,
  /^@amplitude\//,
  /^@datadog\//,
  /^newrelic$/,
  /^rudder-sdk-js$/,
  /^plausible-tracker$/,
  /^@plausible\/analytics$/,
]

export const PRIVACY_POLICY_CLAIMS: PrivacyPolicyClaim[] = [
  {
    id: 'PP-001',
    title: 'Telemetry and analytics dependencies are denylisted',
  },
  {
    id: 'PP-002',
    title: 'Runtime fetch calls are local-relative only',
  },
  {
    id: 'PP-003',
    title: '/api/paste-image writes image data to /tmp and returns that path',
  },
  {
    id: 'PP-004',
    title: 'Persisted browser state must use safeStorage with in-memory fallback',
  },
  {
    id: 'PP-005',
    title: 'Default server persistence paths resolve under ~/.agentboard',
  },
]

export async function runPrivacyPolicyChecker(
  options: PrivacyPolicyCheckerOptions = {}
): Promise<PrivacyPolicyCheckResult> {
  const rootDir = options.rootDir ?? process.cwd()
  const violations: PrivacyPolicyViolation[] = []

  checkPolicyDocument(rootDir, violations)
  checkTelemetryDependencies(rootDir, violations)
  checkRuntimeNetworkUsage(rootDir, violations)
  checkPasteImageHandling(rootDir, violations)
  checkSafeStorageAndPersistedStores(rootDir, violations)
  checkDefaultPersistencePaths(rootDir, violations)

  return {
    ok: violations.length === 0,
    claimsChecked: PRIVACY_POLICY_CLAIMS,
    violations,
  }
}

function checkPolicyDocument(rootDir: string, violations: PrivacyPolicyViolation[]) {
  const policyPath = path.join(rootDir, 'docs/privacy-policy.md')
  const policySource = readFileSafely(policyPath)

  if (!policySource) {
    violations.push({
      claimId: 'PP-001',
      message: 'Missing privacy policy source file docs/privacy-policy.md.',
      fix: 'Add docs/privacy-policy.md with claim IDs PP-001 through PP-005.',
      file: toRelative(rootDir, policyPath),
    })
    return
  }

  for (const claim of PRIVACY_POLICY_CLAIMS) {
    const claimHeader = `## ${claim.id}`
    if (!policySource.includes(claimHeader)) {
      violations.push({
        claimId: claim.id,
        message: `Policy file is missing claim header ${claimHeader}.`,
        fix: `Add a machine-stable section header ${claimHeader} in docs/privacy-policy.md.`,
        file: toRelative(rootDir, policyPath),
      })
    }
  }
}

function checkTelemetryDependencies(rootDir: string, violations: PrivacyPolicyViolation[]) {
  const packagePath = path.join(rootDir, 'package.json')
  const packageSource = readFileSafely(packagePath)

  if (!packageSource) {
    violations.push({
      claimId: 'PP-001',
      message: 'Cannot read package.json for dependency verification.',
      fix: 'Restore package.json so the checker can validate dependencies.',
      file: toRelative(rootDir, packagePath),
    })
    return
  }

  let packageJson: Record<string, unknown>
  try {
    packageJson = JSON.parse(packageSource) as Record<string, unknown>
  } catch {
    violations.push({
      claimId: 'PP-001',
      message: 'package.json is not valid JSON.',
      fix: 'Fix package.json formatting so denylisted dependency checks can run.',
      file: toRelative(rootDir, packagePath),
    })
    return
  }

  const sections = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
  ]

  const dependencyNames = sections.flatMap((section) => {
    if (!section || typeof section !== 'object') {
      return []
    }
    return Object.keys(section)
  })

  const denylisted = dependencyNames.filter((name) =>
    TELEMETRY_DEPENDENCY_DENYLIST.some((pattern) => pattern.test(name))
  )

  for (const dependency of denylisted) {
    violations.push({
      claimId: 'PP-001',
      message: `Denylisted telemetry dependency detected: ${dependency}.`,
      fix: 'Remove telemetry/analytics dependency or update the privacy policy claim set.',
      file: toRelative(rootDir, packagePath),
    })
  }
}

function checkRuntimeNetworkUsage(rootDir: string, violations: PrivacyPolicyViolation[]) {
  const runtimeFiles = [
    ...collectRuntimeSourceFiles(path.join(rootDir, 'src/client')),
    ...collectRuntimeSourceFiles(path.join(rootDir, 'src/server')),
  ].filter((absolutePath) => path.basename(absolutePath) !== 'privacyPolicyChecker.ts')

  for (const absolutePath of runtimeFiles) {
    const source = readFileSafely(absolutePath)
    if (!source) {
      continue
    }

    if (/\bfrom\s+['"]axios['"]/.test(source) || /\brequire\(['"]axios['"]\)/.test(source)) {
      violations.push({
        claimId: 'PP-002',
        message: 'Found axios import in runtime source.',
        fix: 'Use local-relative fetch() calls only, or update privacy policy claims.',
        file: toRelative(rootDir, absolutePath),
      })
    }

    const fetchViolations = findFetchViolations(source)
    for (const fetchViolation of fetchViolations) {
      violations.push({
        claimId: 'PP-002',
        message: fetchViolation.message,
        fix: fetchViolation.fix,
        file: `${toRelative(rootDir, absolutePath)}:${fetchViolation.line}`,
      })
    }
  }
}

function findFetchViolations(source: string): Array<{
  line: number
  message: string
  fix: string
}> {
  const violations: Array<{
    line: number
    message: string
    fix: string
  }> = []

  const sanitizedSource = stripStringsAndComments(source)
  const fetchMatcher = /\bfetch\s*\(/g

  for (const match of sanitizedSource.matchAll(fetchMatcher)) {
    const fetchTokenIndex = match.index ?? 0
    if (source[fetchTokenIndex - 1] === '.') {
      continue
    }

    if (isFetchMethodDefinition(source, fetchTokenIndex)) {
      continue
    }

    const argumentStart = fetchTokenIndex + 'fetch('.length
    const parsedArgument = parseFirstArgument(source, argumentStart)
    const line = lineForOffset(source, fetchTokenIndex)

    if (!parsedArgument) {
      violations.push({
        line,
        message: 'Found fetch() call with dynamic first argument.',
        fix: 'Use a string literal local-relative endpoint, for example fetch("/api/...").',
      })
      continue
    }

    if (parsedArgument.isDynamicLiteral) {
      violations.push({
        line,
        message: 'Found fetch() call with dynamic first argument.',
        fix: 'Use a static string literal local-relative endpoint, not template interpolation.',
      })
      continue
    }

    const endpoint = parsedArgument.value.trim()
    if (!isAllowedFetchTarget(endpoint)) {
      violations.push({
        line,
        message: `Found non-local fetch target: ${endpoint}.`,
        fix: 'Restrict runtime network calls to local-relative paths.',
      })
    }
  }

  return violations
}

function stripStringsAndComments(source: string): string {
  type ParseState = 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment'
  let state: ParseState = 'code'
  let result = ''

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1] ?? ''

    if (state === 'code') {
      if (char === '\'') {
        state = 'single'
        result += ' '
        continue
      }

      if (char === '"') {
        state = 'double'
        result += ' '
        continue
      }

      if (char === '`') {
        state = 'template'
        result += ' '
        continue
      }

      if (char === '/' && next === '/') {
        state = 'line-comment'
        result += '  '
        index += 1
        continue
      }

      if (char === '/' && next === '*') {
        state = 'block-comment'
        result += '  '
        index += 1
        continue
      }

      result += char
      continue
    }

    if (state === 'single') {
      if (char === '\\') {
        result += '  '
        index += 1
        continue
      }

      if (char === '\'') {
        state = 'code'
        result += ' '
        continue
      }

      result += char === '\n' ? '\n' : ' '
      if (char === '\n') {
        state = 'code'
      }
      continue
    }

    if (state === 'double') {
      if (char === '\\') {
        result += '  '
        index += 1
        continue
      }

      if (char === '"') {
        state = 'code'
        result += ' '
        continue
      }

      result += char === '\n' ? '\n' : ' '
      if (char === '\n') {
        state = 'code'
      }
      continue
    }

    if (state === 'template') {
      if (char === '\\') {
        result += '  '
        index += 1
        continue
      }

      if (char === '`') {
        state = 'code'
        result += ' '
        continue
      }

      result += char === '\n' ? '\n' : ' '
      continue
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code'
        result += '\n'
        continue
      }

      result += ' '
      continue
    }

    if (char === '*' && next === '/') {
      state = 'code'
      result += '  '
      index += 1
      continue
    }

    result += char === '\n' ? '\n' : ' '
  }

  return result
}

function isFetchMethodDefinition(source: string, fetchTokenIndex: number): boolean {
  const lineStart = source.lastIndexOf('\n', fetchTokenIndex - 1) + 1
  const nextNewline = source.indexOf('\n', fetchTokenIndex)
  const lineEnd = nextNewline === -1 ? source.length : nextNewline
  const line = source.slice(lineStart, lineEnd)

  if (/^\s*function\s+fetch\s*\(/.test(line)) {
    return true
  }

  if (/^\s*(?:async\s+)?fetch\s*\([^)]*\)\s*\{/.test(line)) {
    return true
  }

  return false
}

function parseFirstArgument(source: string, argumentStart: number): {
  value: string
  isDynamicLiteral: boolean
} | null {
  let cursor = argumentStart

  while (cursor < source.length && /\s/.test(source[cursor] ?? '')) {
    cursor += 1
  }

  const quote = source[cursor]
  if (quote !== '"' && quote !== '\'' && quote !== '`') {
    return null
  }

  cursor += 1
  let value = ''

  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '\\') {
      const next = source[cursor + 1] ?? ''
      value += char + next
      cursor += 2
      continue
    }

    if (quote === '`' && char === '$' && source[cursor + 1] === '{') {
      value += '${'
      cursor += 2
      continue
    }

    if (char === quote) {
      return { value, isDynamicLiteral: quote === '`' && value.includes('${') }
    }

    value += char
    cursor += 1
  }

  return null
}

function isAllowedFetchTarget(target: string): boolean {
  if (target.startsWith('/')) {
    return true
  }
  if (target.startsWith('./') || target.startsWith('../')) {
    return true
  }
  return false
}

function checkPasteImageHandling(rootDir: string, violations: PrivacyPolicyViolation[]) {
  const indexPath = path.join(rootDir, 'src/server/index.ts')
  const source = readFileSafely(indexPath)

  if (!source) {
    violations.push({
      claimId: 'PP-003',
      message: 'Cannot read src/server/index.ts to verify /api/paste-image handling.',
      fix: 'Restore src/server/index.ts and keep /api/paste-image implementation verifiable.',
      file: toRelative(rootDir, indexPath),
    })
    return
  }

  const routeBlock = extractRouteBlock(source, /\bapp\.post\s*\(\s*(['"])\/api\/paste-image\1/)
  if (!routeBlock) {
    violations.push({
      claimId: 'PP-003',
      message: 'Missing /api/paste-image route.',
      fix: 'Add /api/paste-image route that writes uploads to /tmp and returns the written path.',
      file: toRelative(rootDir, indexPath),
    })
    return
  }

  const hasTmpPathAssignment =
    /\bfilepath\s*=\s*[`'"]\/tmp\//.test(routeBlock) ||
    /\bfilepath\s*=\s*path\.join\(\s*[`'"]\/tmp[`'"]/.test(routeBlock)

  if (!hasTmpPathAssignment) {
    violations.push({
      claimId: 'PP-003',
      message: '/api/paste-image does not assign uploads to a /tmp filepath.',
      fix: 'Set upload destination under /tmp, for example filepath = `/tmp/${filename}`.',
      file: toRelative(rootDir, indexPath),
    })
  }

  const hasWriteOperation = /await\s+(?:Bun\.write|fs(?:\/promises)?\.writeFile|fsPromises\.writeFile)\s*\(\s*filepath\b/.test(routeBlock)

  if (!hasWriteOperation) {
    violations.push({
      claimId: 'PP-003',
      message: '/api/paste-image does not perform a write operation to filepath.',
      fix: 'Persist the uploaded image with Bun.write(filepath, ...) or fs.writeFile(filepath, ...).',
      file: toRelative(rootDir, indexPath),
    })
  }

  if (!/return\s+c\.json\(\s*\{\s*path\s*:\s*filepath\s*\}\s*\)/.test(routeBlock)) {
    violations.push({
      claimId: 'PP-003',
      message: '/api/paste-image does not return { path: filepath } on success.',
      fix: 'Return the final stored path from /api/paste-image success responses.',
      file: toRelative(rootDir, indexPath),
    })
  }
}

function extractRouteBlock(source: string, routeMatcher: RegExp): string | null {
  const routeMatch = routeMatcher.exec(source)
  if (!routeMatch || routeMatch.index === undefined) {
    return null
  }
  const routeStart = routeMatch.index

  const braceStart = source.indexOf('{', routeStart)
  if (braceStart === -1) {
    return null
  }

  let depth = 0
  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(routeStart, i + 1)
      }
    }
  }

  return null
}

function checkSafeStorageAndPersistedStores(
  rootDir: string,
  violations: PrivacyPolicyViolation[]
) {
  const storagePath = path.join(rootDir, 'src/client/utils/storage.ts')
  const storageSource = readFileSafely(storagePath)

  if (!storageSource) {
    violations.push({
      claimId: 'PP-004',
      message: 'Cannot read src/client/utils/storage.ts.',
      fix: 'Restore safeStorage implementation with memory fallback.',
      file: toRelative(rootDir, storagePath),
    })
  } else {
    checkSafeStorageFallback(rootDir, storageSource, storagePath, violations)
  }

  const clientRuntimeFiles = collectRuntimeSourceFiles(path.join(rootDir, 'src/client'))
  for (const absolutePath of clientRuntimeFiles) {
    const source = readFileSafely(absolutePath)
    if (!source) {
      continue
    }

    const persistCalls = findPersistCalls(source)
    if (persistCalls.length === 0) {
      continue
    }

    for (const persistCall of persistCalls) {
      if (!persistCall.expression) {
        violations.push({
          claimId: 'PP-004',
          message: 'Unable to statically validate a persisted store definition.',
          fix: 'Use direct persist(...) calls with createJSONStorage(() => safeStorage).',
          file: `${toRelative(rootDir, absolutePath)}:${persistCall.line}`,
        })
        continue
      }

      if (!/createJSONStorage\s*\(\s*\(\)\s*=>\s*safeStorage\s*\)/.test(persistCall.expression)) {
        violations.push({
          claimId: 'PP-004',
          message: 'Persisted Zustand store is not using createJSONStorage(() => safeStorage).',
          fix: 'Use createJSONStorage(() => safeStorage) for each persisted store.',
          file: `${toRelative(rootDir, absolutePath)}:${persistCall.line}`,
        })
      }
    }
  }
}

function findPersistCalls(source: string): Array<{
  line: number
  expression: string | null
}> {
  const sanitizedSource = stripStringsAndComments(source)
  const persistMatcher = /\bpersist\s*\(/g
  const persistCalls: Array<{
    line: number
    expression: string | null
  }> = []

  for (const match of sanitizedSource.matchAll(persistMatcher)) {
    const persistIndex = match.index ?? 0
    const line = lineForOffset(source, persistIndex)
    const argumentStart = sanitizedSource.indexOf('(', persistIndex)
    if (argumentStart === -1) {
      persistCalls.push({ line, expression: null })
      continue
    }

    const argumentExpression = extractBalancedSegment(
      sanitizedSource,
      argumentStart,
      '(',
      ')'
    )
    if (!argumentExpression) {
      persistCalls.push({ line, expression: null })
      continue
    }

    const callEnd = argumentStart + argumentExpression.length
    persistCalls.push({
      line,
      expression: source.slice(persistIndex, callEnd),
    })
  }

  return persistCalls
}

function checkSafeStorageFallback(
  rootDir: string,
  storageSource: string,
  storagePath: string,
  violations: PrivacyPolicyViolation[]
) {
  if (!/const\s+memoryStorage\s*=\s*createMemoryStorage\(\)/.test(storageSource)) {
    violations.push({
      claimId: 'PP-004',
      message: 'safeStorage is missing dedicated in-memory storage fallback.',
      fix: 'Add memoryStorage = createMemoryStorage() and use it as localStorage fallback.',
      file: toRelative(rootDir, storagePath),
    })
  }

  const safeStorageObject = extractNamedObjectLiteral(storageSource, 'safeStorage')
  if (!safeStorageObject) {
    violations.push({
      claimId: 'PP-004',
      message: 'safeStorage object literal is missing.',
      fix: 'Declare safeStorage as an object literal with getItem/setItem/removeItem fallback logic.',
      file: toRelative(rootDir, storagePath),
    })
    return
  }

  const methodExpectations: Array<{
    methodName: 'getItem' | 'setItem' | 'removeItem'
    fallbackCall: string
    expectedCount: number
  }> = [
    { methodName: 'getItem', fallbackCall: 'memoryStorage.getItem(key)', expectedCount: 2 },
    { methodName: 'setItem', fallbackCall: 'memoryStorage.setItem(key, value)', expectedCount: 2 },
    { methodName: 'removeItem', fallbackCall: 'memoryStorage.removeItem(key)', expectedCount: 2 },
  ]

  for (const expectation of methodExpectations) {
    const body = extractObjectMethodBody(safeStorageObject, expectation.methodName)
    if (!body) {
      violations.push({
        claimId: 'PP-004',
        message: `safeStorage is missing ${expectation.methodName} implementation.`,
        fix: `Implement safeStorage.${expectation.methodName} with localStorage and memory fallback behavior.`,
        file: toRelative(rootDir, storagePath),
      })
      continue
    }

    if (!/typeof\s+localStorage\s*===\s*['"]undefined['"]/.test(body)) {
      violations.push({
        claimId: 'PP-004',
        message: `safeStorage.${expectation.methodName} does not guard undefined localStorage.`,
        fix: 'Use typeof localStorage === "undefined" fallback before localStorage access.',
        file: toRelative(rootDir, storagePath),
      })
    }

    if (!/catch\s*\{/.test(body)) {
      violations.push({
        claimId: 'PP-004',
        message: `safeStorage.${expectation.methodName} does not catch localStorage errors.`,
        fix: 'Wrap localStorage access in try/catch and fall back to memoryStorage.',
        file: toRelative(rootDir, storagePath),
      })
    }

    const fallbackCount = countOccurrences(body, expectation.fallbackCall)
    if (fallbackCount < expectation.expectedCount) {
      violations.push({
        claimId: 'PP-004',
        message: `safeStorage.${expectation.methodName} is missing full memory fallback coverage.`,
        fix: 'Use memoryStorage fallback both when localStorage is unavailable and when localStorage throws.',
        file: toRelative(rootDir, storagePath),
      })
    }
  }
}

function extractObjectMethodBody(source: string, methodName: string): string | null {
  const marker = `${methodName}:`
  const markerIndex = source.indexOf(marker)
  if (markerIndex === -1) {
    return null
  }

  const openingBrace = source.indexOf('{', markerIndex)
  if (openingBrace === -1) {
    return null
  }

  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(openingBrace, index + 1)
      }
    }
  }

  return null
}

function extractNamedObjectLiteral(source: string, name: string): string | null {
  const declaration = new RegExp(`(?:export\\s+)?const\\s+${name}(?:\\s*:[^=]+)?\\s*=`)
  const match = declaration.exec(source)
  if (!match) {
    return null
  }

  const objectStart = source.indexOf('{', match.index)
  if (objectStart === -1) {
    return null
  }

  let depth = 0
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(objectStart, index + 1)
      }
    }
  }

  return null
}

function checkDefaultPersistencePaths(rootDir: string, violations: PrivacyPolicyViolation[]) {
  const configPath = path.join(rootDir, 'src/server/config.ts')
  const dbPath = path.join(rootDir, 'src/server/db.ts')

  const configSource = readFileSafely(configPath)
  const dbSource = readFileSafely(dbPath)

  if (!configSource) {
    violations.push({
      claimId: 'PP-005',
      message: 'Cannot read src/server/config.ts to verify default log path.',
      fix: 'Restore config.ts default log path resolution under ~/.agentboard.',
      file: toRelative(rootDir, configPath),
    })
  } else if (!/path\.join\(\s*homeDir\s*,\s*['"]\.agentboard['"]\s*,\s*['"]agentboard\.log['"]\s*\)/.test(configSource)) {
    violations.push({
      claimId: 'PP-005',
      message: 'Default LOG_FILE path is not set to ~/.agentboard/agentboard.log.',
      fix: 'Set defaultLogFile to path.join(homeDir, ".agentboard", "agentboard.log").',
      file: toRelative(rootDir, configPath),
    })
  }

  if (!dbSource) {
    violations.push({
      claimId: 'PP-005',
      message: 'Cannot read src/server/db.ts to verify default DB path.',
      fix: 'Restore db.ts default path resolution under ~/.agentboard.',
      file: toRelative(rootDir, dbPath),
    })
    return
  }

  if (!/const\s+DEFAULT_DATA_DIR\s*=\s*path\.join\(/.test(dbSource) || !/['"]\.agentboard['"]/.test(dbSource)) {
    violations.push({
      claimId: 'PP-005',
      message: 'DEFAULT_DATA_DIR does not resolve to ~/.agentboard.',
      fix: 'Set DEFAULT_DATA_DIR to path.join(HOME, ".agentboard").',
      file: toRelative(rootDir, dbPath),
    })
  }

  if (!/const\s+DEFAULT_DB_PATH\s*=\s*path\.join\(\s*DEFAULT_DATA_DIR\s*,\s*['"]agentboard\.db['"]\s*\)/.test(dbSource)) {
    violations.push({
      claimId: 'PP-005',
      message: 'DEFAULT_DB_PATH is not tied to DEFAULT_DATA_DIR/agentboard.db.',
      fix: 'Set DEFAULT_DB_PATH to path.join(DEFAULT_DATA_DIR, "agentboard.db").',
      file: toRelative(rootDir, dbPath),
    })
  }
}

function collectRuntimeSourceFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return []
  }

  const files: string[] = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name)

      if (entry.isDirectory()) {
        if (entry.name === '__tests__') {
          continue
        }
        stack.push(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      if (!/\.(ts|tsx)$/.test(entry.name)) {
        continue
      }

      if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
        continue
      }

      files.push(absolutePath)
    }
  }

  return files
}

function extractBalancedSegment(
  source: string,
  startIndex: number,
  openChar: string,
  closeChar: string
): string | null {
  if (source[startIndex] !== openChar) {
    return null
  }

  let depth = 0
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === openChar) {
      depth += 1
      continue
    }

    if (char === closeChar) {
      depth -= 1
      if (depth === 0) {
        return source.slice(startIndex, index + 1)
      }
    }
  }

  return null
}

function lineForOffset(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === '\n') {
      line += 1
    }
  }
  return line
}

function countOccurrences(source: string, target: string): number {
  let count = 0
  let searchStart = 0

  while (searchStart < source.length) {
    const found = source.indexOf(target, searchStart)
    if (found === -1) {
      break
    }
    count += 1
    searchStart = found + target.length
  }

  return count
}

function readFileSafely(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function toRelative(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath) || filePath
}
