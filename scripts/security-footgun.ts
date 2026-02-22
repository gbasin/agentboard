import fs from 'node:fs/promises'
import path from 'node:path'
import {
  analyzeSecurityFootguns,
  DEFAULT_SECURITY_FOOTGUN_THRESHOLD,
  isSecurityFootgunTargetFile,
  isValidSecurityFootgunSeverity,
  type SecurityFootgunInputFile,
  type SecurityFootgunReport,
  type SecurityFootgunSeverity,
} from '../src/shared/securityFootgun'

interface CliOptions {
  json: boolean
  threshold: SecurityFootgunSeverity
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
  let thresholdValue = envThreshold ?? DEFAULT_SECURITY_FOOTGUN_THRESHOLD

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
      const value = args[index + 1]
      if (!value) {
        throw new Error(`Missing value for ${arg}.`)
      }
      thresholdValue = value
      index += 1
      continue
    }

    if (arg.startsWith('--threshold=')) {
      thresholdValue = arg.slice('--threshold='.length)
      continue
    }

    if (arg.startsWith('--fail-on=')) {
      thresholdValue = arg.slice('--fail-on='.length)
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  const normalizedThreshold = thresholdValue.toLowerCase()
  if (!isValidSecurityFootgunSeverity(normalizedThreshold)) {
    throw new Error(
      `Invalid threshold "${thresholdValue}". Expected one of: low, moderate, high, critical.`
    )
  }

  return {
    json,
    threshold: normalizedThreshold,
  }
}

async function collectCandidateFiles(root: string): Promise<string[]> {
  const collected: string[] = []

  async function walk(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)
      const relativePath = path.relative(root, fullPath).replaceAll('\\', '/')

      if (entry.isDirectory()) {
        if (
          relativePath === 'node_modules' ||
          relativePath === 'dist' ||
          relativePath === 'coverage' ||
          relativePath === '.git'
        ) {
          continue
        }

        await walk(fullPath)
        continue
      }

      if (isSecurityFootgunTargetFile(relativePath)) {
        collected.push(relativePath)
      }
    }
  }

  await walk(root)
  collected.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return collected
}

async function loadFiles(root: string): Promise<SecurityFootgunInputFile[]> {
  const filePaths = await collectCandidateFiles(root)
  const files = await Promise.all(
    filePaths.map(async (filePath) => {
      const absolutePath = path.join(root, filePath)
      const content = await fs.readFile(absolutePath, 'utf8')
      return {
        path: filePath,
        content,
      }
    })
  )

  return files
}

function formatCounts(report: SecurityFootgunReport): string {
  const rows: Array<[string, string]> = [
    ['critical', String(report.summary.counts.critical)],
    ['high', String(report.summary.counts.high)],
    ['moderate', String(report.summary.counts.moderate)],
    ['low', String(report.summary.counts.low)],
    ['threshold breaches', String(report.summary.thresholdBreaches)],
    ['suppressed', String(report.summary.suppressedFindings)],
  ]

  const width = Math.max(...rows.map(([label]) => label.length), 'severity'.length)
  const valueWidth = Math.max(...rows.map(([, value]) => value.length), 'count'.length)

  const header = `${'severity'.padEnd(width)}  ${'count'.padEnd(valueWidth)}`
  const separator = `${'-'.repeat(width)}  ${'-'.repeat(valueWidth)}`
  const body = rows
    .map(([label, value]) => `${label.padEnd(width)}  ${value.padEnd(valueWidth)}`)
    .join('\n')

  return `${header}\n${separator}\n${body}`
}

function printHumanReport(report: SecurityFootgunReport) {
  console.log('Security Foot-Gun Finder')
  console.log(`Policy: fail on "${report.policy.threshold}" and above`)
  console.log(`Scanned files: ${report.summary.filesScanned}`)
  console.log('')
  console.log(formatCounts(report))

  if (report.findings.length > 0) {
    console.log('')
    console.log('Top findings')
    for (const finding of report.findings.slice(0, 10)) {
      console.log(
        `- [${finding.severity.toUpperCase()}] ${finding.ruleId} ${finding.filePath}:${finding.line}:${finding.column} ${finding.message}`
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

  let files: SecurityFootgunInputFile[]
  try {
    files = await loadFiles(process.cwd())
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = SCANNER_ERROR_EXIT_CODE
    return
  }

  const report = analyzeSecurityFootguns({
    files,
    threshold: options.threshold,
  })

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHumanReport(report)
  }

  if (report.errors.length > 0) {
    process.exitCode = SCANNER_ERROR_EXIT_CODE
    return
  }

  process.exitCode = report.summary.shouldFail ? 1 : 0
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = SCANNER_ERROR_EXIT_CODE
})
