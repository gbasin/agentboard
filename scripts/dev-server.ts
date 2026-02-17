import os from 'node:os'
import path from 'node:path'

if (!process.env.LOG_FILE) {
  process.env.LOG_FILE = path.join(os.homedir(), '.agentboard', 'agentboard.log')
}

const child = Bun.spawn(['bun', '--watch', 'src/server/index.ts'], {
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

const forwardSignal = (signal: NodeJS.Signals) => {
  try {
    child.kill(signal)
  } catch {
    // Child may already be exiting.
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

const exitCode = await child.exited
process.exit(exitCode)
