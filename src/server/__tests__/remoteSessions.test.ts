import { describe, expect, test } from 'bun:test'
import {
  parseTmuxWindows,
  buildRemoteSessionId,
  toIsoFromSeconds,
  splitSshOptions,
} from '../remoteSessions'
import { isValidHostname } from '../config'

describe('parseTmuxWindows', () => {
  test('parses valid tmux output with multiple windows', () => {
    const output = [
      'main\\t0\\t@1\\twindow-name\\t/home/user/project\\t1706745600\\t1706745000\\tclaude',
      'main\\t1\\t@2\\teditor\\t/home/user/code\\t1706745700\\t1706745100\\tvim',
    ].join('\n')

    const sessions = parseTmuxWindows('remote-host', output)

    expect(sessions).toHaveLength(2)
    expect(sessions[0].id).toBe('remote:remote-host:main:@1')
    expect(sessions[0].name).toBe('window-name')
    expect(sessions[0].tmuxWindow).toBe('main:0')
    expect(sessions[0].projectPath).toBe('/home/user/project')
    expect(sessions[0].host).toBe('remote-host')
    expect(sessions[0].remote).toBe(true)
    expect(sessions[0].agentType).toBe('claude')

    expect(sessions[1].id).toBe('remote:remote-host:main:@2')
    expect(sessions[1].name).toBe('editor')
    expect(sessions[1].tmuxWindow).toBe('main:1')
  })

  test('skips malformed lines with fewer than 8 fields', () => {
    const output = [
      'incomplete\\tline\\tonly',
      'main\\t0\\t@1\\twindow\\t/path\\t1706745600\\t1706745000\\tclaude',
      'also\\tincomplete',
    ].join('\n')

    const sessions = parseTmuxWindows('host', output)

    expect(sessions).toHaveLength(1)
    expect(sessions[0].name).toBe('window')
  })

  test('handles empty output', () => {
    const sessions = parseTmuxWindows('host', '')
    expect(sessions).toHaveLength(0)
  })

  test('handles whitespace-only output', () => {
    const sessions = parseTmuxWindows('host', '   \n  \n   ')
    expect(sessions).toHaveLength(0)
  })

  test('handles lines with empty optional fields', () => {
    // Empty window name and command
    const output = 'session\\t0\\t@1\\t\\t/path\\t1706745600\\t1706745000\\t'

    const sessions = parseTmuxWindows('host', output)

    expect(sessions).toHaveLength(1)
    // Should fall back to tmuxWindow format when window name is empty
    expect(sessions[0].name).toBe('session:0')
    expect(sessions[0].command).toBeUndefined()
  })

  test('uses fallback timestamp for invalid activity/created values', () => {
    const output = 'session\\t0\\t@1\\twindow\\t/path\\tinvalid\\tbadtime\\tclaude'

    const before = Date.now()
    const sessions = parseTmuxWindows('host', output)
    const after = Date.now()

    expect(sessions).toHaveLength(1)
    const activityTime = new Date(sessions[0].lastActivity).getTime()
    const createdTime = new Date(sessions[0].createdAt).getTime()

    expect(activityTime).toBeGreaterThanOrEqual(before)
    expect(activityTime).toBeLessThanOrEqual(after)
    expect(createdTime).toBeGreaterThanOrEqual(before)
    expect(createdTime).toBeLessThanOrEqual(after)
  })
})

describe('buildRemoteSessionId', () => {
  test('uses windowId when present', () => {
    const id = buildRemoteSessionId('host', 'session', '0', '@123')
    expect(id).toBe('remote:host:session:@123')
  })

  test('falls back to windowIndex when windowId is empty', () => {
    const id = buildRemoteSessionId('host', 'session', '5', '')
    expect(id).toBe('remote:host:session:5')
  })

  test('falls back to windowIndex when windowId is undefined', () => {
    const id = buildRemoteSessionId('host', 'session', '3', undefined)
    expect(id).toBe('remote:host:session:3')
  })

  test('trims whitespace from windowId', () => {
    const id = buildRemoteSessionId('host', 'session', '0', '  @456  ')
    expect(id).toBe('remote:host:session:@456')
  })
})

