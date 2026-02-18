export const SECURITY_SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number]

export type DependencyKind = 'prod' | 'dev' | 'optional' | 'peer' | 'unknown'
export type MaintenanceLag = 'major' | 'minor' | 'patch' | 'unknown'
export type MaintenanceRiskLevel = 'high' | 'moderate' | 'low' | 'unknown'

export interface SecurityFinding {
  packageName: string
  advisoryId: string | null
  title: string
  severity: SecuritySeverity
  vulnerableVersions: string | null
  url: string | null
  cvssScore: number | null
}

export interface SecurityRiskSummary {
  findings: SecurityFinding[]
  counts: Record<SecuritySeverity, number>
  highestSeverity: SecuritySeverity | 'none'
}

export interface MaintenanceFinding {
  packageName: string
  dependencyType: DependencyKind
  current: string
  update: string
  latest: string
  lag: MaintenanceLag
  riskLevel: MaintenanceRiskLevel
}

export interface MaintenanceRiskSummary {
  findings: MaintenanceFinding[]
  counts: {
    major: number
    minor: number
    patch: number
    unknown: number
    total: number
  }
}

export interface DependencyRiskPolicy {
  failOnSeverity: SecuritySeverity
}

export interface DependencyRiskReport {
  policy: DependencyRiskPolicy
  security: SecurityRiskSummary
  maintenance: MaintenanceRiskSummary
  errors: string[]
  summary: {
    totalSecurityFindings: number
    totalMaintenanceFindings: number
    thresholdBreaches: number
    shouldFail: boolean
    failureReason: string | null
  }
}

interface ParseResult<T> {
  findings: T[]
  errors: string[]
}

const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g')
const OSC_PATTERN = new RegExp(String.raw`\u001B\][^\u0007]*\u0007`, 'g')
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/
const LAG_ORDER: Record<MaintenanceLag, number> = {
  major: 4,
  minor: 3,
  patch: 2,
  unknown: 1,
}

const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

export const DEFAULT_SECURITY_THRESHOLD: SecuritySeverity = 'high'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function createSeverityCounts(): Record<SecuritySeverity, number> {
  return {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  }
}

function normalizeSecuritySeverity(value: unknown): SecuritySeverity {
  const normalized = asString(value)?.toLowerCase()
  if (!normalized) return 'low'
  if (normalized === 'low') return 'low'
  if (normalized === 'moderate') return 'moderate'
  if (normalized === 'high') return 'high'
  if (normalized === 'critical') return 'critical'
  return 'low'
}

function severityAtOrAbove(
  severity: SecuritySeverity,
  threshold: SecuritySeverity
): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold]
}

function normalizePolicySeverity(value?: string): SecuritySeverity {
  if (!value) return DEFAULT_SECURITY_THRESHOLD
  return normalizeSecuritySeverity(value)
}

function removeControlNoise(output: string): string {
  return output
    .replace(ANSI_PATTERN, '')
    .replaceAll('\r', '')
    .replace(OSC_PATTERN, '')
}

function extractJsonObject(output: string): string | null {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    return null
  }
  return output.slice(start, end + 1)
}

