import ts from 'typescript'

export const SECURITY_FOOTGUN_SEVERITIES = [
  'low',
  'moderate',
  'high',
  'critical',
] as const

export type SecurityFootgunSeverity =
  (typeof SECURITY_FOOTGUN_SEVERITIES)[number]

export type SecurityFootgunRuleId =
  | 'dynamic-shell-interpolation'
  | 'dangerous-eval'
  | 'unsafe-html-injection'
  | 'tls-verification-bypass'
  | 'insecure-temp-file'

export interface SecurityFootgunRule {
  id: SecurityFootgunRuleId
  title: string
  description: string
  severity: SecurityFootgunSeverity
}

export interface SecurityFootgunFinding {
  ruleId: SecurityFootgunRuleId
  severity: SecurityFootgunSeverity
  title: string
  message: string
  filePath: string
  line: number
  column: number
  snippet: string
}

export interface SecurityFootgunPolicy {
  threshold: SecurityFootgunSeverity
}

export interface SecurityFootgunSummary {
  counts: Record<SecurityFootgunSeverity, number>
  highestSeverity: SecurityFootgunSeverity | 'none'
  totalFindings: number
  thresholdBreaches: number
  shouldFail: boolean
  failureReason: string | null
  filesScanned: number
  suppressedFindings: number
}

export interface SecurityFootgunReport {
  policy: SecurityFootgunPolicy
  findings: SecurityFootgunFinding[]
  summary: SecurityFootgunSummary
  scannedFiles: string[]
  errors: string[]
}

export interface SecurityFootgunInputFile {
  path: string
  content: string
}

interface SecurityFootgunSuppression {
  all: boolean
  rules: Set<SecurityFootgunRuleId>
}

interface SecurityFootgunScanResult {
  findings: SecurityFootgunFinding[]
  suppressedCount: number
}

interface ChildProcessImportInfo {
  exec: Set<string>
  execSync: Set<string>
  spawn: Set<string>
  spawnSync: Set<string>
  namespaces: Set<string>
}

const SEVERITY_ORDER: Record<SecurityFootgunSeverity, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

const FILE_EXTENSION_PATTERN = /\.(?:c|m)?tsx?$/i
const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.|\/__tests__\/)/
const EXCLUDED_PATH_PARTS = ['/node_modules/', '/dist/', '/coverage/', '/.git/']

const RULES: Record<SecurityFootgunRuleId, SecurityFootgunRule> = {
  'dynamic-shell-interpolation': {
    id: 'dynamic-shell-interpolation',
    title: 'Dynamic shell command interpolation',
    description:
      'Interpolated shell commands at execution sinks can enable command injection.',
    severity: 'high',
  },
  'dangerous-eval': {
    id: 'dangerous-eval',
    title: 'Dynamic code execution',
    description:
      'Use of eval/new Function executes dynamic code and can enable arbitrary code execution.',
    severity: 'critical',
  },
  'unsafe-html-injection': {
    id: 'unsafe-html-injection',
    title: 'Unsafe HTML injection',
    description:
      'Injecting unsanitized HTML can lead to cross-site scripting vulnerabilities.',
    severity: 'high',
  },
  'tls-verification-bypass': {
    id: 'tls-verification-bypass',
    title: 'TLS verification bypass',
    description:
      'Disabling TLS certificate verification can expose connections to MITM attacks.',
    severity: 'high',
  },
  'insecure-temp-file': {
    id: 'insecure-temp-file',
    title: 'Insecure temp file construction',
    description:
      'Predictable temp file names in shared temp directories can cause race or overwrite risks.',
    severity: 'moderate',
  },
}

const RULE_ID_SET = new Set<SecurityFootgunRuleId>(Object.keys(RULES) as SecurityFootgunRuleId[])

