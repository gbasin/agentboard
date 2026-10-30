// Standalone read-only comparison; does not start an Agentboard server.
import { parseArgs } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { probeOwnership } from '../src/server/ownership/probe'
import { OwnershipObserver } from '../src/server/ownership/observer'
import type { OwnershipWindow } from '../src/server/ownership/probe'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  socket: { type: 'string' }, api: { type: 'string' },
  'codex-home': { type: 'string', default: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') },
  'claude-home': { type: 'string', default: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') },
} })
if (!values.socket || !path.isAbsolute(values.socket) || !values.api) throw new Error('Required: --socket /absolute/tmux/socket --api http://localhost:4040')
// Imports below this point cannot select a production log destination.
process.env.LOG_FILE = '/dev/null'
const { createLocalOwnershipIO } = await import('../src/server/ownership/localIO')
const io = createLocalOwnershipIO({ socket: values.socket, codexHome: values['codex-home']!, claudeHome: values['claude-home']! })
async function snapshot(): Promise<OwnershipWindow[]> {
  const response = await fetch(new URL('/api/sessions', values.api), { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`sessions GET failed: ${response.status}`)
  return await response.json() as OwnershipWindow[]
}
let windows = await snapshot()
const observer = new OwnershipObserver({
  windows: () => windows,
  probe: async initial => {
    const result = await probeOwnership(initial, io)
    windows = await snapshot()
    return result
  },
  log: (event, data) => console.log(JSON.stringify({ event, ...data })),
})
await observer.observe()
