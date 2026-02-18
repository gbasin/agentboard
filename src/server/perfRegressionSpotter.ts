import fs from 'node:fs'
import { createInterface } from 'node:readline'

export type PerfEventName = 'log_poll' | 'log_match_profile'

export interface ParsedPerfEvent {
  event: PerfEventName
  timeMs: number
  payload: Record<string, unknown>
  source: string
  lineNumber: number
}

export interface PerfParseResult {
  events: ParsedPerfEvent[]
  totalLines: number
  malformedLines: number
  ignoredLines: number
}

export interface PerfMetricSample {
  metric: string
  event: PerfEventName
  valueMs: number
  timeMs: number
  source: string
}

export interface PerfRegressionOptions {
  baselineWindowMs?: number
  recentWindowMs?: number
  minSamplesPerWindow?: number
  relativeIncreaseThreshold?: number
  absoluteIncreaseThresholdMs?: number
  nowMs?: number
}

export interface NormalizedPerfRegressionOptions {
  baselineWindowMs: number
  recentWindowMs: number
  minSamplesPerWindow: number
  relativeIncreaseThreshold: number
  absoluteIncreaseThresholdMs: number
  nowMs: number
}

export type MetricStatus =
  | 'regression'
  | 'stable'
  | 'improved'
  | 'insufficient_samples'

export interface MetricAnalysis {
  metric: string
  event: PerfEventName
  status: MetricStatus
  baselineSamples: number
  recentSamples: number
  baselineMedianMs: number | null
  recentMedianMs: number | null
  deltaMs: number | null
  relativeDelta: number | null
}

export interface PerfRegressionFinding extends MetricAnalysis {
  status: 'regression'
  baselineMedianMs: number
  recentMedianMs: number
  deltaMs: number
  relativeDelta: number
}

export interface PerfRegressionAnalysis {
  files: string[]
  parse: {
    totalLines: number
    malformedLines: number
    ignoredLines: number
    eventsParsed: number
  }
  sampleCount: number
  options: NormalizedPerfRegressionOptions
  window: {
    baselineStartMs: number
    recentStartMs: number
    endMs: number
  }
  metrics: MetricAnalysis[]
  regressions: PerfRegressionFinding[]
}

const TARGET_EVENTS = new Set<PerfEventName>(['log_poll', 'log_match_profile'])

const DEFAULT_OPTIONS = {
  baselineWindowMs: 60 * 60 * 1000,
  recentWindowMs: 15 * 60 * 1000,
  minSamplesPerWindow: 6,
  relativeIncreaseThreshold: 0.3,
  absoluteIncreaseThresholdMs: 25,
}

interface DerivedMetricDef {
  sourceMetric: string
  divisorMetric: string
  name: string
}

const MATCH_PROFILE_PER_RUN_DERIVED: DerivedMetricDef[] = [
  {
    sourceMetric: 'windowMatchMs',
    divisorMetric: 'windowMatchRuns',
    name: 'windowMatchMsPerRun',
  },
  {
    sourceMetric: 'tmuxCaptureMs',
    divisorMetric: 'tmuxCaptures',
    name: 'tmuxCaptureMsPerCapture',
  },
  {
    sourceMetric: 'messageExtractMs',
    divisorMetric: 'messageExtractRuns',
    name: 'messageExtractMsPerRun',
  },
  {
    sourceMetric: 'tailReadMs',
    divisorMetric: 'tailReads',
    name: 'tailReadMsPerRead',
  },
  {
    sourceMetric: 'rgListMs',
    divisorMetric: 'rgListRuns',
    name: 'rgListMsPerRun',
  },
  {
    sourceMetric: 'rgJsonMs',
    divisorMetric: 'rgJsonRuns',
    name: 'rgJsonMsPerRun',
  },
  {
    sourceMetric: 'tailScoreMs',
    divisorMetric: 'tailScoreRuns',
    name: 'tailScoreMsPerRun',
  },
  {
    sourceMetric: 'rgScoreMs',
    divisorMetric: 'rgScoreRuns',
    name: 'rgScoreMsPerRun',
  },
  {
    sourceMetric: 'tieBreakRgMs',
    divisorMetric: 'tieBreakRgRuns',
    name: 'tieBreakRgMsPerRun',
  },
]

function readNumeric(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readTimestampMs(payload: Record<string, unknown>): number | null {
  const time = payload.time
  if (typeof time === 'number' && Number.isFinite(time)) {
    return time
  }
  if (typeof time === 'string') {
    const parsed = Date.parse(time)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function validatePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be > 0`)
  }
}

function validateNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be >= 0`)
  }
}

function validateIntegerAtLeast(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
}

