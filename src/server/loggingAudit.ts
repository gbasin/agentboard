import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

export type LoggingAuditSeverity = 'high' | 'medium' | 'low'

export type LoggingAuditRule =
  | 'catch_without_logging'
  | 'non_snake_case_event_name'
  | 'missing_error_context'

export interface LoggingAuditFinding {
  severity: LoggingAuditSeverity
  rule: LoggingAuditRule
  file: string
  line: number
  message: string
}

export interface LoggingAuditReport {
  scannedFiles: number
  findings: LoggingAuditFinding[]
  counts: Record<LoggingAuditSeverity, number>
}

export interface LoggingAuditOptions {
  rootDir?: string
  serverDir?: string
  files?: string[]
}

const SNAKE_CASE_EVENT = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const LOGGER_LEVELS = new Set(['debug', 'info', 'warn', 'error'] as const)
const ERROR_CONTEXT_FIELDS = new Set([
  'error',
  'error_name',
  'error_message',
  'error_stack',
  'message',
  'code',
  'cause',
  'stack',
  'name',
])
const CATCH_SUPPRESSION_MARKER = /logging-audit:\s*(ignore|intentional)/i
const APP_ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
const KNOWN_LOGGING_WRAPPERS = new Set(['rollbackMigration'])
const COMMENT_PATTERN = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g
const ERROR_SIGNAL_PATTERN = /(error|err|exception|cause|stack|code|message)/i

type LoggerLevel = 'debug' | 'info' | 'warn' | 'error' | 'unknown'

interface LoggerCall {
  level: LoggerLevel
  eventArg: ts.Expression | undefined
  dataArg: ts.Expression | undefined
  node: ts.CallExpression
}

const severityRank: Record<LoggingAuditSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

export async function runLoggingAudit(
  options: LoggingAuditOptions = {}
): Promise<LoggingAuditReport> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd())
  const serverDir = path.resolve(options.serverDir ?? path.join(rootDir, 'src/server'))
  const files = options.files
    ? options.files.map((file) => path.resolve(rootDir, file)).toSorted()
    : await listServerFiles(serverDir)

  const findings: LoggingAuditFinding[] = []
  for (const filePath of files) {
    findings.push(...auditFile(filePath, rootDir))
  }
  findings.sort(compareFindings)

  return {
    scannedFiles: files.length,
    findings,
    counts: countBySeverity(findings),
  }
}

export function formatLoggingAuditReport(report: LoggingAuditReport): string {
  const lines = [
    `logging_audit scanned_files=${report.scannedFiles} high=${report.counts.high} medium=${report.counts.medium} low=${report.counts.low}`,
  ]

  if (report.findings.length === 0) {
    lines.push('logging_audit_result clean')
    return lines.join('\n')
  }

  for (const finding of report.findings) {
    lines.push(
      [
        finding.severity.toUpperCase(),
        finding.rule,
        `${finding.file}:${finding.line}`,
        finding.message,
      ].join(' ')
    )
  }

  return lines.join('\n')
}

function compareFindings(a: LoggingAuditFinding, b: LoggingAuditFinding): number {
  if (severityRank[a.severity] !== severityRank[b.severity]) {
    return severityRank[a.severity] - severityRank[b.severity]
  }
  if (a.file !== b.file) return a.file.localeCompare(b.file)
  if (a.line !== b.line) return a.line - b.line
  if (a.rule !== b.rule) return a.rule.localeCompare(b.rule)
  return a.message.localeCompare(b.message)
}

function countBySeverity(findings: LoggingAuditFinding[]) {
  const counts: Record<LoggingAuditSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0,
  }
  for (const finding of findings) {
    counts[finding.severity] += 1
  }
  return counts
}

async function listServerFiles(serverDir: string): Promise<string[]> {
  const files: string[] = []
  await walk(serverDir, files)
  return files.toSorted()
}

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '__tests__') {
      continue
    }
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, files)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (!entry.name.endsWith('.ts')) {
      continue
    }
    if (entry.name.endsWith('.test.ts')) {
      continue
    }
    files.push(fullPath)
  }
}

