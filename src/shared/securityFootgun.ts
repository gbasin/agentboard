export const SECURITY_FOOTGUN_SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const
export type SecurityFootgunSeverity = (typeof SECURITY_FOOTGUN_SEVERITIES)[number]

export type SecurityFootgunRuleId =
  | 'dynamic-shell-interpolation'
  | 'dangerous-eval'
  | 'unsafe-html-injection'
  | 'tls-verification-bypass'
  | 'insecure-temp-file-construction'

export interface SecurityFootgunRule {
  id: SecurityFootgunRuleId
  severity: SecurityFootgunSeverity
  title: string
  description: string
}

export interface SecurityFootgunFinding {
  path: string
  line: number
  column: number
  ruleId: SecurityFootgunRuleId
  ruleTitle: string
  severity: SecurityFootgunSeverity
  message: string
  excerpt: string
}

export interface SecurityFootgunPolicy {
  failOnSeverity: SecurityFootgunSeverity
}

export interface SecurityFootgunInputFile {
  path: string
  content: string
}

export interface SecurityFootgunReport {
  policy: SecurityFootgunPolicy
  findings: SecurityFootgunFinding[]
  counts: Record<SecurityFootgunSeverity, number>
  errors: string[]
  summary: {
    scannedFiles: number
    totalFindings: number
    thresholdBreaches: number
    highestSeverity: SecurityFootgunSeverity | 'none'
    shouldFail: boolean
    failureReason: string | null
  }
}

interface MatchContext {
  path: string
  line: number
  lineText: string
  matchText: string
}

interface RulePattern {
  regex: RegExp
  message: string
  shouldReport?: (context: MatchContext) => boolean
  allowMatchInStringLiteral?: boolean
}

interface RuleDefinition extends SecurityFootgunRule {
  patterns: RulePattern[]
}

interface SuppressionRuleSet {
  all: boolean
  rules: Set<string>
}

const SCANNABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const SKIP_SUFFIXES = ['.d.ts', '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx']
const SKIP_SEGMENTS = ['/__tests__/', '/node_modules/', '/dist/', '/coverage/']

const SUPPRESSION_PATTERN =
  /security-footgun-ignore(?:-(next-line))?(?::|\s+)?([a-z0-9*_,\-\s]+)?/gi

const SEVERITY_ORDER: Record<SecurityFootgunSeverity, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

export const DEFAULT_SECURITY_FOOTGUN_THRESHOLD: SecurityFootgunSeverity = 'high'

