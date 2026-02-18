import {
  analyzeDependencyRisk,
  DEFAULT_SECURITY_THRESHOLD,
  isValidSecuritySeverity,
  sanitizeScannerOutput,
  type DependencyRiskReport,
  type SecuritySeverity,
} from '../src/shared/dependencyRisk'

interface CliOptions {
  json: boolean
  failOnSeverity: SecuritySeverity
}

interface CommandResult {
  command: string[]
  stdout: string
  stderr: string
  exitCode: number
}

const SCANNER_ERROR_EXIT_CODE = 2

function printHelp() {
  console.log(`Usage: bun scripts/dependency-risk.ts [--json] [--threshold <severity>]

Options:
  --json                    Emit machine-readable JSON output
  --threshold <severity>    Fail on security findings at or above severity
                            Values: low | moderate | high | critical
                            Default: high (or DEPENDENCY_RISK_FAIL_ON env)
  --help                    Show this help text`)
}

function parseArgs(args: string[]): CliOptions {
  let json = false
  const envThreshold = process.env.DEPENDENCY_RISK_FAIL_ON
  let failOnValue = envThreshold ?? DEFAULT_SECURITY_THRESHOLD

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }

    if (arg === '--json') {
      json = true
      continue
    }

    if (arg === '--threshold' || arg === '--fail-on') {
      const nextValue = args[index + 1]
      if (!nextValue) {
        throw new Error(`Missing value for ${arg}.`)
      }
      failOnValue = nextValue
      index += 1
      continue
    }

    if (arg.startsWith('--threshold=')) {
      failOnValue = arg.slice('--threshold='.length)
      continue
    }

    if (arg.startsWith('--fail-on=')) {
      failOnValue = arg.slice('--fail-on='.length)
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  const normalizedFailOn = failOnValue.toLowerCase()
  if (!isValidSecuritySeverity(normalizedFailOn)) {
    throw new Error(
      `Invalid threshold "${failOnValue}". Expected one of: low, moderate, high, critical.`
    )
  }

  return {
    json,
    failOnSeverity: normalizedFailOn,
  }
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: command,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { command, stdout, stderr, exitCode }
}

function combineOutput(result: CommandResult): string {
  return sanitizeScannerOutput([result.stdout, result.stderr].join('\n'))
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const cellWidth = Math.max(
      ...rows.map((row) => (row[index] ? row[index].length : 0)),
      header.length
    )
    return cellWidth
  })

  const formatRow = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index]))
      .join('  ')
      .trimEnd()

  const separator = widths.map((width) => '-'.repeat(width)).join('  ')
  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n')
}

function printSummary(report: DependencyRiskReport) {
  const securityRows = [
    ['critical', String(report.security.counts.critical)],
    ['high', String(report.security.counts.high)],
    ['moderate', String(report.security.counts.moderate)],
    ['low', String(report.security.counts.low)],
    ['threshold breaches', String(report.summary.thresholdBreaches)],
  ]

  const maintenanceRows = [
    ['major lag', String(report.maintenance.counts.major)],
    ['minor lag', String(report.maintenance.counts.minor)],
    ['patch lag', String(report.maintenance.counts.patch)],
    ['unknown lag', String(report.maintenance.counts.unknown)],
    ['total', String(report.maintenance.counts.total)],
  ]

  console.log('Dependency Risk Scanner')
  console.log(`Policy: fail on "${report.policy.failOnSeverity}" and above`)
  console.log('')
  console.log('Security')
  console.log(formatTable(['severity', 'count'], securityRows))
  console.log('')
  console.log('Maintenance')
  console.log(formatTable(['lag', 'count'], maintenanceRows))

  if (report.security.findings.length > 0) {
    console.log('')
    console.log('Top security findings')
    for (const finding of report.security.findings.slice(0, 5)) {
      const id = finding.advisoryId ? ` (${finding.advisoryId})` : ''
      console.log(
        `- ${finding.severity.toUpperCase()} ${finding.packageName}${id}: ${finding.title}`
      )
    }
  }

  if (report.maintenance.findings.length > 0) {
    console.log('')
    console.log('Top maintenance findings')
    for (const finding of report.maintenance.findings.slice(0, 5)) {
      console.log(
        `- ${finding.lag.toUpperCase()} ${finding.packageName} (${finding.current} -> ${finding.latest})`
      )
    }
  }

  console.log('')
  console.log(`Result: ${report.summary.shouldFail ? 'FAIL' : 'PASS'}`)
  if (report.summary.failureReason) {
    console.log(report.summary.failureReason)
  }
}

async function main() {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = SCANNER_ERROR_EXIT_CODE
    return
  }

  const [auditResult, outdatedResult] = await Promise.all([
    runCommand(['bun', 'audit', '--json']),
    runCommand(['bun', 'outdated', '--no-progress', '--no-summary']),
  ])

  const commandErrors: string[] = []
  if (auditResult.exitCode !== 0 && auditResult.exitCode !== 1) {
    commandErrors.push(
      `bun audit command failed with exit code ${auditResult.exitCode}.`
    )
  }
  if (outdatedResult.exitCode !== 0) {
    commandErrors.push(
      `bun outdated command failed with exit code ${outdatedResult.exitCode}.`
    )
  }

  const report = analyzeDependencyRisk({
    auditOutput: combineOutput(auditResult),
    outdatedOutput: combineOutput(outdatedResult),
    failOnSeverity: options.failOnSeverity,
  })

  const mergedReport: DependencyRiskReport = {
    ...report,
    errors: [...commandErrors, ...report.errors],
  }

  if (options.json) {
    console.log(JSON.stringify(mergedReport, null, 2))
  } else {
    printSummary(mergedReport)
    if (mergedReport.errors.length > 0) {
      console.log('')
      console.log('Scanner errors')
      for (const error of mergedReport.errors) {
        console.log(`- ${error}`)
      }
    }
  }

  if (mergedReport.errors.length > 0) {
    process.exitCode = SCANNER_ERROR_EXIT_CODE
    return
  }

  process.exitCode = mergedReport.summary.shouldFail ? 1 : 0
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = SCANNER_ERROR_EXIT_CODE
})
