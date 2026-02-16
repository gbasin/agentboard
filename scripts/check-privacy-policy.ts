import path from 'node:path'
import { runPrivacyPolicyChecker } from '../src/server/privacyPolicyChecker'

const report = runPrivacyPolicyChecker({ repoRoot: process.cwd() })

if (report.passed) {
  console.log(
    `[privacy] ok (${report.claims.length} claims, 0 violations) at ${path.join('docs', 'privacy-policy.md')}`
  )
  process.exit(0)
}

console.error(
  `[privacy] failed (${report.claims.length} claims, ${report.violations.length} violations)`
)

for (const violation of report.violations) {
  const fileSegment = violation.filePath ? ` file=${violation.filePath}` : ''
  const evidenceSegment = violation.evidence
    ? ` evidence=${JSON.stringify(violation.evidence)}`
    : ''
  console.error(
    `[privacy][${violation.claimId}] ${violation.message}${fileSegment}${evidenceSegment}`
  )
  console.error(`[privacy][${violation.claimId}] fix: ${violation.guidance}`)
}

process.exit(1)
