import { describe, expect, test } from 'bun:test'
import {
  analyzeDependencyRisk,
  classifyMaintenanceLag,
  parseBunAuditOutput,
  parseBunOutdatedOutput,
} from '../dependencyRisk'

describe('dependencyRisk', () => {
  test('parses bun audit JSON with mixed severities and strips console noise', () => {
    const output = [
      '[0.02ms] ".env"',
      '\u001b[0m\u001b[1mbun audit \u001b[0m\u001b[2mv1.3.8\u001b[0m',
      JSON.stringify({
        zebra: [{ id: 9, title: 'zebra advisory', severity: 'moderate' }],
        alpha: [
          { id: 3, title: 'critical issue', severity: 'critical' },
          { id: 2, title: 'low issue', severity: 'low' },
        ],
      }),
    ].join('\n')

    const parsed = parseBunAuditOutput(output)

    expect(parsed.errors).toHaveLength(0)
    expect(parsed.findings).toHaveLength(3)
    expect(parsed.findings[0]).toMatchObject({
      packageName: 'alpha',
      severity: 'critical',
    })
    expect(parsed.findings[1]).toMatchObject({
      packageName: 'zebra',
      severity: 'moderate',
    })
    expect(parsed.findings[2]).toMatchObject({
      packageName: 'alpha',
      severity: 'low',
    })
  })

  test('computes threshold breaches and fail behavior', () => {
    const reportHigh = analyzeDependencyRisk({
      auditOutput: JSON.stringify({
        hono: [{ id: 1, title: 'high vuln', severity: 'high' }],
        lodash: [{ id: 2, title: 'low vuln', severity: 'low' }],
      }),
      outdatedOutput: '',
      failOnSeverity: 'high',
    })
    const reportCritical = analyzeDependencyRisk({
      auditOutput: JSON.stringify({
        hono: [{ id: 1, title: 'high vuln', severity: 'high' }],
      }),
      outdatedOutput: '',
      failOnSeverity: 'critical',
    })

    expect(reportHigh.security.counts.high).toBe(1)
    expect(reportHigh.summary.thresholdBreaches).toBe(1)
    expect(reportHigh.summary.shouldFail).toBe(true)

    expect(reportCritical.summary.thresholdBreaches).toBe(0)
    expect(reportCritical.summary.shouldFail).toBe(false)
  })

  test('handles empty findings without failing', () => {
    const report = analyzeDependencyRisk({
      auditOutput: '{}',
      outdatedOutput: 'bun outdated v1.3.8\nNo outdated dependencies found\n',
    })

    expect(report.errors).toHaveLength(0)
    expect(report.security.highestSeverity).toBe('none')
    expect(report.summary.totalSecurityFindings).toBe(0)
    expect(report.summary.totalMaintenanceFindings).toBe(0)
    expect(report.summary.shouldFail).toBe(false)
  })

  test('reports malformed tool output as errors without throwing', () => {
    const report = analyzeDependencyRisk({
      auditOutput: 'not-json',
      outdatedOutput: 'unexpected text that is not a table',
    })

    expect(report.security.findings).toHaveLength(0)
    expect(report.maintenance.findings).toHaveLength(0)
    expect(report.errors).toEqual([
      'Unable to parse bun audit output: JSON payload not found.',
      'Unable to parse bun outdated output: table rows not found.',
    ])
    expect(report.summary.shouldFail).toBe(false)
  })

  test('parses maintenance lag levels including major-version lag', () => {
    const output = [
      'bun outdated v1.3.8',
      '| Package | Current | Update | Latest |',
      '|---------|---------|--------|--------|',
      '| react | 18.3.1 | 18.3.1 | 19.2.4 |',
      '| motion | 12.25.0 | 12.34.1 | 12.34.1 |',
      '| pino | 10.3.0 | 10.3.1 | 10.3.1 |',
      '| @types/node (dev) | 22.10.2 | 22.10.2 | 25.2.3 |',
      '|----------------------------------------------|',
    ].join('\n')

    const parsed = parseBunOutdatedOutput(output)

    expect(parsed.errors).toHaveLength(0)
    expect(parsed.findings).toHaveLength(4)
    expect(parsed.findings[0]).toMatchObject({
      packageName: '@types/node',
      dependencyType: 'dev',
      lag: 'major',
      riskLevel: 'high',
    })
    expect(parsed.findings[1]).toMatchObject({
      packageName: 'react',
      lag: 'major',
      riskLevel: 'high',
    })
    expect(parsed.findings[2]).toMatchObject({
      packageName: 'motion',
      lag: 'minor',
      riskLevel: 'moderate',
    })
    expect(parsed.findings[3]).toMatchObject({
      packageName: 'pino',
      lag: 'patch',
      riskLevel: 'low',
    })
  })

  test('classifies semantic version lag heuristics', () => {
    expect(classifyMaintenanceLag('1.2.3', '2.0.0')).toBe('major')
    expect(classifyMaintenanceLag('1.2.3', '1.3.0')).toBe('minor')
    expect(classifyMaintenanceLag('1.2.3', '1.2.4')).toBe('patch')
    expect(classifyMaintenanceLag('1.2.3', '1.2.3')).toBe('none')
    expect(classifyMaintenanceLag('workspace:*', '1.2.3')).toBe('unknown')
  })
})