const DEFAULT_THRESHOLD: SecurityFootgunSeverity = 'high'
const SUPPRESSION_DIRECTIVE = /security-footgun-ignore-(line|next-line)\b([^\n\r]*)/gi
const SUPPRESSION_TOKEN = /\*|[a-z][a-z0-9-]*/gi
const INSECURE_CURL_FLAG_PATTERN = /\bcurl\b[^\n\r]*(?:\s-k(?:\s|$)|--insecure\b)/i
const TLS_ENV_BYPASS_PATTERN = /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0\b/

export const DEFAULT_SECURITY_FOOTGUN_THRESHOLD = DEFAULT_THRESHOLD

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (normalized.startsWith('./')) {
    return normalized.slice(2)
  }
  return normalized
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression
  }
  return current
}

function getSeverityCounts(): Record<SecurityFootgunSeverity, number> {
  return {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  }
}

function normalizeSeverity(value?: string): SecurityFootgunSeverity {
  if (!value) return DEFAULT_THRESHOLD
  const lowered = value.trim().toLowerCase()
  if (isValidSecurityFootgunSeverity(lowered)) {
    return lowered
  }
  return DEFAULT_THRESHOLD
}

function severityAtOrAbove(
  severity: SecurityFootgunSeverity,
  threshold: SecurityFootgunSeverity
): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold]
}

function highestSeverity(
  counts: Record<SecurityFootgunSeverity, number>
): SecurityFootgunSeverity | 'none' {
  if (counts.critical > 0) return 'critical'
  if (counts.high > 0) return 'high'
  if (counts.moderate > 0) return 'moderate'
  if (counts.low > 0) return 'low'
  return 'none'
}

function getScriptKind(path: string): ts.ScriptKind {
  return path.toLowerCase().endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function createChildProcessImportInfo(): ChildProcessImportInfo {
  return {
    exec: new Set<string>(),
    execSync: new Set<string>(),
    spawn: new Set<string>(),
    spawnSync: new Set<string>(),
    namespaces: new Set<string>(),
  }
}

function isChildProcessModule(specifier: string): boolean {
  return specifier === 'child_process' || specifier === 'node:child_process'
}

function collectChildProcessImports(sourceFile: ts.SourceFile): ChildProcessImportInfo {
  const info = createChildProcessImportInfo()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue
    }

    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }

    if (!isChildProcessModule(statement.moduleSpecifier.text)) {
      continue
    }

    const importClause = statement.importClause
    if (!importClause) {
      continue
    }

    const namedBindings = importClause.namedBindings
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      info.namespaces.add(namedBindings.name.text)
      continue
    }

    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text
        const local = element.name.text
        if (imported === 'exec') info.exec.add(local)
        if (imported === 'execSync') info.execSync.add(local)
        if (imported === 'spawn') info.spawn.add(local)
        if (imported === 'spawnSync') info.spawnSync.add(local)
      }
    }
  }

  return info
}

function isStringLiteralLike(
  expression: ts.Expression
): expression is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
}

function isStaticStringExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (isStringLiteralLike(unwrapped)) {
    return true
  }

  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isStaticStringExpression(unwrapped.left) && isStaticStringExpression(unwrapped.right)
  }

  return false
}

function isKnownChildProcessNamespace(
  expression: ts.Expression,
  imports: ChildProcessImportInfo
): boolean {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isIdentifier(unwrapped)) {
    return false
  }

  if (imports.namespaces.has(unwrapped.text)) {
    return true
  }

  return (
    unwrapped.text === 'child_process' ||
    unwrapped.text === 'childProcess' ||
    unwrapped.text === 'cp'
  )
}

function isShellSinkCall(
  call: ts.CallExpression,
  imports: ChildProcessImportInfo
): boolean {
  const expression = call.expression
  if (ts.isIdentifier(expression)) {
    return imports.exec.has(expression.text) || imports.execSync.has(expression.text)
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (!isKnownChildProcessNamespace(expression.expression, imports)) {
      return false
    }
    return expression.name.text === 'exec' || expression.name.text === 'execSync'
  }
  return false
}

