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

function runTmux(args: string[]): string {
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

/** Stable per-server-incarnation id, created once and stored as a global option. */
export function ensureTmuxServerEpoch(): string {
  let epoch = runTmux(['show-options', '-gqv', '@agentboard-server-id'])
  if (!epoch) {
    runTmux(['set-option', '-g', '-o', '@agentboard-server-id', randomUUID()])
    epoch = runTmux(['show-options', '-gqv', '@agentboard-server-id'])
  }
  if (!epoch) throw new Error('tmux server identity unavailable')
  return epoch
}

// The epoch is scoped to the tmux server process. The server pid rides along
// in the window enumeration, so a restart (new pid) is the only event that
// requires re-reading the stored UUID — steady state never spawns tmux here.
// Pid 0 (enumerations that cannot read it) caches too: window-id reuse after
// an undetected restart is still caught by the run-tag checks downstream.
let epochCache: { pid: number; epoch: string } | null = null
export function tmuxEpochForPid(pid: number): string {
  if (epochCache?.pid === pid) return epochCache.epoch
  const epoch = ensureTmuxServerEpoch()
  epochCache = { pid, epoch }
  return epoch
}

const LAUNCH_WINDOW_NAME = /^__ab_launch__([a-f\d-]{36})__([a-f\d-]{36})$/i
export function provisionalTagFromName(name: string): WindowIdentity | null {
  const match = LAUNCH_WINDOW_NAME.exec(name)
  return match
    ? { boardId: match[1], runId: match[2], provisional: true }
    : null
}

export function readTmuxIdentity(sessionName: string): TmuxIdentity {
  const epoch = ensureTmuxServerEpoch()
  const output = runTmux([
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
    const launch = provisionalTagFromName(name)
    windows.set(
      `${sessionName}:${window}`,
      launch
        ? {
            boardId: boardId || launch.boardId,
            runId: runId || launch.runId,
            provisional: true,
          }
        : { boardId, runId }
    )
  }
  return { epoch, windows }
}
