import { describe, expect, test } from 'bun:test'
import {
  analyzeSecurityFootguns,
  isSecurityFootgunTargetFile,
} from '../securityFootgun'

function scan(content: string, options?: { path?: string; threshold?: string }) {
  return analyzeSecurityFootguns({
    files: [
      {
        path: options?.path ?? 'src/server/security-sample.ts',
        content,
      },
    ],
    threshold: options?.threshold,
  })
}

describe('securityFootgun', () => {
  test('detects all high-signal rule families', () => {
    const content = [
      "import { exec, spawn } from 'node:child_process'",
      'exec(`echo ${userInput}`)',
      'eval(userInput)',
      "new Function('value', 'return value')",
      'container.innerHTML = htmlPayload',
      "container.insertAdjacentHTML('beforeend', htmlPayload)",
      'const jsx = <div dangerouslySetInnerHTML={{ __html: htmlPayload }} />',
      'const tlsOptions = { rejectUnauthorized: false }',
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'",
      "spawn('curl', ['--insecure', 'https://example.com'])",
      'const tmpPath = `/tmp/paste-${Date.now()}-${Math.random()}`',
    ].join('\n')

    const report = scan(content, { path: 'src/client/security-sample.tsx' })
    const ruleIds = new Set(report.findings.map((finding) => finding.ruleId))

    expect(ruleIds.has('dynamic-shell-interpolation')).toBe(true)
    expect(ruleIds.has('dangerous-eval')).toBe(true)
    expect(ruleIds.has('unsafe-html-injection')).toBe(true)
    expect(ruleIds.has('tls-verification-bypass')).toBe(true)
    expect(ruleIds.has('insecure-temp-file')).toBe(true)
  })

  test('does not flag eval text in comments as executable code', () => {
    const report = scan('const a = 1 // eval(userInput)')

    expect(report.findings).toHaveLength(0)
  })

  test('does not treat suppression text in strings as active directives', () => {
    const content = [
      'const marker = "// security-footgun-ignore-next-line dangerous-eval"',
      'eval(userInput)',
    ].join('\n')

    const report = scan(content)

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.ruleId).toBe('dangerous-eval')
  })

  test('block comment next-line suppression does not become wildcard from comment terminator', () => {
    const content = [
      '/* security-footgun-ignore-next-line dangerous-eval */',
      'container.innerHTML = userHtml',
    ].join('\n')

    const report = scan(content)

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.ruleId).toBe('unsafe-html-injection')
  })

  test('suppression applies only to configured rule and target line', () => {
    const content = [
      '// security-footgun-ignore-next-line dangerous-eval',
      'eval(userInput)',
      'container.innerHTML = userHtml',
      '/* security-footgun-ignore-line unsafe-html-injection */ container.innerHTML = otherHtml',
    ].join('\n')

    const report = scan(content)

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.ruleId).toBe('unsafe-html-injection')
    expect(report.summary.suppressedFindings).toBe(2)
  })

  test('severity ordering and threshold calculations are deterministic', () => {
    const content = [
      "import { exec } from 'node:child_process'",
      'exec(`echo ${input}`)',
      'eval(input)',
      'const tmpPath = `/tmp/${Date.now()}`',
    ].join('\n')

    const report = scan(content, { threshold: 'high' })

    expect(report.findings.map((finding) => finding.severity)).toEqual([
      'critical',
      'high',
      'moderate',
    ])
    expect(report.summary.thresholdBreaches).toBe(2)
    expect(report.summary.shouldFail).toBe(true)

    const criticalOnly = scan(content, { threshold: 'critical' })
    expect(criticalOnly.summary.thresholdBreaches).toBe(1)
    expect(criticalOnly.summary.shouldFail).toBe(true)
  })

  test('invalid threshold falls back to default and reports an error', () => {
    const content = 'eval(input)'

    const report = scan(content, { threshold: 'urgent' })

    expect(report.policy.threshold).toBe('high')
    expect(report.errors).toEqual([
      'Invalid threshold "urgent". Using default "high".',
    ])
  })

  test('filters only target TypeScript files in src/scripts and excludes tests', () => {
    expect(isSecurityFootgunTargetFile('src/server/index.ts')).toBe(true)
    expect(isSecurityFootgunTargetFile('src\\server\\index.ts')).toBe(true)
    expect(isSecurityFootgunTargetFile('.\\scripts\\dependency-risk.ts')).toBe(true)
    expect(isSecurityFootgunTargetFile('scripts/dependency-risk.ts')).toBe(true)
    expect(isSecurityFootgunTargetFile('src/shared/__tests__/securityFootgun.test.ts')).toBe(false)
    expect(isSecurityFootgunTargetFile('notes/draft.ts')).toBe(false)
    expect(isSecurityFootgunTargetFile('src/server/index.js')).toBe(false)
  })

  test('detects findings for Windows-style source paths', () => {
    const report = scan('eval(input)', { path: 'src\\server\\security-sample.ts' })

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.ruleId).toBe('dangerous-eval')
  })
})
