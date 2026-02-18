import fs from 'node:fs'
import path from 'node:path'
import {
  analyzePerfRegressionLogs,
  formatPerfRegressionSummary,
  type PerfRegressionOptions,
} from '../src/server/perfRegressionSpotter'

interface CliOptions {
  files: string[]
  format: 'human' | 'json'
  strict: boolean
  showHelp: boolean
  analysis: PerfRegressionOptions
}

const DEFAULT_LOG_PATH = '~/.agentboard/agentboard.log'

function expandHome(inputPath: string): string {
  if (!inputPath.startsWith('~/')) return inputPath
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) return inputPath
  return path.join(home, inputPath.slice(2))
}

function printHelp(): void {
  console.log(`Usage: bun scripts/perf-regression-spotter.ts [options]

Options:
  --file <path>                  Log file path (repeatable)
  --baseline-minutes <minutes>   Baseline window length in minutes (default: 60)
  --recent-minutes <minutes>     Recent window length in minutes (default: 15)
  --min-samples <count>          Minimum samples required in each window (default: 6)
  --relative-threshold <ratio>   Relative increase threshold, e.g. 0.3 for 30% (default: 0.3)
  --absolute-threshold-ms <ms>   Absolute increase threshold in milliseconds (default: 25)
  --format <human|json>          Output format (default: human)
  --json                         Alias for --format json
  --strict                       Exit with code 1 when regressions are found
  --now <iso-or-ms>              Override analysis end timestamp (for deterministic checks)
  -h, --help                     Show help

Examples:
  bun run perf:spot -- --file ~/.agentboard/agentboard.log
  bun run perf:spot -- --file ~/.agentboard/agentboard.log --strict --json
  bun run perf:spot -- --file ./agentboard.log --baseline-minutes 120 --recent-minutes 30
`)
}

function parseNumberArg(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return parsed
}

function parseNow(value: string): number {
  const asNumber = Number(value)
  if (Number.isFinite(asNumber)) {
    return asNumber
  }
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) {
    return parsed
  }
  throw new Error(`Invalid --now value: ${value}`)
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    files: [],
    format: 'human',
    strict: false,
    showHelp: false,
    analysis: {},
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '-h' || arg === '--help') {
      options.showHelp = true
      continue
    }

    if (arg === '--strict') {
      options.strict = true
      continue
    }

    if (arg === '--json') {
      options.format = 'json'
      continue
    }

    const next = args[index + 1]
    if (!next) {
      throw new Error(`Missing value for ${arg}`)
    }

    if (arg === '--file') {
      options.files.push(expandHome(next))
      index += 1
      continue
    }

    if (arg === '--baseline-minutes') {
      options.analysis.baselineWindowMs = parseNumberArg(next, arg) * 60 * 1000
      index += 1
      continue
    }

    if (arg === '--recent-minutes') {
      options.analysis.recentWindowMs = parseNumberArg(next, arg) * 60 * 1000
      index += 1
      continue
    }

    if (arg === '--min-samples') {
      options.analysis.minSamplesPerWindow = parseNumberArg(next, arg)
      index += 1
      continue
    }

    if (arg === '--relative-threshold') {
      options.analysis.relativeIncreaseThreshold = parseNumberArg(next, arg)
      index += 1
      continue
    }

    if (arg === '--absolute-threshold-ms') {
      options.analysis.absoluteIncreaseThresholdMs = parseNumberArg(next, arg)
      index += 1
      continue
    }

    if (arg === '--format') {
      if (next !== 'human' && next !== 'json') {
        throw new Error(`Invalid --format value: ${next}`)
      }
      options.format = next
      index += 1
      continue
    }

    if (arg === '--now') {
      options.analysis.nowMs = parseNow(next)
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.files.length === 0) {
    const envLogFile = process.env.LOG_FILE?.trim()
    const fallbackPath = envLogFile ? envLogFile : DEFAULT_LOG_PATH
    options.files.push(expandHome(fallbackPath))
  }

  return options
}

function validateFiles(files: string[]): void {
  const missing = files.filter((filePath) => !fs.existsSync(filePath))
  if (missing.length > 0) {
    throw new Error(`Log file(s) not found: ${missing.join(', ')}`)
  }
}

function run(): number {
  const options = parseArgs(process.argv.slice(2))

  if (options.showHelp) {
    printHelp()
    return 0
  }

  validateFiles(options.files)

  const analysis = analyzePerfRegressionLogs(options.files, options.analysis)
  if (options.format === 'json') {
    console.log(JSON.stringify(analysis, null, 2))
  } else {
    console.log(formatPerfRegressionSummary(analysis))
  }

  if (options.strict && analysis.regressions.length > 0) {
    return 1
  }

  return 0
}

try {
  process.exitCode = run()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`perf-regression-spotter: ${message}`)
  process.exitCode = 2
}
