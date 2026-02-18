import fs from 'node:fs'
import path from 'node:path'
import {
  analyzePerfRegressionLogs,
  formatPerfRegressionSummary,
  type PerfRegressionAnalysis,
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
const DEFAULT_BASELINE_MINUTES = 60
const DEFAULT_RECENT_MINUTES = 15

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

interface NumberArgRules {
  minimum?: number
  minimumExclusive?: number
  integer?: boolean
}

function parseNumberArg(value: string, label: string, rules: NumberArgRules = {}): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }

  if (rules.integer && !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${label}: expected an integer, got ${value}`)
  }

  if (rules.minimumExclusive !== undefined && parsed <= rules.minimumExclusive) {
    throw new Error(`Invalid ${label}: must be > ${rules.minimumExclusive}`)
  }

  if (rules.minimum !== undefined && parsed < rules.minimum) {
    throw new Error(`Invalid ${label}: must be >= ${rules.minimum}`)
  }

  return parsed
}

function parseNow(value: string): number {
  const asNumber = Number(value)
  if (Number.isFinite(asNumber)) {
    if (asNumber <= 0) {
      throw new Error(`Invalid --now value: must be > 0, got ${value}`)
    }
    return asNumber
  }
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) {
    if (parsed <= 0) {
      throw new Error(`Invalid --now value: must be > 0, got ${value}`)
    }
    return parsed
  }
  throw new Error(`Invalid --now value: ${value}`)
}

function readRequiredValue(args: string[], index: number, flag: string): string {
  const next = args[index + 1]
  if (
    next === undefined ||
    next.length === 0 ||
    next === '-h' ||
    next === '--help' ||
    next.startsWith('--')
  ) {
    throw new Error(`Missing value for ${flag}`)
  }
  return next
}

function ensureValidWindowOptions(options: PerfRegressionOptions): void {
  const baselineWindowMs =
    options.baselineWindowMs ?? DEFAULT_BASELINE_MINUTES * 60 * 1000
  const recentWindowMs = options.recentWindowMs ?? DEFAULT_RECENT_MINUTES * 60 * 1000
  if (baselineWindowMs < recentWindowMs) {
    throw new Error('Invalid window configuration: --baseline-minutes must be >= --recent-minutes')
  }
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

    if (arg === '--file') {
      const next = readRequiredValue(args, index, arg)
      options.files.push(expandHome(next))
      index += 1
      continue
    }

    if (arg === '--baseline-minutes') {
      const next = readRequiredValue(args, index, arg)
      options.analysis.baselineWindowMs =
        parseNumberArg(next, arg, { minimumExclusive: 0 }) * 60 * 1000
      index += 1
      continue
    }

    if (arg === '--recent-minutes') {
      const next = readRequiredValue(args, index, arg)
      options.analysis.recentWindowMs =
        parseNumberArg(next, arg, { minimumExclusive: 0 }) * 60 * 1000
      index += 1
      continue
    }

    if (arg === '--min-samples') {
      const next = readRequiredValue(args, index, arg)
      options.analysis.minSamplesPerWindow = parseNumberArg(next, arg, {
        integer: true,
        minimum: 1,
      })
      index += 1
      continue
    }

    if (arg === '--relative-threshold') {
      const next = readRequiredValue(args, index, arg)
      options.analysis.relativeIncreaseThreshold = parseNumberArg(next, arg, {
        minimum: 0,
      })
      index += 1
      continue
    }

    if (arg === '--absolute-threshold-ms') {
      const next = readRequiredValue(args, index, arg)
      options.analysis.absoluteIncreaseThresholdMs = parseNumberArg(next, arg, {
        minimum: 0,
      })
      index += 1
      continue
    }

    if (arg === '--format') {
      const next = readRequiredValue(args, index, arg)
      if (next !== 'human' && next !== 'json') {
        throw new Error(`Invalid --format value: ${next}`)
      }
      options.format = next
      index += 1
      continue
    }

    if (arg === '--now') {
      const next = readRequiredValue(args, index, arg)
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

  ensureValidWindowOptions(options.analysis)

  return options
}

function validateFiles(files: string[]): void {
  const missing = files.filter((filePath) => !fs.existsSync(filePath))
  if (missing.length > 0) {
    throw new Error(`Log file(s) not found: ${missing.join(', ')}`)
  }
}

function assertAnalysisHasUsableData(analysis: PerfRegressionAnalysis): void {
  if (analysis.parse.eventsParsed === 0) {
    throw new Error(
      'No log_poll/log_match_profile events found. Check LOG_LEVEL and AGENTBOARD_LOG_MATCH_PROFILE telemetry settings.'
    )
  }

  if (analysis.sampleCount === 0 || analysis.metrics.length === 0) {
    throw new Error('No perf metric samples extracted from parsed events.')
  }

  const actionableMetrics = analysis.metrics.filter(
    (metric) => metric.status !== 'insufficient_samples'
  )
  if (actionableMetrics.length === 0) {
    throw new Error(
      'No metrics met minimum sample requirements in both baseline/recent windows. Increase window sizes or capture more telemetry.'
    )
  }
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))

  if (options.showHelp) {
    printHelp()
    return 0
  }

  validateFiles(options.files)

  const analysis = await analyzePerfRegressionLogs(options.files, options.analysis)
  assertAnalysisHasUsableData(analysis)
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

void (async () => {
  try {
    process.exitCode = await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`perf-regression-spotter: ${message}`)
    process.exitCode = 2
  }
})()