function normalizeOptions(
  options: PerfRegressionOptions,
  nowMsFromData: number
): NormalizedPerfRegressionOptions {
  const baselineWindowMs = options.baselineWindowMs ?? DEFAULT_OPTIONS.baselineWindowMs
  const recentWindowMs = options.recentWindowMs ?? DEFAULT_OPTIONS.recentWindowMs
  const minSamplesPerWindow =
    options.minSamplesPerWindow ?? DEFAULT_OPTIONS.minSamplesPerWindow
  const relativeIncreaseThreshold =
    options.relativeIncreaseThreshold ?? DEFAULT_OPTIONS.relativeIncreaseThreshold
  const absoluteIncreaseThresholdMs =
    options.absoluteIncreaseThresholdMs ?? DEFAULT_OPTIONS.absoluteIncreaseThresholdMs

  const nowMs =
    options.nowMs ??
    (Number.isFinite(nowMsFromData) ? nowMsFromData : Date.now())

  validatePositive('baselineWindowMs', baselineWindowMs)
  validatePositive('recentWindowMs', recentWindowMs)
  validateIntegerAtLeast('minSamplesPerWindow', minSamplesPerWindow, 1)
  validateNonNegative('relativeIncreaseThreshold', relativeIncreaseThreshold)
  validateNonNegative('absoluteIncreaseThresholdMs', absoluteIncreaseThresholdMs)
  if (!Number.isFinite(nowMs)) {
    throw new Error('nowMs must be a finite timestamp')
  }
  if (nowMs <= 0) {
    throw new Error('nowMs must be > 0')
  }
  if (baselineWindowMs < recentWindowMs) {
    throw new Error('baselineWindowMs must be >= recentWindowMs')
  }

  return {
    baselineWindowMs,
    recentWindowMs,
    minSamplesPerWindow,
    relativeIncreaseThreshold,
    absoluteIncreaseThresholdMs,
    nowMs,
  }
}

interface ParseLineResult {
  event: ParsedPerfEvent | null
  malformed: boolean
  ignored: boolean
}

function parsePerfLine(
  rawLine: string,
  source: string,
  lineNumber: number
): ParseLineResult {
  const line = rawLine.trim()
  if (!line) {
    return { event: null, malformed: false, ignored: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { event: null, malformed: true, ignored: false }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { event: null, malformed: false, ignored: true }
  }

  const payload = parsed as Record<string, unknown>
  const event = payload.event
  if (typeof event !== 'string' || !TARGET_EVENTS.has(event as PerfEventName)) {
    return { event: null, malformed: false, ignored: true }
  }

  const timeMs = readTimestampMs(payload)
  if (timeMs === null) {
    return { event: null, malformed: false, ignored: true }
  }

  return {
    event: {
      event: event as PerfEventName,
      timeMs,
      payload,
      source,
      lineNumber,
    },
    malformed: false,
    ignored: false,
  }
}

export function parsePerfEventsFromText(
  text: string,
  source = '<inline>'
): PerfParseResult {
  const lines = text.split('\n')
  const events: ParsedPerfEvent[] = []

  let malformedLines = 0
  let ignoredLines = 0

  for (let index = 0; index < lines.length; index += 1) {
    const result = parsePerfLine(lines[index] ?? '', source, index + 1)
    if (result.event) {
      events.push(result.event)
      continue
    }
    if (result.malformed) {
      malformedLines += 1
      continue
    }
    if (result.ignored) {
      ignoredLines += 1
    }
  }

  return {
    events,
    totalLines: lines.length,
    malformedLines,
    ignoredLines,
  }
}

export async function parsePerfEventsFromFiles(filePaths: string[]): Promise<PerfParseResult> {
  const aggregate: PerfParseResult = {
    events: [],
    totalLines: 0,
    malformedLines: 0,
    ignoredLines: 0,
  }

  for (const filePath of filePaths) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const lineReader = createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    let lineNumber = 0
    for await (const line of lineReader) {
      lineNumber += 1
      aggregate.totalLines += 1
      const result = parsePerfLine(line, filePath, lineNumber)
      if (result.event) {
        aggregate.events.push(result.event)
        continue
      }
      if (result.malformed) {
        aggregate.malformedLines += 1
        continue
      }
      if (result.ignored) {
        aggregate.ignoredLines += 1
      }
    }
  }

  return aggregate
}

function pushMetric(
  output: PerfMetricSample[],
  event: ParsedPerfEvent,
  metric: string,
  value: number | null
): void {
  if (value === null || value < 0) {
    return
  }

  output.push({
    metric,
    event: event.event,
    valueMs: value,
    timeMs: event.timeMs,
    source: event.source,
  })
}

