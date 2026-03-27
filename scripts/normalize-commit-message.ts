#!/usr/bin/env bun

import { COMMIT_MESSAGE_TYPES, normalizeCommitMessage } from '../src/shared/commitMessage'

async function main() {
  const commitMessagePath = process.argv[2]
  if (!commitMessagePath) {
    console.error('Usage: bun scripts/normalize-commit-message.ts <commit-message-file>')
    process.exit(1)
  }

  const currentMessage = await Bun.file(commitMessagePath).text()
  const result = normalizeCommitMessage(currentMessage)

  if (!result.ok) {
    console.error('Invalid commit message subject.')
    console.error(result.error.message)
    console.error(
      `Supported types: ${COMMIT_MESSAGE_TYPES.join(', ')}.`
    )
    process.exit(1)
  }

  if (result.mode === 'normalized' && result.changed) {
    await Bun.write(commitMessagePath, result.normalizedMessage)
    console.log(`Normalized commit subject to: ${result.parsed.normalizedHeader}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
