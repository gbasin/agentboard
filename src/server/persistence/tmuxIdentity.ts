/** Reliable tmux server/window identities; failure is distinct from an empty server. */
import { randomUUID } from 'node:crypto'
import { config } from '../config'

export interface WindowIdentity {
  boardId: string
  runId: string
  provisional?: boolean
}
export interface TmuxIdentity {
  epoch: string
  windows: Map<string, WindowIdentity>
}
export function readTmuxIdentity(sessionName: string): TmuxIdentity {
  const run = (args: string[]) => {
    const result = Bun.spawnSync(['tmux', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: config.tmuxTimeoutMs || 3000,
    })
    if (result.exitCode !== 0 || result.signalCode)
      throw new Error(
        result.stderr.toString().trim() || 'tmux identity unavailable'
      )
    return result.stdout.toString().trim()
  }
  let epoch = run(['show-options', '-gqv', '@agentboard-server-id'])
  if (!epoch) {
    run(['set-option', '-g', '-o', '@agentboard-server-id', randomUUID()])
    epoch = run(['show-options', '-gqv', '@agentboard-server-id'])
  }
  if (!epoch) throw new Error('tmux server identity unavailable')
  const output = run([
    'list-windows',
    '-t',
    `=${sessionName}`,
    '-F',
    '#{window_id}|#{@agentboard-session-id}|#{@agentboard-run-id}|#{window_name}',
  ])
  const windows = new Map<string, WindowIdentity>()
  for (const line of output.split('\n')) {
    if (!line) continue
    const [window, boardId, runId, name] = line.split('|')
    if (!/^@\d+$/.test(window) || name === undefined)
      throw new Error('Invalid tmux identity snapshot')
    if (name === '__agentboard_root__') continue
    const launch = /^__ab_launch__([a-f\d-]{36})__([a-f\d-]{36})$/i.exec(name)
    windows.set(
      `${sessionName}:${window}`,
      launch
        ? {
            boardId: boardId || launch[1],
            runId: runId || launch[2],
            provisional: true,
          }
        : { boardId, runId }
    )
  }
  return { epoch, windows }
}
