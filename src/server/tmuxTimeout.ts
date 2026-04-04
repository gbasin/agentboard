export const TMUX_TIMEOUT_ERROR_CODE = 'tmux_timeout'

type ErrorWithCode = Error & { code?: string }

export class TmuxTimeoutError extends Error {
  code: typeof TMUX_TIMEOUT_ERROR_CODE

  constructor(command: string, timeoutMs: number) {
    super(`tmux ${command} timed out after ${timeoutMs}ms`)
    this.name = 'TmuxTimeoutError'
    this.code = TMUX_TIMEOUT_ERROR_CODE
  }
}

export function isTmuxTimeoutError(error: unknown): boolean {
  return (
    error instanceof TmuxTimeoutError ||
    (error instanceof Error &&
      (error as ErrorWithCode).code === TMUX_TIMEOUT_ERROR_CODE)
  )
}
