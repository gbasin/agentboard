import { describe, expect, test } from 'bun:test'
import {
  formatDirectoryError,
  formatKillFailedError,
  formatPreviewError,
  formatResumeError,
  formatServerError,
  formatSessionPinError,
  formatTerminalError,
  isLikelyNetworkError,
  toApiErrorPayload,
} from '../utils/errorMessages'

describe('errorMessages utils', () => {
  test('formats resume errors by code', () => {
    expect(
      formatResumeError({ code: 'NOT_FOUND', message: 'Session not found' })
    ).toBe('Session was not found. Refresh the list and try again.')

    expect(
      formatResumeError({ code: 'ALREADY_ACTIVE', message: 'already active' })
    ).toBe('Session is already active. Select it from the active list.')
  })

  test('formats terminal errors by known code', () => {
    expect(
      formatTerminalError({ code: 'ERR_NOT_READY', message: 'ERR_NOT_READY: pending' })
    ).toBe('Terminal is still starting. Try again in a moment.')
  })

  test('formats server-side action errors', () => {
    expect(
      formatKillFailedError('remote control disabled for this host')
    ).toBe('Remote sessions cannot be closed because remote control is disabled.')
    expect(formatSessionPinError('Permission denied')).toBe(
      'Permission denied while updating pin state. Try again.'
    )
  })

  test('formats directory errors by status and code', () => {
    expect(
      formatDirectoryError({
        status: 404,
        payload: { error: 'not_found', message: 'Path does not exist' },
      })
    ).toBe('Directory not found. Check the path and try again.')

    expect(
      formatDirectoryError({
        status: 400,
        payload: { error: 'invalid_path', message: 'Path too long' },
      })
    ).toBe('That path is too long. Enter a shorter path.')
  })

  test('formats preview errors for known backend cases', () => {
    expect(
      formatPreviewError({
        status: 400,
        payload: { error: 'Invalid session id' },
      })
    ).toBe('This session id is invalid. Close the preview and try again.')

    expect(
      formatPreviewError({
        status: 404,
        payload: { error: 'No log file for session' },
      })
    ).toBe('No log file is available for this session yet.')

    expect(
      formatPreviewError({
        status: 500,
        payload: { error: 'Unable to read log file' },
      })
    ).toBe('Log preview is unavailable right now. Try again in a moment.')
  })

  test('uses deterministic fallbacks for generic and network failures', () => {
    expect(formatServerError('')).toBe('Something went wrong. Try again.')
    expect(
      formatDirectoryError({
        message: 'Failed to fetch',
        isNetworkError: isLikelyNetworkError('Failed to fetch'),
      })
    ).toBe('Could not reach the server. Check your connection and try again.')
    expect(
      formatPreviewError({
        message: 'Failed to fetch',
        isNetworkError: true,
      })
    ).toBe('Could not load the session preview. Check your connection and try again.')
  })

  test('normalizes error payloads safely', () => {
    expect(toApiErrorPayload({ error: 'Nope', message: 'Denied' })).toEqual({
      error: 'Nope',
      message: 'Denied',
    })
    expect(toApiErrorPayload('bad payload')).toBeNull()
    expect(toApiErrorPayload({ detail: 'missing keys' })).toBeNull()
  })
})