function isSpawnCall(call: ts.CallExpression, imports: ChildProcessImportInfo): boolean {
  const expression = call.expression
  if (ts.isIdentifier(expression)) {
    return imports.spawn.has(expression.text) || imports.spawnSync.has(expression.text)
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (!isKnownChildProcessNamespace(expression.expression, imports)) {
      return false
    }
    return expression.name.text === 'spawn' || expression.name.text === 'spawnSync'
  }
  return false
}

function hasShellTrueOption(call: ts.CallExpression): boolean {
  const optionsArgIndex = call.arguments.length >= 3 ? 2 : 1
  const optionsArg = call.arguments[optionsArgIndex]
  if (!optionsArg || !ts.isObjectLiteralExpression(unwrapExpression(optionsArg))) {
    return false
  }

  const objectLiteral = unwrapExpression(optionsArg)
  if (!ts.isObjectLiteralExpression(objectLiteral)) {
    return false
  }

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue
    }

    const name = getPropertyNameText(property.name)
    if (name !== 'shell') {
      continue
    }

    const initializer = unwrapExpression(property.initializer)
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return true
    }
  }

  return false
}

function isPotentialStringConstruction(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)

  if (isStringLiteralLike(unwrapped)) {
    return true
  }

  if (ts.isTemplateExpression(unwrapped)) {
    return true
  }

  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      isPotentialStringConstruction(unwrapped.left) ||
      isPotentialStringConstruction(unwrapped.right)
    )
  }

  return false
}

function isDynamicShellCommand(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)

  if (isStaticStringExpression(unwrapped)) {
    return false
  }

  if (ts.isTemplateExpression(unwrapped)) {
    return unwrapped.templateSpans.length > 0
  }

  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      isPotentialStringConstruction(unwrapped) &&
      !isStaticStringExpression(unwrapped)
    )
  }

  return false
}

function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function isFalseLikeLiteral(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  return unwrapped.kind === ts.SyntaxKind.FalseKeyword
}

function isZeroLikeLiteral(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (ts.isNumericLiteral(unwrapped)) {
    return unwrapped.text === '0'
  }
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text.trim() === '0'
  }
  return false
}

function isIdentifierNamed(expression: ts.Expression, expected: string): boolean {
  return ts.isIdentifier(expression) && expression.text === expected
}

function isPropertyAccessNamed(
  expression: ts.Expression,
  objectName: string,
  propertyName: string
): boolean {
  if (!ts.isPropertyAccessExpression(expression)) {
    return false
  }
  return isIdentifierNamed(expression.expression, objectName) && expression.name.text === propertyName
}

function isProcessEnvTlsBypassTarget(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isPropertyAccessExpression(unwrapped)) {
    return false
  }

  if (unwrapped.name.text !== 'NODE_TLS_REJECT_UNAUTHORIZED') {
    return false
  }

  return isPropertyAccessNamed(unwrapped.expression, 'process', 'env')
}

function expressionText(sourceFile: ts.SourceFile, expression: ts.Expression): string {
  return sourceFile.text.slice(expression.getStart(sourceFile), expression.getEnd())
}

function expressionContainsPattern(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  pattern: RegExp
): boolean {
  const text = expressionText(sourceFile, expression)
  return pattern.test(text)
}

