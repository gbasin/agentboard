import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  analyzePerfRegressionLogs,
  analyzePerfRegressionSamples,
  extractPerfMetricSamples,
  parsePerfEventsFromText,
} from '../perfRegressionSpotter'

const NOW_MS = Date.parse('2026-02-18T12:00:00.000Z')
const BASELINE_WINDOW_MS = 60 * 60 * 1000
const RECENT_WINDOW_MS = 15 * 60 * 1000

function buildLogPollLine(timeMs: number, durationMs: number, logsScanned = 12): string {
  return JSON.stringify({
    time: new Date(timeMs).toISOString(),
    event: 'log_poll',
    durationMs,
    logsScanned,
  })
}

function buildLogMatchProfileLine(timeMs: number, rgJsonMs: number, rgJsonRuns: number): string {
  return JSON.stringify({
    time: new Date(timeMs).toISOString(),
    event: 'log_match_profile',
    scanMs: rgJsonMs * 2,
    matchMs: rgJsonMs * 3,
    logCount: 12,
    rgJsonMs,
    rgJsonRuns,
  })
}

function baselineTime(index: number): number {
  return NOW_MS - 70 * 60 * 1000 + index * 60 * 1000
}

function recentTime(index: number): number {
  return NOW_MS - 14 * 60 * 1000 + index * 60 * 1000
}

async function writeTempLog(lines: string[]): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-perf-spotter-'))
  const file = path.join(dir, 'agentboard.log')
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  return { dir, file }
}