function buildDerivedMetric(
  payload: Record<string, unknown>,
  def: DerivedMetricDef
): number | null {
  const sourceValue = readNumeric(payload[def.sourceMetric])
  const divisor = readNumeric(payload[def.divisorMetric])

  if (sourceValue === null || divisor === null || divisor <= 0) {
    return null
  }

  return sourceValue / divisor
}

export function extractPerfMetricSamples(events: ParsedPerfEvent[]): PerfMetricSample[] {
  const samples: PerfMetricSample[] = []

  for (const event of events) {
    if (event.event === 'log_poll') {
      const durationMs = readNumeric(event.payload.durationMs)
      const logsScanned = readNumeric(event.payload.logsScanned)

      pushMetric(samples, event, 'log_poll.durationMs', durationMs)

      if (durationMs !== null && logsScanned !== null && logsScanned > 0) {
        pushMetric(
          samples,
          event,
          'log_poll.durationMsPerLog',
          durationMs / logsScanned
        )
      }
      continue
    }

    for (const [key, rawValue] of Object.entries(event.payload)) {
      if (!key.endsWith('Ms')) {
        continue
      }
      pushMetric(samples, event, `log_match_profile.${key}`, readNumeric(rawValue))
    }

    const logCount = readNumeric(event.payload.logCount)
    const scanMs = readNumeric(event.payload.scanMs)
    const matchMs = readNumeric(event.payload.matchMs)

    if (scanMs !== null && logCount !== null && logCount > 0) {
      pushMetric(samples, event, 'log_match_profile.scanMsPerLog', scanMs / logCount)
    }

    if (matchMs !== null && logCount !== null && logCount > 0) {
      pushMetric(samples, event, 'log_match_profile.matchMsPerLog', matchMs / logCount)
    }

    for (const def of MATCH_PROFILE_PER_RUN_DERIVED) {
      const derived = buildDerivedMetric(event.payload, def)
      pushMetric(samples, event, `log_match_profile.${def.name}`, derived)
    }
  }

  return samples
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0
  }
  const lower = sorted[middle - 1] ?? 0
  const upper = sorted[middle] ?? 0
  return (lower + upper) / 2
}

function toRelativeDelta(deltaMs: number, baselineMedianMs: number): number | null {
  if (baselineMedianMs <= 0) {
    if (deltaMs > 0) {
      return Number.POSITIVE_INFINITY
    }
    return 0
  }
  return deltaMs / baselineMedianMs
}

function analyzeMetric(
  metric: string,
  metricSamples: PerfMetricSample[],
  options: NormalizedPerfRegressionOptions,
  baselineStartMs: number,
  recentStartMs: number
): MetricAnalysis {
  const baselineValues: number[] = []
  const recentValues: number[] = []

  for (const sample of metricSamples) {
    if (sample.timeMs < baselineStartMs || sample.timeMs > options.nowMs) {
      continue
    }

    if (sample.timeMs >= recentStartMs) {
      recentValues.push(sample.valueMs)
    } else {
      baselineValues.push(sample.valueMs)
    }
  }

  const baselineSamples = baselineValues.length
  const recentSamples = recentValues.length
  const event = metricSamples[0]?.event ?? 'log_poll'

  if (
    baselineSamples < options.minSamplesPerWindow ||
    recentSamples < options.minSamplesPerWindow
  ) {
    return {
      metric,
      event,
      status: 'insufficient_samples',
      baselineSamples,
      recentSamples,
      baselineMedianMs: null,
      recentMedianMs: null,
      deltaMs: null,
      relativeDelta: null,
    }
  }

  const baselineMedianMs = median(baselineValues)
  const recentMedianMs = median(recentValues)
  const deltaMs = recentMedianMs - baselineMedianMs
  const relativeDelta = toRelativeDelta(deltaMs, baselineMedianMs)

  const isRegression =
    deltaMs >= options.absoluteIncreaseThresholdMs &&
    (relativeDelta ?? -1) >= options.relativeIncreaseThreshold

  if (isRegression) {
    return {
      metric,
      event,
      status: 'regression',
      baselineSamples,
      recentSamples,
      baselineMedianMs,
      recentMedianMs,
      deltaMs,
      relativeDelta,
    }
  }

  if (deltaMs < 0) {
    return {
      metric,
      event,
      status: 'improved',
      baselineSamples,
      recentSamples,
      baselineMedianMs,
      recentMedianMs,
      deltaMs,
      relativeDelta,
    }
  }

  return {
    metric,
    event,
    status: 'stable',
    baselineSamples,
    recentSamples,
    baselineMedianMs,
    recentMedianMs,
    deltaMs,
    relativeDelta,
  }
}