function callIncludesCurlInsecureFlag(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  childProcessImports: ChildProcessImportInfo
): boolean {
  const [firstArg, secondArg] = call.arguments
  if (!firstArg) return false

  const first = unwrapExpression(firstArg)

  if (
    isSpawnCall(call, childProcessImports) &&
    isStringLiteralLike(first) &&
    first.text === 'curl' &&
    secondArg
  ) {
    const args = unwrapExpression(secondArg)
    if (ts.isArrayLiteralExpression(args)) {
      for (const element of args.elements) {
        if (!ts.isExpression(element)) {
          continue
        }
        const unwrapped = unwrapExpression(element)
        if (
          (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) &&
          (unwrapped.text === '-k' || unwrapped.text === '--insecure')
        ) {
          return true
        }
      }
    }
  }

  if (isStringLiteralLike(first)) {
    return INSECURE_CURL_FLAG_PATTERN.test(first.text) || TLS_ENV_BYPASS_PATTERN.test(first.text)
  }

  if (ts.isArrayLiteralExpression(first)) {
    const entries = first.elements
      .filter((element): element is ts.Expression => ts.isExpression(element))
      .map((element) => unwrapExpression(element))

    const joined = entries
      .map((entry) => (isStringLiteralLike(entry) ? entry.text : expressionText(sourceFile, entry)))
      .join(' ')

    return INSECURE_CURL_FLAG_PATTERN.test(joined) || TLS_ENV_BYPASS_PATTERN.test(joined)
  }

  if (isStringLiteralLike(first)) {
    return false
  }

  return expressionContainsPattern(first, sourceFile, INSECURE_CURL_FLAG_PATTERN)
}

function hasUnsafeHtmlExpression(expression: ts.Expression): boolean {
  return !isStaticStringExpression(expression)
}

function getJsxAttributeExpression(
  initializer: ts.JsxAttributeValue | undefined
): ts.Expression | null {
  if (!initializer) return null
  if (!ts.isJsxExpression(initializer)) return null
  if (!initializer.expression) return null
  return initializer.expression
}

function getJsxAttributeNameText(name: ts.JsxAttributeName): string | null {
  if (ts.isIdentifier(name)) {
    return name.text
  }
  if (ts.isJsxNamespacedName(name)) {
    return `${name.namespace.text}:${name.name.text}`
  }
  return null
}

function getDangerouslySetInnerHtmlValue(expression: ts.Expression): ts.Expression | null {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped
  }

  for (const property of unwrapped.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue
    }

    const name = getPropertyNameText(property.name)
    if (name !== '__html') {
      continue
    }

    return property.initializer
  }

  return unwrapped
}

function isMathRandomCall(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isCallExpression(unwrapped)) {
    return false
  }
  if (!ts.isPropertyAccessExpression(unwrapped.expression)) {
    return false
  }
  return (
    isIdentifierNamed(unwrapped.expression.expression, 'Math') &&
    unwrapped.expression.name.text === 'random'
  )
}

function isDateNowCall(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isCallExpression(unwrapped)) {
    return false
  }
  if (!ts.isPropertyAccessExpression(unwrapped.expression)) {
    return false
  }
  return (
    isIdentifierNamed(unwrapped.expression.expression, 'Date') &&
    unwrapped.expression.name.text === 'now'
  )
}

function isTmpdirCall(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isCallExpression(unwrapped)) {
    return false
  }

  if (ts.isPropertyAccessExpression(unwrapped.expression)) {
    if (
      isIdentifierNamed(unwrapped.expression.expression, 'os') &&
      unwrapped.expression.name.text === 'tmpdir'
    ) {
      return true
    }
  }

  if (ts.isIdentifier(unwrapped.expression)) {
    return unwrapped.expression.text === 'tmpdir'
  }

  return false
}

function stringNodeContainsTmpMarker(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)

  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    const lowered = unwrapped.text.toLowerCase()
    return lowered.includes('/tmp') || lowered.includes('\\tmp')
  }

  if (ts.isTemplateExpression(unwrapped)) {
    const fullText = [
      unwrapped.head.text,
      ...unwrapped.templateSpans.flatMap((span) => [span.literal.text]),
    ]
      .join('')
      .toLowerCase()

    return fullText.includes('/tmp') || fullText.includes('\\tmp')
  }

  return false
}

function containsTmpMarker(
  expression: ts.Expression | ts.Node,
  knownTmpSymbols: Set<string>
): boolean {
  const unwrapped = ts.isExpression(expression)
    ? unwrapExpression(expression)
    : expression

  if (
    ts.isExpression(unwrapped) &&
    (stringNodeContainsTmpMarker(unwrapped) || isTmpdirCall(unwrapped))
  ) {
    return true
  }

  if (ts.isIdentifier(unwrapped) && knownTmpSymbols.has(unwrapped.text)) {
    return true
  }

  let found = false
  unwrapped.forEachChild((child) => {
    if (found) {
      return
    }
    if (containsTmpMarker(child, knownTmpSymbols)) {
      found = true
    }
  })

  return found
}