const RULE_DEFINITIONS: ReadonlyArray<RuleDefinition> = [
  {
    id: 'dynamic-shell-interpolation',
    severity: 'critical',
    title: 'Dynamic shell command interpolation',
    description:
      'Interpolated or concatenated shell commands at execution sinks can enable command injection.',
    patterns: [
      {
        regex: /\b(?:exec|execSync)\s*\(\s*`[^`\n]*\$\{[^`\n]+\}[^`\n]*`/g,
        message:
          'Template interpolation in exec/execSync command; prefer argument arrays or strict input validation.',
      },
      {
        regex: /\b(?:exec|execSync)\s*\(\s*[^\n)]*\+/g,
        message:
          'String concatenation in exec/execSync command; prefer argument arrays and avoid shell string building.',
      },
    ],
  },
  {
    id: 'dangerous-eval',
    severity: 'critical',
    title: 'Dynamic code evaluation',
    description:
      'Runtime code evaluation can execute attacker-controlled input and bypass security controls.',
    patterns: [
      {
        regex: /\beval\s*\(/g,
        message: 'Use of eval() detected; replace with explicit parsing or controlled dispatch.',
      },
      {
        regex: /\bnew\s+Function\s*\(/g,
        message:
          'Use of new Function() detected; avoid runtime code generation from strings.',
      },
    ],
  },
  {
    id: 'unsafe-html-injection',
    severity: 'high',
    title: 'Unsafe HTML injection',
    description:
      'Direct HTML injection APIs can introduce XSS when content is not strictly sanitized.',
    patterns: [
      {
        regex: /\.\s*(?:innerHTML|outerHTML)\s*=/g,
        message:
          'Direct innerHTML/outerHTML assignment detected; use textContent or trusted sanitization.',
        shouldReport: ({ lineText }) => {
          if (/\.\s*(?:innerHTML|outerHTML)\s*=\s*(?:''|""|`\s*`)\s*;?\s*$/.test(lineText)) {
            return false
          }
          if (/\.\s*(?:innerHTML|outerHTML)\s*=\s*.*\bsanitize\s*\(/.test(lineText)) {
            return false
          }
          return true
        },
      },
      {
        regex: /\binsertAdjacentHTML\s*\(/g,
        message:
          'insertAdjacentHTML() detected; ensure content is trusted and sanitized before insertion.',
      },
      {
        regex: /\bdangerouslySetInnerHTML\s*=\s*\{\s*\{/g,
        message:
          'dangerouslySetInnerHTML detected; verify strict sanitization and trusted content boundaries.',
      },
    ],
  },
  {
    id: 'tls-verification-bypass',
    severity: 'critical',
    title: 'TLS verification bypass',
    description:
      'Disabling TLS certificate checks can expose traffic to man-in-the-middle attacks.',
    patterns: [
      {
        regex: /\b(?:process\.)?env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/g,
        message:
          'NODE_TLS_REJECT_UNAUTHORIZED is set to 0; keep certificate verification enabled.',
      },
      {
        regex: /\brejectUnauthorized\s*:\s*false\b/g,
        message:
          'rejectUnauthorized: false detected; this disables TLS certificate validation.',
      },
      {
        regex: /\bstrictSSL\s*:\s*false\b/g,
        message: 'strictSSL: false detected; this disables TLS certificate validation.',
      },
    ],
  },
  {
    id: 'insecure-temp-file-construction',
    severity: 'moderate',
    title: 'Insecure temp-file construction',
    description:
      'Predictable temporary file paths can lead to race conditions and file clobbering attacks.',
    patterns: [
      {
        regex: /\bos\.tmpdir\(\)\s*\+/g,
        message:
          'Temp path built with string concatenation; prefer fs.mkdtemp()/mkdtempSync() and random names.',
      },
      {
        regex: /\bpath\.join\(\s*os\.tmpdir\(\)\s*,\s*[^)\n]*\+/g,
        message:
          'Temp path built with concatenated filename under os.tmpdir(); use mkdtemp-style APIs instead.',
      },
      {
        regex: /`\/tmp\/[^`\n]*\$\{[^}`\n]+\}[^`\n]*`/g,
        message:
          'Template-generated /tmp path detected; prefer mkdtemp APIs over predictable temp filenames.',
        allowMatchInStringLiteral: true,
      },
      {
        regex: /['"]\/tmp\/[^'"\n]+['"]\s*\+/g,
        message:
          'Concatenated /tmp path detected; prefer mkdtemp APIs over predictable temp filenames.',
        allowMatchInStringLiteral: true,
      },
    ],
  },
]

export const SECURITY_FOOTGUN_RULES: ReadonlyArray<SecurityFootgunRule> = RULE_DEFINITIONS.map(
  ({ id, severity, title, description }) => ({
    id,
    severity,
    title,
    description,
  })
)

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function normalizeScannerPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '')
  return normalized
}

function isScannableExtension(filePath: string): boolean {
  return SCANNABLE_EXTENSIONS.some((extension) => filePath.endsWith(extension))
}

function isSkippedSuffix(filePath: string): boolean {
  return SKIP_SUFFIXES.some((suffix) => filePath.endsWith(suffix))
}

function isIncludedRoot(filePath: string): boolean {
  return (
    filePath.startsWith('src/') ||
    filePath.startsWith('scripts/') ||
    filePath.includes('/src/') ||
    filePath.includes('/scripts/')
  )
}

export function shouldScanSecurityFootgunPath(filePath: string): boolean {
  const normalized = normalizeScannerPath(filePath)

  if (!isScannableExtension(normalized)) return false
  if (isSkippedSuffix(normalized)) return false
  if (SKIP_SEGMENTS.some((segment) => normalized.includes(segment))) return false

  return isIncludedRoot(normalized)
}

function createSeverityCounts(): Record<SecurityFootgunSeverity, number> {
  return {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  }
}

function severityAtOrAbove(
  severity: SecurityFootgunSeverity,
  threshold: SecurityFootgunSeverity
): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold]
}

function highestSecuritySeverity(
  counts: Record<SecurityFootgunSeverity, number>
): SecurityFootgunSeverity | 'none' {
  if (counts.critical > 0) return 'critical'
  if (counts.high > 0) return 'high'
  if (counts.moderate > 0) return 'moderate'
  if (counts.low > 0) return 'low'
  return 'none'
}

