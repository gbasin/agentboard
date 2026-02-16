#!/usr/bin/env bun

import path from 'node:path'
import { runPrivacyPolicyChecker } from '../src/server/privacyPolicyChecker'

const rootDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dir, '..')

const result = await runPrivacyPolicyChecker({ rootDir })

if (result.ok) {
  console.log(`[privacy-policy] ok (${result.claimsChecked.length} claims checked)`)
  process.exit(0)
}

console.error(`[privacy-policy] ${result.violations.length} violation(s) found`)
for (const violation of result.violations) {
  const location = violation.file ? ` (${violation.file})` : ''
  console.error(`- ${violation.claimId}${location}: ${violation.message}`)
  console.error(`  fix: ${violation.fix}`)
}

process.exit(1)