function containsPredictableToken(
  expression: ts.Expression | ts.Node,
  knownPredictableSymbols: Set<string>
): boolean {
  const unwrapped = ts.isExpression(expression)
    ? unwrapExpression(expression)
    : expression

  if (ts.isExpression(unwrapped) && (isMathRandomCall(unwrapped) || isDateNowCall(unwrapped))) {
    return true
  }

  if (ts.isIdentifier(unwrapped) && knownPredictableSymbols.has(unwrapped.text)) {
    return true
  }

  let found = false
  unwrapped.forEachChild((child) => {
    if (found) {
      return
    }
    if (containsPredictableToken(child, knownPredictableSymbols)) {
      found = true
    }
  })

  return found
}

function isPathConstructionExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)

  if (ts.isTemplateExpression(unwrapped)) {
    return true
  }

  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return true
  }

  if (ts.isCallExpression(unwrapped) && ts.isPropertyAccessExpression(unwrapped.expression)) {
    const name = unwrapped.expression.name.text
    return name === 'join' || name === 'resolve'
  }

  return false
}

function createFinding(
  sourceFile: ts.SourceFile,
  filePath: string,
  ruleId: SecurityFootgunRuleId,
  node: ts.Node,
  message: string
): SecurityFootgunFinding {
  const start = node.getStart(sourceFile)
  const location = sourceFile.getLineAndCharacterOfPosition(start)
  const line = location.line + 1
  const column = location.character + 1
  const lineText = sourceFile.text.split('\n')[location.line] ?? ''

  return {
    ruleId,
    severity: RULES[ruleId].severity,
    title: RULES[ruleId].title,
    message,
    filePath,
    line,
    column,
    snippet: lineText.trim(),
  }
}

function getCommentBody(commentText: string): { body: string; bodyStartOffset: number } {
  if (commentText.startsWith('//')) {
    return {
      body: commentText.slice(2),
      bodyStartOffset: 2,
    }
  }

  if (commentText.startsWith('/*') && commentText.endsWith('*/')) {
    return {
      body: commentText.slice(2, -2),
      bodyStartOffset: 2,
    }
  }

  return {
    body: commentText,
    bodyStartOffset: 0,
  }
}

function parseSuppressionRules(trailing: string): SecurityFootgunSuppression | null {
  const trimmed = trailing.trim()
  if (trimmed.length === 0) {
    return { all: true, rules: new Set<SecurityFootgunRuleId>() }
  }

  const tokens = trimmed.match(SUPPRESSION_TOKEN) ?? []
  const lowered = tokens.map((token) => token.toLowerCase())

  if (lowered.includes('*')) {
    return { all: true, rules: new Set<SecurityFootgunRuleId>() }
  }

  const rules = new Set<SecurityFootgunRuleId>()
  for (const token of lowered) {
    if (RULE_ID_SET.has(token as SecurityFootgunRuleId)) {
      rules.add(token as SecurityFootgunRuleId)
    }
  }

  if (rules.size === 0) {
    return null
  }

  return { all: false, rules }
}

function addSuppression(
  suppressions: Map<number, SecurityFootgunSuppression>,
  line: number,
  suppression: SecurityFootgunSuppression
) {
  if (line < 1) return

  const existing = suppressions.get(line)
  if (!existing) {
    suppressions.set(line, {
      all: suppression.all,
      rules: new Set(suppression.rules),
    })
    return
  }

  if (suppression.all) {
    existing.all = true
    existing.rules.clear()
    return
  }

  for (const rule of suppression.rules) {
    existing.rules.add(rule)
  }
}

