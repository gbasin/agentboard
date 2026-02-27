import { describe, expect, test } from 'bun:test'
import {
  analyzeSecurityFootguns,
  isValidSecurityFootgunSeverity,
  shouldScanSecurityFootgunPath,
} from '../securityFootgun'

describe('securityFootgun', () => {
  test('detects high-signal security foot-guns across key rule families', () => {
    const report = analyzeSecurityFootguns({
      files: [
        {
          path: 'src/server/securityExample.ts',
          content: [
            "import { exec } from 'node:child_process'",
            'exec(`rm -rf ${userInput}`)',
            'eval(userInput)',
            "new Function('code', userInput)",
            'el.innerHTML = userInput',
            "el.insertAdjacentHTML('beforeend', userInput)",
            'client.get({ rejectUnauthorized: false })',
            "const tempPath = os.tmpdir() + '/agentboard-' + userInput",
          ].join('\n'),
        },
      ],
    })

    expect(report.errors).toHaveLength(0)
    expect(report.summary.totalFindings).toBe(7)
    expect(report.counts.critical).toBe(4)
    expect(report.counts.high).toBe(2)
    expect(report.counts.moderate).toBe(1)
    expect(report.summary.highestSeverity).toBe('critical')
    expect(report.findings[0]?.severity).toBe('critical')

    const ruleIds = new Set(report.findings.map((finding) => finding.ruleId))
    expect(ruleIds.has('dynamic-shell-interpolation')).toBe(true)
    expect(ruleIds.has('dangerous-eval')).toBe(true)
    expect(ruleIds.has('unsafe-html-injection')).toBe(true)
    expect(ruleIds.has('tls-verification-bypass')).toBe(true)
    expect(ruleIds.has('insecure-temp-file-construction')).toBe(true)
  })

  test('supports inline and next-line suppression directives', () => {
    const report = analyzeSecurityFootguns({
      files: [
        {
          path: 'src/server/suppressed.ts',
          content: [
            "import { exec } from 'node:child_process'",
            'exec(`echo ${userInput}`) // security-footgun-ignore dynamic-shell-interpolation',
            '// security-footgun-ignore-next-line dangerous-eval',
            'eval(userInput)',
            '// security-footgun-ignore-next-line',
            "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'",
          ].join('\n'),
        },
      ],
    })

    expect(report.findings).toHaveLength(0)
    expect(report.summary.shouldFail).toBe(false)
  })

  test('does not suppress unrelated rules when rule id is specific', () => {
    const report = analyzeSecurityFootguns({
      files: [
        {
          path: 'src/server/partialSuppression.ts',
          content:
            'eval(userInput) // security-footgun-ignore dynamic-shell-interpolation',
        },
      ],
    })

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.ruleId).toBe('dangerous-eval')
  })

  test('computes fail threshold behavior by severity policy', () => {
    const file = {
      path: 'src/client/example.ts',
      content: [
        'element.innerHTML = userInput',
        "const tmp = os.tmpdir() + '/x-' + userInput",
      ].join('\n'),
    }

    const reportHigh = analyzeSecurityFootguns({
      files: [file],
      failOnSeverity: 'high',
    })

    const reportCritical = analyzeSecurityFootguns({
      files: [file],
      failOnSeverity: 'critical',
    })

    expect(reportHigh.summary.thresholdBreaches).toBe(1)
    expect(reportHigh.summary.shouldFail).toBe(true)
    expect(reportCritical.summary.thresholdBreaches).toBe(0)
    expect(reportCritical.summary.shouldFail).toBe(false)
  })

  test('avoids key false positives for safe patterns', () => {
    const report = analyzeSecurityFootguns({
      files: [
        {
          path: 'src/client/safePatterns.ts',
          content: [
            "exec('ls -la')",
            "container.innerHTML = ''",
            'request({ rejectUnauthorized: true })',
            "const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))",
          ].join('\n'),
        },
      ],
    })

    expect(report.findings).toHaveLength(0)
    expect(report.summary.shouldFail).toBe(false)
  })

  test('filters scanner paths to src/scripts TypeScript sources only', () => {
    expect(shouldScanSecurityFootgunPath('src/server/index.ts')).toBe(true)
    expect(shouldScanSecurityFootgunPath('scripts/security-footgun.ts')).toBe(true)
    expect(shouldScanSecurityFootgunPath('src/shared/types.d.ts')).toBe(false)
    expect(shouldScanSecurityFootgunPath('src/shared/__tests__/securityFootgun.test.ts')).toBe(false)
    expect(shouldScanSecurityFootgunPath('README.md')).toBe(false)
  })

  test('validates supported severity values', () => {
    expect(isValidSecurityFootgunSeverity('critical')).toBe(true)
    expect(isValidSecurityFootgunSeverity('high')).toBe(true)
    expect(isValidSecurityFootgunSeverity('moderate')).toBe(true)
    expect(isValidSecurityFootgunSeverity('low')).toBe(true)
    expect(isValidSecurityFootgunSeverity('blocker')).toBe(false)
  })
})