export function analyzePerfRegressionSamples(
  samples: PerfMetricSample[],
  options: PerfRegressionOptions = {}
): PerfRegressionAnalysis {
  const newestSampleTime = samples.reduce(
    (maxTime, sample) => (sample.timeMs > maxTime ? sample.timeMs : maxTime),
    Number.NEGATIVE_INFINITY
  )
  const normalized = normalizeOptions(options, newestSampleTime)

  const baselineStartMs =
    normalized.nowMs - normalized.recentWindowMs - normalized.baselineWindowMs
  const recentStartMs = normalized.nowMs - normalized.recentWindowMs

  const byMetric = new Map<string, PerfMetricSample[]>()
  for (const sample of samples) {
    const list = byMetric.get(sample.metric)
    if (list) {
      list.push(sample)
    } else {
      byMetric.set(sample.metric, [sample])
    }
  }

  const metrics = Array.from(byMetric.entries())
    .map(([metric, metricSamples]) =>
      analyzeMetric(metric, metricSamples, normalized, baselineStartMs, recentStartMs)
    )
    .sort((left, right) => left.metric.localeCompare(right.metric))

  const regressions = metrics
    .filter((metric): metric is PerfRegressionFinding => metric.status === 'regression')
    .sort((left, right) => right.deltaMs - left.deltaMs)

  return {
    files: [],
    parse: {
      totalLines: 0,
      malformedLines: 0,
      ignoredLines: 0,
      eventsParsed: 0,
    },
    sampleCount: samples.length,
    options: normalized,
    window: {
      baselineStartMs,
      recentStartMs,
      endMs: normalized.nowMs,
    },
    metrics,
    regressions,
  }
}

export async function analyzePerfRegressionLogs(
  filePaths: string[],
  options: PerfRegressionOptions = {}
): Promise<PerfRegressionAnalysis> {
  const parsed = await parsePerfEventsFromFiles(filePaths)
  const samples = extractPerfMetricSamples(parsed.events)
  const analysis = analyzePerfRegressionSamples(samples, options)

  return {
    ...analysis,
    files: [...filePaths],
    parse: {
      totalLines: parsed.totalLines,
      malformedLines: parsed.malformedLines,
      ignoredLines: parsed.ignoredLines,
      eventsParsed: parsed.events.length,
    },
  }
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return 'inf%'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatMs(value: number | null): string {
  if (value === null) return 'n/a'
  return `${value.toFixed(2)}ms`
}

export function formatPerfRegressionSummary(
  analysis: PerfRegressionAnalysis
): string {
  const lines: string[] = []
  const baselineMinutes = Math.round(analysis.options.baselineWindowMs / 60000)
  const recentMinutes = Math.round(analysis.options.recentWindowMs / 60000)

  lines.push('Performance Regression Spotter')
  lines.push(
    `Files: ${analysis.files.length} | Lines: ${analysis.parse.totalLines} | Events: ${analysis.parse.eventsParsed} | Samples: ${analysis.sampleCount}`
  )
  lines.push(
    `Window: baseline=${baselineMinutes}m recent=${recentMinutes}m | Min samples/window: ${analysis.options.minSamplesPerWindow}`
  )
  lines.push(
    `Thresholds: +${analysis.options.absoluteIncreaseThresholdMs.toFixed(2)}ms and +${formatPercent(
      analysis.options.relativeIncreaseThreshold
    )}`
  )

  if (analysis.parse.malformedLines > 0) {
    lines.push(`Ignored malformed lines: ${analysis.parse.malformedLines}`)
  }

  lines.push(`Regressions: ${analysis.regressions.length}`)

  if (analysis.regressions.length > 0) {
    for (const regression of analysis.regressions) {
      lines.push(
        `- ${regression.metric}: ${formatMs(regression.baselineMedianMs)} -> ${formatMs(regression.recentMedianMs)} (Δ ${formatMs(regression.deltaMs)}, ${formatPercent(regression.relativeDelta)}) [baseline=${regression.baselineSamples}, recent=${regression.recentSamples}]`
      )
    }
  }

  const lowSampleMetrics = analysis.metrics.filter(
    (metric) => metric.status === 'insufficient_samples'
  )

  if (lowSampleMetrics.length > 0) {
    lines.push(`Low-sample metrics skipped: ${lowSampleMetrics.length}`)
    for (const metric of lowSampleMetrics.slice(0, 8)) {
      lines.push(
        `- ${metric.metric}: baseline=${metric.baselineSamples}, recent=${metric.recentSamples}`
      )
    }
  }

  return lines.join('\n')
}
