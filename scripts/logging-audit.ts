import {
  formatLoggingAuditReport,
  runLoggingAudit,
  type LoggingAuditSeverity,
} from '../src/server/loggingAudit'

interface CliOptions {
  failOn: LoggingAuditSeverity | 'none'
  json: boolean
}

const severityRank: Record<LoggingAuditSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

function parseArgs(argv: string[]): CliOptions {
  let failOn: CliOptions['failOn'] = 'high'
  let json = false

  for (const arg of argv) {
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg.startsWith('--fail-on=')) {
      const value = arg.slice('--fail-on='.length)
      if (value === 'none' || value === 'high' || value === 'medium' || value === 'low') {
        failOn = value
      } else {
        throw new Error(`Invalid --fail-on value: ${value}`)
      }
    }
  }

  return { failOn, json }
}

function shouldFail(
  highestSeverity: LoggingAuditSeverity | null,
  failOn: CliOptions['failOn']
): boolean {
  if (failOn === 'none') {
    return false
  }
  if (highestSeverity === null) {
    return false
  }
  return severityRank[highestSeverity] <= severityRank[failOn]
}

function findHighestSeverity(
  counts: Record<LoggingAuditSeverity, number>
): LoggingAuditSeverity | null {
  if (counts.high > 0) return 'high'
  if (counts.medium > 0) return 'medium'
  if (counts.low > 0) return 'low'
  return null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = await runLoggingAudit()

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatLoggingAuditReport(report))
  }

  const highestSeverity = findHighestSeverity(report.counts)
  if (shouldFail(highestSeverity, options.failOn)) {
    process.exitCode = 1
  }
}

await main()