function countThresholdBreaches(
  counts: Record<SecurityFootgunSeverity, number>,
  threshold: SecurityFootgunSeverity
): number {
  let total = 0
  for (const severity of SECURITY_FOOTGUN_SEVERITIES) {
    if (severityAtOrAbove(severity, threshold)) {
      total += counts[severity]
    }
  }
  return total
}

function createLineStarts(content: string): number[] {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      starts.push(index + 1)
    }
  }
  return starts
}

function lineNumberForOffset(lineStarts: number[], offset: number): number {
  let low = 0
  let high = lineStarts.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lineStarts[mid] <= offset) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return Math.max(1, high + 1)
}

function columnForOffset(lineStarts: number[], line: number, offset: number): number {
  const lineStart = lineStarts[Math.max(0, line - 1)] ?? 0
  return Math.max(1, offset - lineStart + 1)
}

function isCommentOnlyLine(lineText: string): boolean {
  const trimmed = lineText.trim()
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/')
  )
}

function isInsideStringLiteral(lineText: string, targetIndex: number): boolean {
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let escaped = false

  for (let index = 0; index < lineText.length; index += 1) {
    if (index === targetIndex) {
      return inSingle || inDouble || inTemplate
    }

    const char = lineText[index]
    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (!inDouble && !inTemplate && char === '\'') {
      inSingle = !inSingle
      continue
    }

    if (!inSingle && !inTemplate && char === '"') {
      inDouble = !inDouble
      continue
    }

    if (!inSingle && !inDouble && char === '`') {
      inTemplate = !inTemplate
    }
  }

  return false
}

function normalizeSuppressedRules(rawRules?: string): SuppressionRuleSet {
  if (!rawRules) {
    return {
      all: true,
      rules: new Set<string>(),
    }
  }

  const parts = rawRules
    .split(/[\s,]+/)
    .map((rule) => rule.trim().toLowerCase())
    .filter((rule) => rule.length > 0)

  if (parts.length === 0 || parts.includes('*') || parts.includes('all')) {
    return {
      all: true,
      rules: new Set<string>(),
    }
  }

  return {
    all: false,
    rules: new Set(parts),
  }
}

function mergeSuppression(
  current: SuppressionRuleSet | undefined,
  incoming: SuppressionRuleSet
): SuppressionRuleSet {
  if (!current) {
    return incoming
  }

  if (current.all || incoming.all) {
    return {
      all: true,
      rules: new Set<string>(),
    }
  }

  const merged = new Set(current.rules)
  for (const rule of incoming.rules) {
    merged.add(rule)
  }

  return {
    all: false,
    rules: merged,
  }
}

function buildSuppressionMap(lines: string[]): Map<number, SuppressionRuleSet> {
  const suppressions = new Map<number, SuppressionRuleSet>()

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const inlineCommentIndex = line.indexOf('//')
    const blockCommentIndex = line.indexOf('/*')

    let commentIndex = -1
    if (inlineCommentIndex >= 0 && blockCommentIndex >= 0) {
      commentIndex = Math.min(inlineCommentIndex, blockCommentIndex)
    } else if (inlineCommentIndex >= 0) {
      commentIndex = inlineCommentIndex
    } else if (blockCommentIndex >= 0) {
      commentIndex = blockCommentIndex
    }

    if (commentIndex < 0) continue

    const commentText = line.slice(commentIndex + 2)
    SUPPRESSION_PATTERN.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = SUPPRESSION_PATTERN.exec(commentText)) !== null) {
      const isNextLine = Boolean(match[1])
      const rawRules = match[2]
      const targetLine = isNextLine ? lineIndex + 2 : lineIndex + 1
      const normalizedRules = normalizeSuppressedRules(rawRules)

      const current = suppressions.get(targetLine)
      suppressions.set(targetLine, mergeSuppression(current, normalizedRules))

      if (match[0].length === 0) {
        SUPPRESSION_PATTERN.lastIndex += 1
      }
    }
  }

  return suppressions
}

function isSuppressed(
  suppressions: Map<number, SuppressionRuleSet>,
  line: number,
  ruleId: SecurityFootgunRuleId
): boolean {
  const suppression = suppressions.get(line)
  if (!suppression) return false
  if (suppression.all) return true
  return suppression.rules.has(ruleId)
}

function normalizePolicySeverity(value?: string): SecurityFootgunSeverity {
  const normalized = value?.toLowerCase()
  if (!normalized) return DEFAULT_SECURITY_FOOTGUN_THRESHOLD
  if (!isValidSecurityFootgunSeverity(normalized)) {
    return DEFAULT_SECURITY_FOOTGUN_THRESHOLD
  }
  return normalized
}