describe('perfRegressionSpotter', () => {
  test('parses target events and counts malformed/ignored lines', () => {
    const text = [
      buildLogPollLine(NOW_MS - 1000, 90),
      '{"event":"log_poll","durationMs":55}',
      '{not-json',
      JSON.stringify({ event: 'not_target', time: new Date(NOW_MS).toISOString() }),
    ].join('\n')

    const parsed = parsePerfEventsFromText(text)

    expect(parsed.events).toHaveLength(1)
    expect(parsed.malformedLines).toBe(1)
    expect(parsed.ignoredLines).toBe(2)
  })

  test('returns insufficient_samples when windows do not have enough data', () => {
    const lines: string[] = []
    for (let i = 0; i < 4; i += 1) {
      lines.push(buildLogPollLine(baselineTime(i), 40))
      lines.push(buildLogPollLine(recentTime(i), 120))
    }

    const parsed = parsePerfEventsFromText(lines.join('\n'))
    const samples = extractPerfMetricSamples(parsed.events)
    const analysis = analyzePerfRegressionSamples(samples, {
      nowMs: NOW_MS,
      baselineWindowMs: BASELINE_WINDOW_MS,
      recentWindowMs: RECENT_WINDOW_MS,
      minSamplesPerWindow: 6,
      absoluteIncreaseThresholdMs: 20,
      relativeIncreaseThreshold: 0.5,
    })

    const pollMetric = analysis.metrics.find((metric) => metric.metric === 'log_poll.durationMs')
    expect(pollMetric?.status).toBe('insufficient_samples')
    expect(analysis.regressions).toHaveLength(0)
  })

  test('detects regressions for poll duration and match-profile run cost', async () => {
    const lines: string[] = []

    for (let i = 0; i < 10; i += 1) {
      lines.push(buildLogPollLine(baselineTime(i), 45))
      lines.push(buildLogMatchProfileLine(baselineTime(i), 20, 4))
    }

    for (let i = 0; i < 10; i += 1) {
      lines.push(buildLogPollLine(recentTime(i), 120))
      lines.push(buildLogMatchProfileLine(recentTime(i), 52, 4))
    }

    const { dir, file } = await writeTempLog(lines)

    try {
      const analysis = await analyzePerfRegressionLogs([file], {
        nowMs: NOW_MS,
        baselineWindowMs: BASELINE_WINDOW_MS,
        recentWindowMs: RECENT_WINDOW_MS,
        minSamplesPerWindow: 6,
        absoluteIncreaseThresholdMs: 5,
        relativeIncreaseThreshold: 0.5,
      })

      expect(analysis.regressions.some((finding) => finding.metric === 'log_poll.durationMs')).toBe(
        true
      )
      expect(
        analysis.regressions.some(
          (finding) => finding.metric === 'log_match_profile.rgJsonMsPerRun'
        )
      ).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('does not flag relative-only changes when absolute delta is below threshold', async () => {
    const lines: string[] = []

    for (let i = 0; i < 8; i += 1) {
      lines.push(buildLogPollLine(baselineTime(i), 1, 1))
      lines.push(buildLogPollLine(recentTime(i), 2, 1))
    }

    const { dir, file } = await writeTempLog(lines)

    try {
      const analysis = await analyzePerfRegressionLogs([file], {
        nowMs: NOW_MS,
        baselineWindowMs: BASELINE_WINDOW_MS,
        recentWindowMs: RECENT_WINDOW_MS,
        minSamplesPerWindow: 6,
        absoluteIncreaseThresholdMs: 10,
        relativeIncreaseThreshold: 0.1,
      })

      expect(analysis.regressions).toHaveLength(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects invalid option combinations in core analyzer', () => {
    expect(() =>
      analyzePerfRegressionSamples([], {
        nowMs: NOW_MS,
        baselineWindowMs: 10 * 60 * 1000,
        recentWindowMs: 15 * 60 * 1000,
      })
    ).toThrow('baselineWindowMs must be >= recentWindowMs')
    expect(() =>
      analyzePerfRegressionSamples([], {
        nowMs: 0,
      })
    ).toThrow('nowMs must be > 0')
  })
})

describe('perf-regression-spotter CLI', () => {
  test('returns exit code 1 in strict mode when regressions are found and emits JSON', async () => {
    const lines: string[] = []
    for (let i = 0; i < 8; i += 1) {
      lines.push(buildLogPollLine(baselineTime(i), 35))
      lines.push(buildLogPollLine(recentTime(i), 90))
    }

    const { dir, file } = await writeTempLog(lines)

    try {
      const result = Bun.spawnSync(
        [
          'bun',
          'scripts/perf-regression-spotter.ts',
          '--file',
          file,
          '--baseline-minutes',
          '60',
          '--recent-minutes',
          '15',
          '--min-samples',
          '6',
          '--absolute-threshold-ms',
          '10',
          '--relative-threshold',
          '0.2',
          '--strict',
          '--json',
          '--now',
          String(NOW_MS),
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(1)
      const output = JSON.parse(result.stdout.toString()) as {
        regressions: Array<{ metric: string }>
      }
      expect(output.regressions.length).toBeGreaterThan(0)
      expect(output.regressions.some((item) => item.metric === 'log_poll.durationMs')).toBe(
        true
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('returns exit code 0 without --strict and prints human summary', async () => {
    const lines: string[] = []
    for (let i = 0; i < 8; i += 1) {
      lines.push(buildLogPollLine(baselineTime(i), 30))
      lines.push(buildLogPollLine(recentTime(i), 85))
    }

    const { dir, file } = await writeTempLog(lines)

    try {
      const result = Bun.spawnSync(
        [
          'bun',
          'scripts/perf-regression-spotter.ts',
          '--file',
          file,
          '--baseline-minutes',
          '60',
          '--recent-minutes',
          '15',
          '--min-samples',
          '6',
          '--absolute-threshold-ms',
          '10',
          '--relative-threshold',
          '0.2',
          '--now',
          String(NOW_MS),
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(0)
      const stdout = result.stdout.toString()
      expect(stdout).toContain('Performance Regression Spotter')
      expect(stdout).toContain('Regressions:')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('fails with exit code 2 when an option is missing its value', async () => {
    const { dir, file } = await writeTempLog([buildLogPollLine(NOW_MS - 1000, 10)])

    try {
      const result = Bun.spawnSync(
        ['bun', 'scripts/perf-regression-spotter.ts', '--file', file, '--baseline-minutes'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain('Missing value for --baseline-minutes')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('fails with exit code 2 on out-of-range numeric arguments', async () => {
    const { dir, file } = await writeTempLog([buildLogPollLine(NOW_MS - 1000, 10)])

    try {
      const result = Bun.spawnSync(
        ['bun', 'scripts/perf-regression-spotter.ts', '--file', file, '--min-samples', '0'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain('Invalid --min-samples: must be >= 1')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('fails with exit code 2 when default window settings conflict with provided baseline', async () => {
    const { dir, file } = await writeTempLog([buildLogPollLine(NOW_MS - 1000, 10)])

    try {
      const result = Bun.spawnSync(
        ['bun', 'scripts/perf-regression-spotter.ts', '--file', file, '--baseline-minutes', '10'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain('--baseline-minutes must be >= --recent-minutes')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('fails with exit code 2 when --now is non-positive', async () => {
    const { dir, file } = await writeTempLog([buildLogPollLine(NOW_MS - 1000, 10)])

    try {
      const result = Bun.spawnSync(
        ['bun', 'scripts/perf-regression-spotter.ts', '--file', file, '--now', '0'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain('Invalid --now value: must be > 0')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('fails with exit code 2 when logs have no target telemetry events', async () => {
    const { dir, file } = await writeTempLog([
      JSON.stringify({
        time: new Date(NOW_MS).toISOString(),
        event: 'startup_state',
      }),
    ])

    try {
      const result = Bun.spawnSync(
        ['bun', 'scripts/perf-regression-spotter.ts', '--file', file, '--json'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain('No log_poll/log_match_profile events found')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('fails with exit code 2 when no metrics meet sample requirements', async () => {
    const lines: string[] = []
    for (let i = 0; i < 3; i += 1) {
      lines.push(buildLogPollLine(baselineTime(i), 30))
      lines.push(buildLogPollLine(recentTime(i), 90))
    }

    const { dir, file } = await writeTempLog(lines)

    try {
      const result = Bun.spawnSync(
        ['bun', 'scripts/perf-regression-spotter.ts', '--file', file, '--json'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain(
        'No metrics met minimum sample requirements in both baseline/recent windows'
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