export function parseBunAuditOutput(output: string): ParseResult<SecurityFinding> {
  const cleaned = removeControlNoise(output)
  const jsonPayload = extractJsonObject(cleaned)
  if (!jsonPayload) {
    return {
      findings: [],
      errors: ['Unable to parse bun audit output: JSON payload not found.'],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonPayload)
  } catch {
    return {
      findings: [],
      errors: ['Unable to parse bun audit output: malformed JSON payload.'],
    }
  }

  const record = asRecord(parsed)
  if (!record) {
    return {
      findings: [],
      errors: ['Unable to parse bun audit output: root JSON object is invalid.'],
    }
  }

  const findings: SecurityFinding[] = []
  const packageNames = Object.keys(record).sort(compareStrings)
  let sawAdvisoryArray = false
  for (const packageName of packageNames) {
    const advisories = record[packageName]
    if (!Array.isArray(advisories)) {
      continue
    }
    sawAdvisoryArray = true

    for (const advisory of advisories) {
      const advisoryRecord = asRecord(advisory)
      if (!advisoryRecord) {
        continue
      }

      const advisoryId = advisoryRecord.id
      const cvss = asRecord(advisoryRecord.cvss)
      const finding: SecurityFinding = {
        packageName,
        advisoryId:
          typeof advisoryId === 'string' || typeof advisoryId === 'number'
            ? String(advisoryId)
            : null,
        title: asString(advisoryRecord.title) ?? 'Unknown advisory',
        severity: normalizeSecuritySeverity(advisoryRecord.severity),
        vulnerableVersions: asString(advisoryRecord.vulnerable_versions),
        url: asString(advisoryRecord.url),
        cvssScore: asNumber(cvss?.score),
      }
      findings.push(finding)
    }
  }

  if (packageNames.length > 0 && !sawAdvisoryArray) {
    return {
      findings: [],
      errors: [
        'Unable to parse bun audit output: advisory arrays not found in root JSON object.',
      ],
    }
  }

  findings.sort((left, right) => {
    const severityDiff =
      SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]
    if (severityDiff !== 0) {
      return severityDiff
    }
    const packageDiff = compareStrings(left.packageName, right.packageName)
    if (packageDiff !== 0) {
      return packageDiff
    }
    return compareStrings(left.advisoryId ?? '', right.advisoryId ?? '')
  })

  return { findings, errors: [] }
}

function isSeparatorCell(value: string): boolean {
  return value.length > 0 && /^-+$/.test(value)
}

function parsePackageName(value: string): {
  packageName: string
  dependencyType: DependencyKind
} {
  const match = value.match(/^(.*)\s+\((dev|optional|peer)\)$/)
  if (!match) {
    return {
      packageName: value.trim(),
      dependencyType: 'prod',
    }
  }

  const packageName = match[1]?.trim()
  const dependencyType = match[2] as DependencyKind
  return {
    packageName: packageName || value.trim(),
    dependencyType,
  }
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const trimmed = version.trim()
  const match = trimmed.match(SEMVER_PATTERN)
  if (!match) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function classifyMaintenanceLag(current: string, latest: string): MaintenanceLag | 'none' {
  if (current === latest) return 'none'

  const currentSemver = parseSemver(current)
  const latestSemver = parseSemver(latest)
  if (!currentSemver || !latestSemver) {
    return 'unknown'
  }

  if (latestSemver.major > currentSemver.major) return 'major'
  if (latestSemver.major < currentSemver.major) return 'unknown'

  if (latestSemver.minor > currentSemver.minor) return 'minor'
  if (latestSemver.minor < currentSemver.minor) return 'unknown'

  if (latestSemver.patch > currentSemver.patch) return 'patch'
  if (latestSemver.patch < currentSemver.patch) return 'unknown'

  return current === latest ? 'none' : 'unknown'
}

function maintenanceRiskForLag(lag: MaintenanceLag): MaintenanceRiskLevel {
  if (lag === 'major') return 'high'
  if (lag === 'minor') return 'moderate'
  if (lag === 'patch') return 'low'
  return 'unknown'
}

function extractOutdatedTableRows(output: string): string[][] {
  const lines = removeControlNoise(output).split('\n')
  const rows: string[][] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue

    const rawCells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (rawCells.length < 4) continue
    if (rawCells[0] === 'Package') continue
    if (rawCells.every(isSeparatorCell)) continue
    rows.push(rawCells.slice(0, 4))
  }

  return rows
}