function auditFile(filePath: string, rootDir: string): LoggingAuditFinding[] {
  const sourceText = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const relativeFile = toPosix(path.relative(rootDir, filePath))
  const findings: LoggingAuditFinding[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      auditCatchClause(node, sourceFile, relativeFile, findings)
      ts.forEachChild(node.block, visit)
      return
    }

    if (ts.isCallExpression(node)) {
      auditLoggerEventName(node, sourceFile, relativeFile, findings)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return findings
}

function auditLoggerEventName(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  findings: LoggingAuditFinding[]
): void {
  const loggerCall = toLoggerCall(node)
  if (!loggerCall) {
    return
  }

  const eventName = getStaticEventName(loggerCall.eventArg)
  if (eventName !== null && !SNAKE_CASE_EVENT.test(eventName)) {
    findings.push({
      severity: 'medium',
      rule: 'non_snake_case_event_name',
      file: relativeFile,
      line: getLine(sourceFile, loggerCall.eventArg ?? loggerCall.node),
      message: `event "${eventName}" is not snake_case`,
    })
  }
}

function auditCatchClause(
  catchClause: ts.CatchClause,
  sourceFile: ts.SourceFile,
  relativeFile: string,
  findings: LoggingAuditFinding[]
): void {
  const loggerCalls = collectLoggerCalls(catchClause.block)
  const hasLoggingWrapper = hasKnownLoggingWrapperCall(catchClause.block)
  const suppressed = isCatchSuppressed(catchClause, sourceFile)

  if (loggerCalls.length === 0 && !hasLoggingWrapper && !suppressed) {
    findings.push({
      severity: severityForCatch(relativeFile, catchClause),
      rule: 'catch_without_logging',
      file: relativeFile,
      line: getLine(sourceFile, catchClause),
      message: 'catch block does not emit a structured logger event',
    })
    return
  }

  for (const call of loggerCalls) {
    if (call.level !== 'warn' && call.level !== 'error') {
      continue
    }
    if (hasErrorContext(call.dataArg)) {
      continue
    }
    const eventName = getStaticEventName(call.eventArg)
    findings.push({
      severity: severityForCatch(relativeFile, catchClause),
      rule: 'missing_error_context',
      file: relativeFile,
      line: getLine(sourceFile, call.node),
      message: `logger.${call.level}(${eventName ? `"${eventName}"` : 'dynamic event'}) is missing error context fields`,
    })
  }
}

function collectLoggerCalls(node: ts.Node): LoggerCall[] {
  const calls: LoggerCall[] = []

  const walkNode = (next: ts.Node, isRoot = false): void => {
    if (!isRoot && isNestedScopeBoundary(next)) {
      return
    }

    if (ts.isCallExpression(next)) {
      const loggerCall = toLoggerCall(next)
      if (loggerCall) {
        calls.push(loggerCall)
      }
    }
    ts.forEachChild(next, (child) => walkNode(child))
  }

  walkNode(node, true)
  return calls
}

function hasKnownLoggingWrapperCall(node: ts.Node): boolean {
  let found = false

  const visit = (next: ts.Node, isRoot = false): void => {
    if (found) {
      return
    }
    if (!isRoot && isNestedScopeBoundary(next)) {
      return
    }
    if (
      ts.isCallExpression(next) &&
      ts.isIdentifier(next.expression) &&
      KNOWN_LOGGING_WRAPPERS.has(next.expression.text)
    ) {
      found = true
      return
    }
    ts.forEachChild(next, (child) => visit(child))
  }

  visit(node, true)
  return found
}

function isNestedScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  )
}

function toLoggerCall(node: ts.CallExpression): LoggerCall | null {
  const level = getLoggerLevel(node.expression)
  if (!level) {
    return null
  }

  return {
    level,
    eventArg: node.arguments[0],
    dataArg: node.arguments[1],
    node,
  }
}

function getLoggerLevel(expression: ts.LeftHandSideExpression): LoggerLevel | null {
  if (ts.isPropertyAccessExpression(expression)) {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'logger') {
      return null
    }
    const level = expression.name.text
    return LOGGER_LEVELS.has(level as Exclude<LoggerLevel, 'unknown'>)
      ? (level as Exclude<LoggerLevel, 'unknown'>)
      : null
  }

  if (ts.isElementAccessExpression(expression)) {
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'logger') {
      return null
    }

    const arg = expression.argumentExpression
    if (!arg) {
      return 'unknown'
    }

    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const level = arg.text
      return LOGGER_LEVELS.has(level as Exclude<LoggerLevel, 'unknown'>)
        ? (level as Exclude<LoggerLevel, 'unknown'>)
        : 'unknown'
    }

    return 'unknown'
  }

  return null
}

function getStaticEventName(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = getStaticEventName(node.left)
    const right = getStaticEventName(node.right)
    if (left !== null && right !== null) {
      return `${left}${right}`
    }
  }
  return null
}

function hasErrorContext(dataArg: ts.Expression | undefined): boolean {
  if (!dataArg) {
    return false
  }

  if (!ts.isObjectLiteralExpression(dataArg)) {
    return expressionHasErrorSignal(dataArg)
  }

  for (const property of dataArg.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (expressionHasErrorSignal(property.expression)) {
        return true
      }
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (
        ERROR_CONTEXT_FIELDS.has(toSnakeCase(property.name.text)) ||
        expressionHasErrorSignal(property.name)
      ) {
        return true
      }
      continue
    }
    if (ts.isPropertyAssignment(property)) {
      const propertyName = getPropertyName(property.name)
      if (propertyName && ERROR_CONTEXT_FIELDS.has(toSnakeCase(propertyName))) {
        return true
      }
      if (expressionHasErrorSignal(property.initializer)) {
        return true
      }
    }
  }

  return false
}