describe('toIsoFromSeconds', () => {
  test('converts unix seconds to ISO string', () => {
    const result = toIsoFromSeconds('1706745600', 0)
    expect(result).toBe('2024-02-01T00:00:00.000Z')
  })

  test('uses fallback for undefined value', () => {
    const fallback = 1706745600000
    const result = toIsoFromSeconds(undefined, fallback)
    expect(result).toBe('2024-02-01T00:00:00.000Z')
  })

  test('uses fallback for empty string', () => {
    const fallback = 1706745600000
    const result = toIsoFromSeconds('', fallback)
    expect(result).toBe('2024-02-01T00:00:00.000Z')
  })

  test('uses fallback for non-numeric value', () => {
    const fallback = 1706745600000
    const result = toIsoFromSeconds('invalid', fallback)
    expect(result).toBe('2024-02-01T00:00:00.000Z')
  })

  test('uses fallback for zero', () => {
    const fallback = 1706745600000
    const result = toIsoFromSeconds('0', fallback)
    expect(result).toBe('2024-02-01T00:00:00.000Z')
  })

  test('uses fallback for negative values', () => {
    const fallback = 1706745600000
    const result = toIsoFromSeconds('-100', fallback)
    expect(result).toBe('2024-02-01T00:00:00.000Z')
  })
})

describe('splitSshOptions', () => {
  test('splits space-separated options', () => {
    const result = splitSshOptions('-o BatchMode=yes -o ConnectTimeout=3')
    expect(result).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3'])
  })

  test('handles multiple spaces between options', () => {
    const result = splitSshOptions('-o   BatchMode=yes    -o ConnectTimeout=3')
    expect(result).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3'])
  })

  test('returns empty array for empty string', () => {
    expect(splitSshOptions('')).toEqual([])
  })

  test('returns empty array for whitespace-only string', () => {
    expect(splitSshOptions('   ')).toEqual([])
  })

  test('trims individual options', () => {
    const result = splitSshOptions(' -o  StrictHostKeyChecking=no ')
    expect(result).toEqual(['-o', 'StrictHostKeyChecking=no'])
  })
})

describe('isValidHostname', () => {
  test('accepts valid simple hostnames', () => {
    expect(isValidHostname('localhost')).toBe(true)
    expect(isValidHostname('my-server')).toBe(true)
    expect(isValidHostname('server1')).toBe(true)
    expect(isValidHostname('a')).toBe(true)
    expect(isValidHostname('A')).toBe(true)
  })

  test('accepts valid FQDNs', () => {
    expect(isValidHostname('host.example.com')).toBe(true)
    expect(isValidHostname('my-server.local')).toBe(true)
    expect(isValidHostname('sub.domain.example.org')).toBe(true)
  })

  test('accepts hostnames starting with digits (RFC 1123)', () => {
    expect(isValidHostname('123server')).toBe(true)
    expect(isValidHostname('1a2b3c')).toBe(true)
  })

  test('rejects hostnames starting with hyphen', () => {
    expect(isValidHostname('-invalid')).toBe(false)
    expect(isValidHostname('-')).toBe(false)
  })

  test('rejects hostnames ending with hyphen', () => {
    expect(isValidHostname('invalid-')).toBe(false)
  })

  test('rejects hostnames with spaces', () => {
    expect(isValidHostname('has space')).toBe(false)
    expect(isValidHostname(' leading')).toBe(false)
    expect(isValidHostname('trailing ')).toBe(false)
  })

  test('rejects hostnames with special characters', () => {
    expect(isValidHostname('special;char')).toBe(false)
    expect(isValidHostname('has@symbol')).toBe(false)
    expect(isValidHostname('under_score')).toBe(false)
  })

  test('rejects empty string', () => {
    expect(isValidHostname('')).toBe(false)
  })

  test('rejects hostnames exceeding 253 characters', () => {
    const longHostname = 'a'.repeat(254)
    expect(isValidHostname(longHostname)).toBe(false)
  })

  test('accepts hostname at exactly 253 characters', () => {
    // Create a valid 253-char hostname with proper label lengths
    // 63 + 1 + 63 + 1 + 63 + 1 + 61 = 253
    const label = 'a'.repeat(63)
    const hostname = `${label}.${label}.${label}.${'a'.repeat(61)}`
    expect(hostname.length).toBe(253)
    expect(isValidHostname(hostname)).toBe(true)
  })

  test('rejects labels exceeding 63 characters', () => {
    const longLabel = 'a'.repeat(64)
    expect(isValidHostname(longLabel)).toBe(false)
  })
})
