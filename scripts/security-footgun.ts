import { readFile } from 'node:fs/promises'
import {
  analyzeSecurityFootguns,
  DEFAULT_SECURITY_FOOTGUN_THRESHOLD,
  isValidSecurityFootgunSeverity,
  shouldScanSecurityFootgunPath,
  type SecurityFootgunInputFile,
  type SecurityFootgunReport,
  type SecurityFootgunSeverity,
} from '../src/shared/securityFootgun'

interface CliOptions {
  json: boolean
  failOnSeverity: SecurityFootgunSeverity
}

interface LoadedFiles {
  files: SecurityFootgunInputFile[]
  errors: string[]
}

const SCANNER_ERROR_EXIT_CODE = 2

function printHelp() {
  console.log(`Usage: bun scripts/security-footgun.ts [--json] [--threshold <severity>]

Options:
  --json                    Emit machine-readable JSON output
  --threshold <severity>    Fail on findings at or above severity
                            Values: low | moderate | high | critical
                            Default: high (or SECURITY_FOOTGUN_FAIL_ON env)
  --help                    Show this help text`)
}

function parseArgs(args: string[]): CliOptions {
  let json = false
  const envThreshold = process.env.SECURITY_FOOTGUN_FAIL_ON
  let failOnValue = envThreshold ?? DEFAULT_SECURITY_FOOTGUN_THRESHOLD

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

  const normalizedThreshold = failOnValue.toLowerCase()
  if (!isValidSecurityFootgunSeverity(normalizedThreshold)) {
    throw new Error(
      `Invalid threshold "${failOnValue}". Expected one of: low, moderate, high, critical.`
    )
  }

  return {
    json,
    failOnSeverity: normalizedThreshold,
  }
}

async function collectCandidateFiles(): Promise<string[]> {
  const discovered = new Set<string>()

  const srcGlob = new Bun.Glob('src/**/*.{ts,tsx,mts,cts}')
  for await (const file of srcGlob.scan({ onlyFiles: true })) {
    if (shouldScanSecurityFootgunPath(file)) {
      discovered.add(file)
    }
  }

  const scriptsGlob = new Bun.Glob('scripts/**/*.{ts,tsx,mts,cts}')
  for await (const file of scriptsGlob.scan({ onlyFiles: true })) {
    if (shouldScanSecurityFootgunPath(file)) {
      discovered.add(file)
    }
  }

  return Array.from(discovered).sort((left, right) => {
    if (left === right) return 0
    return left < right ? -1 : 1
  })
}

async function loadFiles(paths: string[]): Promise<LoadedFiles> {
  const files: SecurityFootgunInputFile[] = []
  const errors: string[] = []

  for (const filePath of paths) {
    try {
      const content = await readFile(filePath, 'utf8')
      files.push({
        path: filePath,
        content,
      })
    } catch (error) {
      errors.push(
        `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return { files, errors }
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

function printSummary(report: SecurityFootgunReport) {
  console.log('Security Foot-Gun Finder')
  console.log(`Policy: fail on "${report.policy.failOnSeverity}" and above`)
  console.log(`Scanned files: ${report.summary.scannedFiles}`)
  console.log('')

  const severityRows = [
    ['critical', String(report.counts.critical)],
    ['high', String(report.counts.high)],
    ['moderate', String(report.counts.moderate)],
    ['low', String(report.counts.low)],
    ['threshold breaches', String(report.summary.thresholdBreaches)],
  ]

  console.log('Findings by severity')
  console.log(formatTable(['severity', 'count'], severityRows))

  if (report.findings.length > 0) {
    console.log('')
    console.log('Top findings')
    for (const finding of report.findings.slice(0, 10)) {
      console.log(
        `- ${finding.severity.toUpperCase()} ${finding.path}:${finding.line}:${finding.column} ${finding.ruleId}: ${finding.message}`
      )
    }
  }

  if (report.errors.length > 0) {
    console.log('')
    console.log('Scanner errors')
    for (const error of report.errors) {
      console.log(`- ${error}`)
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

  const candidatePaths = await collectCandidateFiles()
  const loaded = await loadFiles(candidatePaths)
  const report = analyzeSecurityFootguns({
    files: loaded.files,
    failOnSeverity: options.failOnSeverity,
  })

  const mergedReport: SecurityFootgunReport = {
    ...report,
    errors: [...loaded.errors, ...report.errors],
  }

  if (options.json) {
    console.log(JSON.stringify(mergedReport, null, 2))
  } else {
    printSummary(mergedReport)
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