function collectSuppressions(sourceFile: ts.SourceFile): Map<number, SecurityFootgunSuppression> {
  const suppressions = new Map<number, SecurityFootgunSuppression>()
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text
  )

  while (true) {
    const token = scanner.scan()
    if (token === ts.SyntaxKind.EndOfFileToken) {
      break
    }

    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue
    }

    const tokenStart = scanner.getTokenPos()
    const tokenEnd = scanner.getTextPos()
    const commentText = sourceFile.text.slice(tokenStart, tokenEnd)
    const { body, bodyStartOffset } = getCommentBody(commentText)

    SUPPRESSION_DIRECTIVE.lastIndex = 0
    while (true) {
      const match = SUPPRESSION_DIRECTIVE.exec(body)
      if (!match) {
        break
      }

      const directiveType = match[1]
      const trailing = match[2] ?? ''
      const suppression = parseSuppressionRules(trailing)
      if (!suppression) {
        continue
      }

      const directiveStart = tokenStart + bodyStartOffset + match.index
      const directiveLine = sourceFile.getLineAndCharacterOfPosition(directiveStart).line + 1
      const targetLine = directiveType === 'next-line' ? directiveLine + 1 : directiveLine
      addSuppression(suppressions, targetLine, suppression)
    }
  }

  return suppressions
}

function isSuppressed(
  suppressions: Map<number, SecurityFootgunSuppression>,
  line: number,
  ruleId: SecurityFootgunRuleId
): boolean {
  const suppression = suppressions.get(line)
  if (!suppression) {
    return false
  }
  return suppression.all || suppression.rules.has(ruleId)
}

function addFindingWithSuppression(
  findings: SecurityFootgunFinding[],
  suppressions: Map<number, SecurityFootgunSuppression>,
  candidate: SecurityFootgunFinding
): boolean {
  if (isSuppressed(suppressions, candidate.line, candidate.ruleId)) {
    return false
  }

  findings.push(candidate)
  return true
}

