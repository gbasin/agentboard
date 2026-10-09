import type { TerminalErrorCode } from '../../shared/types'

type SpawnFn = (
  args: string[],
  options: Parameters<typeof Bun.spawn>[1]
) => ReturnType<typeof Bun.spawn>

type SpawnSyncFn = (
  args: string[],
  options: Parameters<typeof Bun.spawnSync>[1]
) => ReturnType<typeof Bun.spawnSync>

interface SpawnAsyncResult {
  exitCode: number | null
  signalCode: string | null
  stdout: string
  stderr: string
}

// Non-blocking command runner (default: timedSpawnAsync over Bun.spawn).
type SpawnAsyncFn = (
  args: string[],
  options: { timeout?: number; env?: Record<string, string | undefined> }
) => Promise<SpawnAsyncResult>

type WaitFn = (ms: number) => Promise<void>

type TerminalMode = 'pty' | 'pipe-pane' | 'auto'

enum TerminalState {
  INITIAL = 'INITIAL',
  ATTACHING = 'ATTACHING',
  READY = 'READY',
  SWITCHING = 'SWITCHING',
  DEAD = 'DEAD',
}

class TerminalProxyError extends Error {
  code: TerminalErrorCode
  retryable: boolean

  constructor(code: TerminalErrorCode, message: string, retryable: boolean) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

interface TerminalProxyOptions {
  connectionId: string
  sessionName: string
  baseSession: string
  onData: (data: string) => void
  onExit?: () => void
  spawn?: SpawnFn
  spawnSync?: SpawnSyncFn
  // Defaults to Bun.spawn, or to spawnSync when only that is injected (tests
  // that fake tmux synchronously keep seeing every command).
  spawnAsync?: SpawnAsyncFn
  // Called after each grouped new-session; arms the throwaway-shell reaper
  // (see tmuxGroupedSession.ts). Must not block.
  onGroupedSessionCreated?: () => void
  now?: () => number
  wait?: WaitFn
  monitorTargets?: boolean
  host?: string
  sshOptions?: string[]
  commandTimeoutMs?: number
  mutationTimeoutMs?: number
}

interface ITerminalProxy {
  start(): Promise<void>
  switchTo(target: string, onReady?: () => void): Promise<boolean>
  // For external (non-managed) sessions this may create a backing tmux
  // session as a side effect (see PtyTerminalProxy) — the name reflects
  // that this "resolve" step is not free to call speculatively.
  ensureEffectiveTarget(target: string): string
  write(data: string): void
  paste(data: string): void
  resize(cols: number, rows: number): void
  dispose(): Promise<void>
  isReady(): boolean
  getClientTty(): string | null
  getCurrentWindow(): string | null
  getSessionName(): string
  getMode(): 'pty' | 'pipe-pane' | 'ssh'
}

export type {
  SpawnFn,
  SpawnSyncFn,
  SpawnAsyncFn,
  SpawnAsyncResult,
  WaitFn,
  TerminalMode,
  TerminalProxyOptions,
  ITerminalProxy,
}
export { TerminalState, TerminalProxyError }
