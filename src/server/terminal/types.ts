import type { TerminalErrorCode } from '../../shared/types'

type SpawnFn = (
  args: string[],
  options: Parameters<typeof Bun.spawn>[1]
) => ReturnType<typeof Bun.spawn>

type SpawnSyncFn = (
  args: string[],
  options: Parameters<typeof Bun.spawnSync>[1]
) => ReturnType<typeof Bun.spawnSync>

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
  now?: () => number
  wait?: WaitFn
  monitorTargets?: boolean
  host?: string
  sshOptions?: string[]
  commandTimeoutMs?: number
}

interface ITerminalProxy {
  start(): Promise<void>
  switchTo(target: string, onReady?: () => void): Promise<boolean>
  write(data: string): void
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
  WaitFn,
  TerminalMode,
  TerminalProxyOptions,
  ITerminalProxy,
}
export { TerminalState, TerminalProxyError }
