import type { DirectoryErrorResponse, ResumeError, TerminalErrorCode } from '@shared/types'

export interface ApiErrorPayload {
  error?: string
  message?: string
}

const DEFAULT_SERVER_ERROR = 'Something went wrong. Try again.'
const DEFAULT_DIRECTORY_ERROR = 'Could not load this directory. Try again.'
const DEFAULT_PREVIEW_ERROR = 'Could not load the session preview. Try again.'

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/^[A-Z0-9_]+:\s+/, '')
}

function getBestPayloadMessage(payload?: ApiErrorPayload | null): string | null {
  return cleanText(payload?.message) ?? cleanText(payload?.error)
}

function includesText(value: string | null | undefined, fragment: string): boolean {
  return (value ?? '').toLowerCase().includes(fragment.toLowerCase())
}

export function isLikelyNetworkError(message?: string | null): boolean {
  if (!message) return false
  const normalized = message.toLowerCase()
  return (
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('network request failed') ||
    normalized.includes('load failed')
  )
}

export function toApiErrorPayload(value: unknown): ApiErrorPayload | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const error = cleanText(record.error)
  const message = cleanText(record.message)
  if (!error && !message) {
    return null
  }

  return {
    ...(error ? { error } : {}),
    ...(message ? { message } : {}),
  }
}

export function formatResumeError(error?: ResumeError | null): string {
  if (!error) {
    return 'Could not resume this session. Try again.'
  }

  if (error.code === 'NOT_FOUND') {
    return 'Session was not found. Refresh the list and try again.'
  }

  if (error.code === 'ALREADY_ACTIVE') {
    return 'Session is already active. Select it from the active list.'
  }

  if (error.code === 'RESUME_FAILED') {
    return 'Could not resume this session. Try again in a moment.'
  }

  return cleanText(error.message) ?? 'Could not resume this session. Try again.'
}

const terminalCodeMessages: Record<TerminalErrorCode, string> = {
  ERR_INVALID_WINDOW: 'This terminal window no longer exists. Reopen the session.',
  ERR_SESSION_CREATE_FAILED: 'Could not start the terminal. Try creating the session again.',
  ERR_START_TIMEOUT: 'Terminal startup timed out. Try reconnecting.',
  ERR_TMUX_ATTACH_FAILED: 'Could not attach to the session terminal. Try reconnecting.',
  ERR_TMUX_SWITCH_FAILED: 'Could not switch terminal windows. Try reconnecting.',
  ERR_TTY_DISCOVERY_TIMEOUT: 'Terminal discovery timed out. Try reconnecting.',
  ERR_NOT_READY: 'Terminal is still starting. Try again in a moment.',
}

export function formatTerminalError(params: {
  code?: TerminalErrorCode | string | null
  message?: string | null
  retryable?: boolean
}): string {
  const { code, message } = params
  if (code && code in terminalCodeMessages) {
    return terminalCodeMessages[code as TerminalErrorCode]
  }

  const cleaned = cleanText(message)
  if (cleaned && !isLikelyNetworkError(cleaned)) {
    return cleaned
  }

  return 'Terminal is unavailable right now. Try reconnecting.'
}

export function formatServerError(message?: string | null): string {
  const cleaned = cleanText(message)
  if (!cleaned || isLikelyNetworkError(cleaned)) {
    return DEFAULT_SERVER_ERROR
  }
  return cleaned
}

export function formatKillFailedError(message?: string | null): string {
  if (includesText(message, 'remote control') && includesText(message, 'disabled')) {
    return 'Remote sessions cannot be closed because remote control is disabled.'
  }
  if (includesText(message, 'not found') || includesText(message, 'no such')) {
    return 'Session was not found. Refresh the list and try again.'
  }
  if (includesText(message, 'permission denied') || includesText(message, 'not permitted')) {
    return 'Permission denied while closing the session. Check access and try again.'
  }

  return cleanText(message) ?? 'Could not close the session. Try again.'
}

export function formatSessionPinError(error?: string | null): string {
  if (includesText(error, 'not found')) {
    return 'Session was not found. Refresh the list and try again.'
  }
  if (includesText(error, 'permission denied') || includesText(error, 'not permitted')) {
    return 'Permission denied while updating pin state. Try again.'
  }

  return cleanText(error) ?? 'Could not update pin state. Try again.'
}

export function formatDirectoryError(params: {
  status?: number
  payload?: Partial<DirectoryErrorResponse> | ApiErrorPayload | null
  message?: string | null
  isNetworkError?: boolean
}): string {
  const { status, payload, message, isNetworkError } = params
  const payloadMessage = getBestPayloadMessage(payload as ApiErrorPayload | null)
  const code = cleanText((payload as DirectoryErrorResponse | null)?.error)?.toLowerCase()

  if (isNetworkError || isLikelyNetworkError(message) || isLikelyNetworkError(payloadMessage)) {
    return 'Could not reach the server. Check your connection and try again.'
  }

  if (code === 'invalid_path' || status === 400) {
    if (includesText(payloadMessage, 'too long')) {
      return 'That path is too long. Enter a shorter path.'
    }
    return 'Enter a valid directory path and try again.'
  }

  if (code === 'forbidden' || status === 403) {
    return 'You do not have permission to open this directory. Choose another folder.'
  }

  if (code === 'not_found' || status === 404) {
    return 'Directory not found. Check the path and try again.'
  }

  if (code === 'internal_error' || status === 500) {
    return 'Could not load this directory right now. Try again.'
  }

  return payloadMessage ?? cleanText(message) ?? DEFAULT_DIRECTORY_ERROR
}

export function formatPreviewError(params: {
  status?: number
  payload?: ApiErrorPayload | null
  message?: string | null
  isNetworkError?: boolean
}): string {
  const { status, payload, message, isNetworkError } = params
  const payloadMessage = getBestPayloadMessage(payload)
  const lower = (payloadMessage ?? '').toLowerCase()

  if (isNetworkError || isLikelyNetworkError(message) || isLikelyNetworkError(payloadMessage)) {
    return 'Could not load the session preview. Check your connection and try again.'
  }

  if (status === 400 || includesText(lower, 'invalid session id')) {
    return 'This session id is invalid. Close the preview and try again.'
  }

  if (status === 404 || includesText(lower, 'not found') || includesText(lower, 'no log file')) {
    if (includesText(lower, 'no log file') || includesText(lower, 'log file not found')) {
      return 'No log file is available for this session yet.'
    }

    if (includesText(lower, 'session not found')) {
      return 'Session was not found. Refresh the list and try again.'
    }

    return 'Preview data is missing for this session.'
  }

  if (status === 500 || includesText(lower, 'unable to read log file')) {
    return 'Log preview is unavailable right now. Try again in a moment.'
  }

  return payloadMessage ?? cleanText(message) ?? DEFAULT_PREVIEW_ERROR
}