function copyRegex(regex: RegExp): RegExp {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  return new RegExp(regex.source, flags)
}

function scanFile(filePath: string, content: string): SecurityFootgunFinding[] {
  const normalizedPath = normalizeScannerPath(filePath)
  const normalizedContent = content.replaceAll('\r\n', '\n')
  const lines = normalizedContent.split('\n')
  const lineStarts = createLineStarts(normalizedContent)
  const suppressions = buildSuppressionMap(lines)

  const findings: SecurityFootgunFinding[] = []
  const seen = new Set<string>()

  for (const rule of RULE_DEFINITIONS) {
    for (const pattern of rule.patterns) {
      const regex = copyRegex(pattern.regex)
      let match: RegExpExecArray | null

      while ((match = regex.exec(normalizedContent)) !== null) {
        const matchText = match[0] ?? ''
        if (!matchText) {
          regex.lastIndex += 1
          continue
        }

        const line = lineNumberForOffset(lineStarts, match.index)
        const column = columnForOffset(lineStarts, line, match.index)
        const lineText = lines[line - 1] ?? ''
        if (isCommentOnlyLine(lineText)) continue
        if (
          !pattern.allowMatchInStringLiteral &&
          isInsideStringLiteral(lineText, Math.max(0, column - 1))
        ) {
          continue
        }
        if (isSuppressed(suppressions, line, rule.id)) continue

        if (rule.id === 'insecure-temp-file-construction') {
          if (/\bmkdtemp(?:Sync)?\s*\(/.test(lineText)) {
            continue
          }
        }

        if (pattern.shouldReport && !pattern.shouldReport({
          path: normalizedPath,
          line,
          lineText,
          matchText,
        })) {
          continue
        }

        const key = `${normalizedPath}:${line}:${column}:${rule.id}`
        if (seen.has(key)) continue
        seen.add(key)

        findings.push({
          path: normalizedPath,
          line,
          column,
          ruleId: rule.id,
          ruleTitle: rule.title,
          severity: rule.severity,
          message: pattern.message,
          excerpt: lineText.trim() || matchText.trim(),
        })
      }
    }
  }

  findings.sort((left, right) => {
    const severityDiff = SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]
    if (severityDiff !== 0) return severityDiff

    const pathDiff = compareStrings(left.path, right.path)
    if (pathDiff !== 0) return pathDiff

    if (left.line !== right.line) return left.line - right.line
    if (left.column !== right.column) return left.column - right.column

    return compareStrings(left.ruleId, right.ruleId)
  })

  return findings
}

export function analyzeSecurityFootguns(options: {
  files: SecurityFootgunInputFile[]
  failOnSeverity?: string
}): SecurityFootgunReport {
  const policy: SecurityFootgunPolicy = {
    failOnSeverity: normalizePolicySeverity(options.failOnSeverity),
  }

  const findings: SecurityFootgunFinding[] = []
  const errors: string[] = []
  let scannedFiles = 0

  for (const file of options.files) {
    if (!shouldScanSecurityFootgunPath(file.path)) {
      continue
    }

    scannedFiles += 1

    try {
      findings.push(...scanFile(file.path, file.content))
    } catch (error) {
      errors.push(
        `Failed to scan ${normalizeScannerPath(file.path)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  findings.sort((left, right) => {
    const severityDiff = SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]
    if (severityDiff !== 0) return severityDiff

    const pathDiff = compareStrings(left.path, right.path)
    if (pathDiff !== 0) return pathDiff

    if (left.line !== right.line) return left.line - right.line
    if (left.column !== right.column) return left.column - right.column

    return compareStrings(left.ruleId, right.ruleId)
  })

  const counts = createSeverityCounts()
  for (const finding of findings) {
    counts[finding.severity] += 1
  }

  const thresholdBreaches = countThresholdBreaches(counts, policy.failOnSeverity)
  const shouldFail = thresholdBreaches > 0

  return {
    policy,
    findings,
    counts,
    errors,
    summary: {
      scannedFiles,
      totalFindings: findings.length,
      thresholdBreaches,
      highestSeverity: highestSecuritySeverity(counts),
      shouldFail,
      failureReason: shouldFail
        ? `Security foot-gun findings at or above "${policy.failOnSeverity}": ${thresholdBreaches}.`
        : null,
    },
  }
}

export function isValidSecurityFootgunSeverity(
  value: string
): value is SecurityFootgunSeverity {
  return SECURITY_FOOTGUN_SEVERITIES.includes(value as SecurityFootgunSeverity)
}