export function parseBunOutdatedOutput(
  output: string
): ParseResult<MaintenanceFinding> {
  const rows = extractOutdatedTableRows(output)
  const findings: MaintenanceFinding[] = []

  for (const [packageCell, current, update, latest] of rows) {
    const { packageName, dependencyType } = parsePackageName(packageCell)
    const lag = classifyMaintenanceLag(current, latest)
    if (lag === 'none') continue

    findings.push({
      packageName,
      dependencyType,
      current,
      update,
      latest,
      lag,
      riskLevel: maintenanceRiskForLag(lag),
    })
  }

  findings.sort((left, right) => {
    const lagDiff = LAG_ORDER[right.lag] - LAG_ORDER[left.lag]
    if (lagDiff !== 0) {
      return lagDiff
    }
    return compareStrings(left.packageName, right.packageName)
  })

  const cleaned = removeControlNoise(output).trim()
  const errors: string[] = []
  if (findings.length === 0 && rows.length === 0 && cleaned.length > 0) {
    const knownNoise = [
      'bun outdated v',
      'Resolving...',
      '[0.',
      '".env"',
      'No outdated dependencies',
      'All dependencies are up-to-date',
    ]
    const informativeLine = cleaned
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !knownNoise.some((token) => line.includes(token)))
    if (informativeLine) {
      errors.push('Unable to parse bun outdated output: table rows not found.')
    }
  }

  return { findings, errors }
}

function highestSecuritySeverity(
  counts: Record<SecuritySeverity, number>
): SecuritySeverity | 'none' {
  if (counts.critical > 0) return 'critical'
  if (counts.high > 0) return 'high'
  if (counts.moderate > 0) return 'moderate'
  if (counts.low > 0) return 'low'
  return 'none'
}

function countThresholdBreaches(
  counts: Record<SecuritySeverity, number>,
  threshold: SecuritySeverity
): number {
  let total = 0
  for (const severity of SECURITY_SEVERITIES) {
    if (severityAtOrAbove(severity, threshold)) {
      total += counts[severity]
    }
  }
  return total
}

export function analyzeDependencyRisk(options: {
  auditOutput: string
  outdatedOutput: string
  failOnSeverity?: string
}): DependencyRiskReport {
  const policy: DependencyRiskPolicy = {
    failOnSeverity: normalizePolicySeverity(options.failOnSeverity),
  }

  const securityParse = parseBunAuditOutput(options.auditOutput)
  const maintenanceParse = parseBunOutdatedOutput(options.outdatedOutput)

  const securityCounts = createSeverityCounts()
  for (const finding of securityParse.findings) {
    securityCounts[finding.severity] += 1
  }

  const maintenanceCounts = {
    major: 0,
    minor: 0,
    patch: 0,
    unknown: 0,
    total: maintenanceParse.findings.length,
  }

  for (const finding of maintenanceParse.findings) {
    maintenanceCounts[finding.lag] += 1
  }

  const thresholdBreaches = countThresholdBreaches(
    securityCounts,
    policy.failOnSeverity
  )
  const shouldFail = thresholdBreaches > 0
  const failureReason = shouldFail
    ? `Security findings at or above "${policy.failOnSeverity}" threshold: ${thresholdBreaches}.`
    : null

  return {
    policy,
    security: {
      findings: securityParse.findings,
      counts: securityCounts,
      highestSeverity: highestSecuritySeverity(securityCounts),
    },
    maintenance: {
      findings: maintenanceParse.findings,
      counts: maintenanceCounts,
    },
    errors: [...securityParse.errors, ...maintenanceParse.errors],
    summary: {
      totalSecurityFindings: securityParse.findings.length,
      totalMaintenanceFindings: maintenanceParse.findings.length,
      thresholdBreaches,
      shouldFail,
      failureReason,
    },
  }
}

export function sanitizeScannerOutput(output: string): string {
  return removeControlNoise(output).trim()
}

export function isValidSecuritySeverity(value: string): value is SecuritySeverity {
  return SECURITY_SEVERITIES.includes(value as SecuritySeverity)
}