function expressionHasErrorSignal(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return ERROR_SIGNAL_PATTERN.test(expression.text)
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ERROR_SIGNAL_PATTERN.test(expression.name.text) ||
      expressionHasErrorSignal(expression.expression)
    )
  }

  if (ts.isElementAccessExpression(expression)) {
    if (expression.argumentExpression) {
      if (
        ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
      ) {
        if (ERROR_SIGNAL_PATTERN.test(expression.argumentExpression.text)) {
          return true
        }
      } else if (expressionHasErrorSignal(expression.argumentExpression)) {
        return true
      }
    }
    return expressionHasErrorSignal(expression.expression)
  }

  if (ts.isCallExpression(expression)) {
    if (expressionHasErrorSignal(expression.expression)) {
      return true
    }
    return expression.arguments.some((arg) => expressionHasErrorSignal(arg))
  }

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property) && expressionHasErrorSignal(property.expression)) {
        return true
      }
      if (ts.isShorthandPropertyAssignment(property) && expressionHasErrorSignal(property.name)) {
        return true
      }
      if (ts.isPropertyAssignment(property)) {
        const propertyName = getPropertyName(property.name)
        if (propertyName && ERROR_SIGNAL_PATTERN.test(propertyName)) {
          return true
        }
        if (expressionHasErrorSignal(property.initializer)) {
          return true
        }
      }
    }
    return false
  }

  if (ts.isConditionalExpression(expression)) {
    return (
      expressionHasErrorSignal(expression.whenTrue) ||
      expressionHasErrorSignal(expression.whenFalse)
    )
  }

  if (ts.isBinaryExpression(expression)) {
    return (
      expressionHasErrorSignal(expression.left) ||
      expressionHasErrorSignal(expression.right)
    )
  }

  if (ts.isParenthesizedExpression(expression)) {
    return expressionHasErrorSignal(expression.expression)
  }

  if (ts.isAsExpression(expression)) {
    return expressionHasErrorSignal(expression.expression)
  }

  if (ts.isTypeAssertionExpression(expression)) {
    return expressionHasErrorSignal(expression.expression)
  }

  if (ts.isNonNullExpression(expression)) {
    return expressionHasErrorSignal(expression.expression)
  }

  return false
}

function isCatchSuppressed(catchClause: ts.CatchClause, sourceFile: ts.SourceFile): boolean {
  const sourceText = sourceFile.getFullText()
  const ranges = [
    ...(ts.getLeadingCommentRanges(sourceText, catchClause.getFullStart()) ?? []),
    ...(ts.getLeadingCommentRanges(sourceText, catchClause.block.getFullStart()) ?? []),
  ]

  for (const range of ranges) {
    const commentText = sourceText.slice(range.pos, range.end)
    if (CATCH_SUPPRESSION_MARKER.test(commentText)) {
      return true
    }
  }

  const blockText = sourceText.slice(catchClause.block.getFullStart(), catchClause.block.end)
  for (const comment of blockText.match(COMMENT_PATTERN) ?? []) {
    if (CATCH_SUPPRESSION_MARKER.test(comment)) {
      return true
    }
  }

  return false
}

function getPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) {
    return name.text
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z])/g, '_$1')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

function severityForCatch(
  relativeFile: string,
  catchClause: ts.CatchClause
): LoggingAuditSeverity {
  if (isApiRouteCatch(catchClause)) {
    return 'high'
  }
  if (relativeFile === 'src/server/db.ts' && isMigrationCatch(catchClause)) {
    return 'high'
  }
  return 'medium'
}

function isApiRouteCatch(catchClause: ts.CatchClause): boolean {
  let node: ts.Node | undefined = catchClause.parent
  while (node) {
    if (ts.isCallExpression(node)) {
      if (!ts.isPropertyAccessExpression(node.expression)) {
        node = node.parent
        continue
      }
      const callee = node.expression
      if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'app') {
        node = node.parent
        continue
      }
      if (!APP_ROUTE_METHODS.has(callee.name.text)) {
        node = node.parent
        continue
      }
      const routeArg = node.arguments[0]
      return Boolean(
        routeArg &&
        (ts.isStringLiteral(routeArg) ||
          ts.isNoSubstitutionTemplateLiteral(routeArg)) &&
        routeArg.text.startsWith('/api/')
      )
    }
    node = node.parent
  }
  return false
}

function isMigrationCatch(catchClause: ts.CatchClause): boolean {
  let node: ts.Node | undefined = catchClause.parent
  while (node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return node.name.text.startsWith('migrate')
    }
    node = node.parent
  }
  return false
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  )
  return line + 1
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/')
}