function scanFile(file: SecurityFootgunInputFile, enableSuppressions: boolean): SecurityFootgunScanResult {
  const normalizedPath = normalizePath(file.path)
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(normalizedPath)
  )

  const suppressions = enableSuppressions
    ? collectSuppressions(sourceFile)
    : new Map<number, SecurityFootgunSuppression>()
  const childProcessImports = collectChildProcessImports(sourceFile)
  const findings: SecurityFootgunFinding[] = []
  const findingKeys = new Set<string>()
  let suppressedCount = 0

  const predictableSymbols = new Set<string>()
  const tmpSymbols = new Set<string>()

  const pushFinding = (
    ruleId: SecurityFootgunRuleId,
    node: ts.Node,
    message: string
  ) => {
    const finding = createFinding(sourceFile, normalizedPath, ruleId, node, message)
    const key = `${finding.ruleId}:${finding.filePath}:${finding.line}:${finding.column}:${finding.message}`
    if (findingKeys.has(key)) {
      return
    }

    if (!addFindingWithSuppression(findings, suppressions, finding)) {
      suppressedCount += 1
      return
    }

    findingKeys.add(key)
  }

  const registerTrackedSymbol = (name: ts.BindingName, set: Set<string>) => {
    if (ts.isIdentifier(name)) {
      set.add(name.text)
    }
  }

  const rememberPredictableAndTmpSymbols = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer
      if (containsPredictableToken(initializer, predictableSymbols)) {
        registerTrackedSymbol(node.name, predictableSymbols)
      }
      if (containsTmpMarker(initializer, tmpSymbols)) {
        registerTrackedSymbol(node.name, tmpSymbols)
      }
      return
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (!ts.isIdentifier(node.left)) {
        return
      }
      if (containsPredictableToken(node.right, predictableSymbols)) {
        predictableSymbols.add(node.left.text)
      }
      if (containsTmpMarker(node.right, tmpSymbols)) {
        tmpSymbols.add(node.left.text)
      }
    }
  }

  const visit = (node: ts.Node) => {
    rememberPredictableAndTmpSymbols(node)

    if (ts.isCallExpression(node)) {
      if (
        isShellSinkCall(node, childProcessImports) ||
        (isSpawnCall(node, childProcessImports) && hasShellTrueOption(node))
      ) {
        const command = node.arguments[0]
        if (command && isDynamicShellCommand(command)) {
          pushFinding(
            'dynamic-shell-interpolation',
            command,
            'Dynamic command string interpolation at a shell execution sink.'
          )
        }
      }

      if (isShellSinkCall(node, childProcessImports) || isSpawnCall(node, childProcessImports)) {
        if (callIncludesCurlInsecureFlag(node, sourceFile, childProcessImports)) {
          pushFinding(
            'tls-verification-bypass',
            node,
            'Command appears to disable TLS verification (curl -k/--insecure or NODE_TLS_REJECT_UNAUTHORIZED=0).'
          )
        }
      }

      const callee = node.expression
      if (
        (ts.isIdentifier(callee) && callee.text === 'eval') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'eval')
      ) {
        pushFinding(
          'dangerous-eval',
          node,
          'Avoid eval(...); execute explicit code paths instead of dynamic strings.'
        )
      }

      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'insertAdjacentHTML') {
        const htmlArg = node.arguments[1]
        if (htmlArg && hasUnsafeHtmlExpression(htmlArg)) {
          pushFinding(
            'unsafe-html-injection',
            htmlArg,
            'insertAdjacentHTML with non-literal HTML can inject unsanitized content.'
          )
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const expression = node.expression
      if (
        (ts.isIdentifier(expression) && expression.text === 'Function') ||
        (ts.isPropertyAccessExpression(expression) && expression.name.text === 'Function')
      ) {
        pushFinding(
          'dangerous-eval',
          node,
          'Avoid new Function(...); it behaves like eval and executes dynamic code.'
        )
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (
        ts.isPropertyAccessExpression(node.left) &&
        (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML') &&
        hasUnsafeHtmlExpression(node.right)
      ) {
        pushFinding(
          'unsafe-html-injection',
          node.right,
          `${node.left.name.text} assignment with non-literal HTML can create XSS risk.`
        )
      }

      if (
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === 'rejectUnauthorized' &&
        isFalseLikeLiteral(node.right)
      ) {
        pushFinding(
          'tls-verification-bypass',
          node,
          'Setting rejectUnauthorized to false bypasses TLS certificate verification.'
        )
      }

      if (isProcessEnvTlsBypassTarget(node.left) && (isZeroLikeLiteral(node.right) || isFalseLikeLiteral(node.right))) {
        pushFinding(
          'tls-verification-bypass',
          node,
          'Setting NODE_TLS_REJECT_UNAUTHORIZED to 0/false disables TLS verification.'
        )
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const propertyName = getPropertyNameText(node.name)
      if (propertyName === 'rejectUnauthorized' && isFalseLikeLiteral(node.initializer)) {
        pushFinding(
          'tls-verification-bypass',
          node,
          'rejectUnauthorized: false bypasses TLS certificate verification.'
        )
      }
    }

    if (
      ts.isJsxAttribute(node) &&
      getJsxAttributeNameText(node.name) === 'dangerouslySetInnerHTML'
    ) {
      const attributeExpression = getJsxAttributeExpression(node.initializer)
      if (attributeExpression) {
        const htmlValue = getDangerouslySetInnerHtmlValue(attributeExpression)
        if (htmlValue && hasUnsafeHtmlExpression(htmlValue)) {
          pushFinding(
            'unsafe-html-injection',
            htmlValue,
            'dangerouslySetInnerHTML uses non-literal HTML; sanitize content before injection.'
          )
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer
      if (
        isPathConstructionExpression(initializer) &&
        containsTmpMarker(initializer, tmpSymbols) &&
        containsPredictableToken(initializer, predictableSymbols)
      ) {
        pushFinding(
          'insecure-temp-file',
          initializer,
          'Temp path uses predictable entropy (Date.now/Math.random). Prefer mkdtemp/randomUUID.'
        )
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (
        isPathConstructionExpression(node.right) &&
        containsTmpMarker(node.right, tmpSymbols) &&
        containsPredictableToken(node.right, predictableSymbols)
      ) {
        pushFinding(
          'insecure-temp-file',
          node.right,
          'Temp path uses predictable entropy (Date.now/Math.random). Prefer mkdtemp/randomUUID.'
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return {
    findings,
    suppressedCount,
  }
}

export function isSecurityFootgunTargetFile(path: string): boolean {
  const normalized = normalizePath(path)
  if (!FILE_EXTENSION_PATTERN.test(normalized)) {
    return false
  }

  const scoped = normalized.startsWith('src/') || normalized.startsWith('scripts/')
  if (!scoped) {
    return false
  }

  if (TEST_FILE_PATTERN.test(normalized)) {
    return false
  }

  for (const excluded of EXCLUDED_PATH_PARTS) {
    if (normalized.includes(excluded)) {
      return false
    }
  }

  return true
}

function countThresholdBreaches(
  findings: SecurityFootgunFinding[],
  threshold: SecurityFootgunSeverity
): number {
  let breaches = 0
  for (const finding of findings) {
    if (severityAtOrAbove(finding.severity, threshold)) {
      breaches += 1
    }
  }
  return breaches
}

export function analyzeSecurityFootguns(options: {
  files: SecurityFootgunInputFile[]
  threshold?: string
  enableSuppressions?: boolean
}): SecurityFootgunReport {
  const errors: string[] = []
  const normalizedThreshold = normalizeSeverity(options.threshold)

  if (options.threshold && !isValidSecurityFootgunSeverity(options.threshold.toLowerCase())) {
    errors.push(
      `Invalid threshold "${options.threshold}". Using default "${DEFAULT_THRESHOLD}".`
    )
  }

  const filteredFiles = options.files
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .filter((file) => isSecurityFootgunTargetFile(file.path))
    .sort((left, right) => compareStrings(left.path, right.path))

  const findings: SecurityFootgunFinding[] = []
  let suppressedFindings = 0

  for (const file of filteredFiles) {
    const result = scanFile(file, options.enableSuppressions !== false)
    findings.push(...result.findings)
    suppressedFindings += result.suppressedCount
  }

  findings.sort((left, right) => {
    const severityDelta = SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]
    if (severityDelta !== 0) {
      return severityDelta
    }

    const pathDelta = compareStrings(left.filePath, right.filePath)
    if (pathDelta !== 0) {
      return pathDelta
    }

    if (left.line !== right.line) {
      return left.line - right.line
    }

    if (left.column !== right.column) {
      return left.column - right.column
    }

    return compareStrings(left.ruleId, right.ruleId)
  })

  const counts = getSeverityCounts()
  for (const finding of findings) {
    counts[finding.severity] += 1
  }

  const thresholdBreaches = countThresholdBreaches(findings, normalizedThreshold)
  const shouldFail = thresholdBreaches > 0

  return {
    policy: {
      threshold: normalizedThreshold,
    },
    findings,
    summary: {
      counts,
      highestSeverity: highestSeverity(counts),
      totalFindings: findings.length,
      thresholdBreaches,
      shouldFail,
      failureReason: shouldFail
        ? `Security foot-gun findings at or above "${normalizedThreshold}": ${thresholdBreaches}.`
        : null,
      filesScanned: filteredFiles.length,
      suppressedFindings,
    },
    scannedFiles: filteredFiles.map((file) => file.path),
    errors,
  }
}

export function isValidSecurityFootgunSeverity(
  value: string
): value is SecurityFootgunSeverity {
  return SECURITY_FOOTGUN_SEVERITIES.includes(value as SecurityFootgunSeverity)
}

export function getSecurityFootgunRules(): SecurityFootgunRule[] {
  return Object.values(RULES)
}
