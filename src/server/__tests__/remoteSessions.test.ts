import { beforeEach, describe, expect, test } from 'bun:test'
import {
  sanitizeForId,
  parseTmuxWindows,
  buildRemoteSessionId,
  toIsoFromSeconds,
  splitSshOptions,
  buildBatchCaptureCommand,
  parseBatchCaptureOutput,
  enrichSessionsWithStatus,
  cleanupRemoteContentCache,
  remoteContentCache,
} from '../remoteSessions'
import { isValidHostname } from '../config'
import type { Session } from '../../shared/types'

describe('parseTmuxWindows', () => {
  const defaultPrefix = 'agentboard'
  const noPrefixes: string[] = []

  test('parses valid tmux output with multiple windows', () => {
    const output = [
      'main\t0\t@1\twindow-name\t/home/user/project\t1706745600\t1706745000\tclaude',
      'main\t1\t@2\teditor\t/home/user/code\t1706745700\t1706745100\tvim',
    ].join('\n')

    const sessions = parseTmuxWindows('remote-host', output, defaultPrefix, noPrefixes)

    expect(sessions).toHaveLength(2)
    expect(sessions[0].id).toBe('remote:remote-host:main:@1')
    expect(sessions[0].name).toBe('main') // external sessions use sessionName
    expect(sessions[0].source).toBe('external')
    expect(sessions[0].tmuxWindow).toBe('main:@1')
    expect(sessions[0].projectPath).toBe('/home/user/project')
    expect(sessions[0].host).toBe('remote-host')
    expect(sessions[0].remote).toBe(true)
    expect(sessions[0].agentType).toBe('claude')

    expect(sessions[1].id).toBe('remote:remote-host:main:@2')
    expect(sessions[1].name).toBe('main') // external sessions use sessionName
    expect(sessions[1].source).toBe('external')
    expect(sessions[1].tmuxWindow).toBe('main:@2')
  })

  test('unwraps bash -lc/-lic wrappers from pane_start_command', () => {
    const output = [
      "main\t0\t@1\twindow-name\t/home/user/project\t1706745600\t1706745000\tbash -lic claude",
      "main\t1\t@2\teditor\t/home/user/code\t1706745700\t1706745100\tbash -lc 'claude --model opus'",
      "main\t2\t@3\tshell\t/home/user\t1706745800\t1706745200\tbash -lic bash",
    ].join('\n')

    const sessions = parseTmuxWindows('remote-host', output, defaultPrefix, noPrefixes)

    expect(sessions).toHaveLength(3)
    expect(sessions[0].command).toBe('claude')
    expect(sessions[0].agentType).toBe('claude')

    expect(sessions[1].command).toBe('claude --model opus')
    expect(sessions[1].agentType).toBe('claude')

    expect(sessions[2].command).toBe('bash')
    expect(sessions[2].agentType).toBeUndefined()
  })

  test('unwraps double-quoted pane_start_command from tmux', () => {
    // Some tmux versions wrap #{pane_start_command} in double quotes
    const output = [
      'main\t0\t@1\twindow-name\t/home/user/project\t1706745600\t1706745000\t"bash -lic claude"',
      'main\t1\t@2\teditor\t/home/user/code\t1706745700\t1706745100\t"bash -lic \'claude --model opus\'"',
      'main\t2\t@3\tshell\t/home/user\t1706745800\t1706745200\t"claude"',
    ].join('\n')

    const sessions = parseTmuxWindows('remote-host', output, defaultPrefix, noPrefixes)

    expect(sessions).toHaveLength(3)
    expect(sessions[0].command).toBe('claude')
    expect(sessions[0].agentType).toBe('claude')

    expect(sessions[1].command).toBe('claude --model opus')
    expect(sessions[1].agentType).toBe('claude')

    // Plain quoted command without bash wrapper — just strips quotes
    expect(sessions[2].command).toBe('claude')
    expect(sessions[2].agentType).toBe('claude')
  })

  test('skips malformed lines with fewer than 8 fields', () => {
    const output = [
      'incomplete\tline\tonly',
      'main\t0\t@1\twindow\t/path\t1706745600\t1706745000\tclaude',
      'also\tincomplete',
    ].join('\n')

    const sessions = parseTmuxWindows('host', output, defaultPrefix, noPrefixes)

    expect(sessions).toHaveLength(1)
    expect(sessions[0].name).toBe('main') // external session uses sessionName
  })

  test('handles empty output', () => {
    const sessions = parseTmuxWindows('host', '', defaultPrefix, noPrefixes)
    expect(sessions).toHaveLength(0)
  })

  test('handles whitespace-only output', () => {
    const sessions = parseTmuxWindows('host', '   \n  \n   ', defaultPrefix, noPrefixes)
    expect(sessions).toHaveLength(0)
  })

  test('handles lines with empty optional fields', () => {
    // Empty window name and command
    const output = 'session\t0\t@1\t\t/path\t1706745600\t1706745000\t'

    const sessions = parseTmuxWindows('host', output, defaultPrefix, noPrefixes)

    expect(sessions).toHaveLength(1)
    expect(sessions[0].name).toBe('session')
    expect(sessions[0].command).toBeUndefined()
  })

  test('uses fallback timestamp for invalid activity/created values', () => {
    const output = 'session\t0\t@1\twindow\t/path\tinvalid\tbadtime\tclaude'

    const before = Date.now()
    const sessions = parseTmuxWindows('host', output, defaultPrefix, noPrefixes)
    const after = Date.now()

    expect(sessions).toHaveLength(1)
    const activityTime = new Date(sessions[0].lastActivity).getTime()
    const createdTime = new Date(sessions[0].createdAt).getTime()

    expect(activityTime).toBeGreaterThanOrEqual(before)
    expect(activityTime).toBeLessThanOrEqual(after)
    expect(createdTime).toBeGreaterThanOrEqual(before)
    expect(createdTime).toBeLessThanOrEqual(after)
  })

  test('filters proxy sessions using tmuxSessionPrefix, not broad includes', () => {
    const output = [
      // This IS a proxy session for prefix "agentboard"
      'agentboard-ws-abc123\t0\t@1\tproxy\t/tmp\t1706745600\t1706745000\tssh',
      // This is NOT a proxy session — legitimate session name containing "-ws-"
      'my-ws-project\t0\t@2\twork\t/home/user\t1706745600\t1706745000\tclaude',
      // Normal session
      'dev\t0\t@3\tdev-win\t/home/user/dev\t1706745600\t1706745000\tclaude',
    ].join('\n')

    const sessions = parseTmuxWindows('host', output, 'agentboard', noPrefixes)

    expect(sessions).toHaveLength(2)
    expect(sessions[0].name).toBe('my-ws-project') // external uses sessionName
    expect(sessions[1].name).toBe('dev') // external uses sessionName
  })

  test('filters proxy sessions with custom tmuxSessionPrefix', () => {
    const output = [
      'myboard-ws-conn1\t0\t@1\tproxy\t/tmp\t1706745600\t1706745000\tssh',
      'agentboard-ws-conn2\t0\t@2\tproxy2\t/tmp\t1706745600\t1706745000\tssh',
      'main\t0\t@3\twork\t/home/user\t1706745600\t1706745000\tclaude',
    ].join('\n')

    // With prefix "myboard", only myboard-ws-* is filtered
    const sessions = parseTmuxWindows('host', output, 'myboard', noPrefixes)

    expect(sessions).toHaveLength(2)
    expect(sessions[0].name).toBe('agentboard-ws-conn2') // external uses sessionName
    expect(sessions[1].name).toBe('main') // external uses sessionName
  })

  test('includes all sessions when discoverPrefixes is empty', () => {
    const output = [
      'agentboard\t0\t@1\tmain-win\t/home\t1706745600\t1706745000\tclaude',
      'dev-project\t0\t@2\tdev-win\t/home\t1706745600\t1706745000\tclaude',
      'random\t0\t@3\trand-win\t/home\t1706745600\t1706745000\tvim',
    ].join('\n')

    const sessions = parseTmuxWindows('host', output, 'agentboard', [])

    expect(sessions).toHaveLength(3)
  })

  test('filters by discoverPrefixes, always includes tmuxSessionPrefix session', () => {
    const output = [
      'agentboard\t0\t@1\tmain-win\t/home\t1706745600\t1706745000\tclaude',
      'dev-project\t0\t@2\tdev-win\t/home\t1706745600\t1706745000\tclaude',
      'billy-work\t0\t@3\tbilly-win\t/home\t1706745600\t1706745000\tclaude',
      'random\t0\t@4\trand-win\t/home\t1706745600\t1706745000\tvim',
    ].join('\n')

    const sessions = parseTmuxWindows('host', output, 'agentboard', ['dev-', 'billy-'])

    expect(sessions).toHaveLength(3)
    expect(sessions.map(s => s.name)).toEqual(['main-win', 'dev-project', 'billy-work'])
  })

  test('excludes proxy sessions and non-matching sessions together', () => {
    const output = [
      'agentboard\t0\t@1\tmain-win\t/home\t1706745600\t1706745000\tclaude',
      'agentboard-ws-abc\t0\t@2\tproxy\t/tmp\t1706745600\t1706745000\tssh',
      'dev-project\t0\t@3\tdev-win\t/home\t1706745600\t1706745000\tclaude',
      'unrelated\t0\t@4\tother\t/home\t1706745600\t1706745000\tvim',
    ].join('\n')

    const sessions = parseTmuxWindows('host', output, 'agentboard', ['dev-'])

    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.name)).toEqual(['main-win', 'dev-project'])
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

  test('sanitizes unsafe characters in session name and suffix', () => {
    const id = buildRemoteSessionId('host', 'my session/test', '0', '@1')
    expect(id).toBe('remote:host:my_session_test:@1')
  })
})

describe('sanitizeForId', () => {
  test('passes through safe characters unchanged', () => {
    expect(sanitizeForId('abc-123_test.host:8080@user')).toBe('abc-123_test.host:8080@user')
  })

  test('replaces spaces with underscores', () => {
    expect(sanitizeForId('my session')).toBe('my_session')
  })

  test('replaces special characters with underscores', () => {
    expect(sanitizeForId('test/path;cmd&evil')).toBe('test_path_cmd_evil')
  })

  test('handles empty string', () => {
    expect(sanitizeForId('')).toBe('')
  })

  test('replaces multiple consecutive unsafe chars', () => {
    expect(sanitizeForId('a$$b')).toBe('a__b')
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

  test('handles double-quoted arguments with spaces', () => {
    const result = splitSshOptions('-o "ProxyCommand ssh -W %h:%p bastion"')
    expect(result).toEqual(['-o', 'ProxyCommand ssh -W %h:%p bastion'])
  })

  test('handles single-quoted arguments with spaces', () => {
    const result = splitSshOptions("-o 'ProxyCommand ssh -W %h:%p bastion'")
    expect(result).toEqual(['-o', 'ProxyCommand ssh -W %h:%p bastion'])
  })

  test('handles mixed quoted and unquoted arguments', () => {
    const result = splitSshOptions('-i ~/.ssh/id_rsa -o "ProxyCommand ssh -W %h:%p jump" -o BatchMode=yes')
    expect(result).toEqual(['-i', '~/.ssh/id_rsa', '-o', 'ProxyCommand ssh -W %h:%p jump', '-o', 'BatchMode=yes'])
  })

  test('handles multiple quoted arguments', () => {
    const result = splitSshOptions('-o "Option One" -o "Option Two"')
    expect(result).toEqual(['-o', 'Option One', '-o', 'Option Two'])
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

// Helper to create a minimal Session for testing
function makeSession(overrides: Partial<Session> & { id: string; tmuxWindow: string }): Session {
  return {
    name: 'test',
    projectPath: '/home/user/project',
    status: 'unknown',
    lastActivity: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    agentType: 'claude',
    source: 'external',
    host: 'remote-host',
    remote: true,
    ...overrides,
  }
}

describe('buildBatchCaptureCommand', () => {
  const SEP = '__TEST_SEP__'

  test('returns empty string for empty sessions', () => {
    expect(buildBatchCaptureCommand([], SEP)).toBe('')
  })

  test('generates command for a single session', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const cmd = buildBatchCaptureCommand(sessions, SEP)

    expect(cmd).toContain('tmux display-message -t main:0')
    expect(cmd).toContain("'#{pane_width} #{pane_height}'")
    expect(cmd).toContain('tmux capture-pane -t main:0 -p -J')
    expect(cmd).toContain(`echo ${SEP}`)
    expect(cmd).toContain('2>/dev/null')
  })

  test('generates batched command for multiple sessions', () => {
    const sessions = [
      makeSession({ id: 's1', tmuxWindow: 'main:0' }),
      makeSession({ id: 's2', tmuxWindow: 'dev:1' }),
    ]
    const cmd = buildBatchCaptureCommand(sessions, SEP)

    expect(cmd).toContain('tmux display-message -t main:0')
    expect(cmd).toContain('tmux capture-pane -t main:0 -p -J')
    expect(cmd).toContain('tmux display-message -t dev:1')
    expect(cmd).toContain('tmux capture-pane -t dev:1 -p -J')
    // Should have two separator echos
    const sepCount = cmd.split(SEP).length - 1
    expect(sepCount).toBe(2)
  })

  test('shell-quotes window targets with special characters', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: "my session:0" })]
    const cmd = buildBatchCaptureCommand(sessions, SEP)

    // shellQuote wraps strings with spaces in single quotes
    expect(cmd).toContain("'my session:0'")
  })
})

describe('parseBatchCaptureOutput', () => {
  const SEP = '__TEST_SEP__'

  test('parses single session capture', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const output = `120 40\n$ claude\nThinking about your request...\n${SEP}\n`

    const result = parseBatchCaptureOutput(output, sessions, SEP)

    expect(result.size).toBe(1)
    const pane = result.get('s1')!
    expect(pane.width).toBe(120)
    expect(pane.height).toBe(40)
    expect(pane.content).toContain('$ claude')
    expect(pane.content).toContain('Thinking about your request...')
  })

  test('parses multiple session captures', () => {
    const sessions = [
      makeSession({ id: 's1', tmuxWindow: 'main:0' }),
      makeSession({ id: 's2', tmuxWindow: 'dev:1' }),
    ]
    const output = [
      '80 24',
      'content for session 1',
      SEP,
      '200 50',
      'content for session 2',
      SEP,
    ].join('\n')

    const result = parseBatchCaptureOutput(output, sessions, SEP)

    expect(result.size).toBe(2)

    const pane1 = result.get('s1')!
    expect(pane1.width).toBe(80)
    expect(pane1.height).toBe(24)
    expect(pane1.content).toBe('content for session 1')

    const pane2 = result.get('s2')!
    expect(pane2.width).toBe(200)
    expect(pane2.height).toBe(50)
    expect(pane2.content).toBe('content for session 2')
  })

  test('skips empty segments (failed captures)', () => {
    const sessions = [
      makeSession({ id: 's1', tmuxWindow: 'main:0' }),
      makeSession({ id: 's2', tmuxWindow: 'dead:1' }),
      makeSession({ id: 's3', tmuxWindow: 'alive:2' }),
    ]
    // Second session failed (empty segment)
    const output = [
      '80 24',
      'content 1',
      SEP,
      '', // empty segment for dead window
      SEP,
      '100 30',
      'content 3',
      SEP,
    ].join('\n')

    const result = parseBatchCaptureOutput(output, sessions, SEP)

    expect(result.size).toBe(2)
    expect(result.has('s1')).toBe(true)
    expect(result.has('s2')).toBe(false)
    expect(result.has('s3')).toBe(true)
  })

  test('strips trailing empty lines from content', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const output = [
      '80 24',
      'actual content',
      '',
      '',
      '',
      SEP,
    ].join('\n')

    const result = parseBatchCaptureOutput(output, sessions, SEP)
    const pane = result.get('s1')!
    expect(pane.content).toBe('actual content')
  })

  test('takes last 30 lines of content', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const contentLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`)
    const output = ['80 24', ...contentLines, SEP].join('\n')

    const result = parseBatchCaptureOutput(output, sessions, SEP)
    const pane = result.get('s1')!
    const lines = pane.content.split('\n')
    expect(lines).toHaveLength(30)
    expect(lines[0]).toBe('line 21')
    expect(lines[29]).toBe('line 50')
  })

  test('defaults dimensions to 80x24 for invalid values', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const output = `bad dims\ncontent\n${SEP}\n`

    const result = parseBatchCaptureOutput(output, sessions, SEP)
    const pane = result.get('s1')!
    expect(pane.width).toBe(80)
    expect(pane.height).toBe(24)
  })

  test('handles empty output', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const result = parseBatchCaptureOutput('', sessions, SEP)
    expect(result.size).toBe(0)
  })
})

describe('enrichSessionsWithStatus', () => {
  beforeEach(() => {
    remoteContentCache.clear()
  })

  test('sets status to waiting on first capture (no previous cache)', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const captures = new Map([
      ['s1', { content: '$ claude\nReady for input', width: 80, height: 24 }],
    ])

    enrichSessionsWithStatus(sessions, captures, 1000, 4000)

    expect(sessions[0].status).toBe('waiting')
    expect(remoteContentCache.has('s1')).toBe(true)
  })

  test('sets status to working when content changes', () => {
    // First call — establishes cache
    const sessions1 = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const captures1 = new Map([
      ['s1', { content: 'initial content', width: 80, height: 24 }],
    ])
    enrichSessionsWithStatus(sessions1, captures1, 1000, 4000)
    expect(sessions1[0].status).toBe('waiting')

    // Second call — content changed
    const sessions2 = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const captures2 = new Map([
      ['s1', { content: 'new different content', width: 80, height: 24 }],
    ])
    enrichSessionsWithStatus(sessions2, captures2, 2000, 4000)

    expect(sessions2[0].status).toBe('working')
  })

  test('sets status to waiting when content unchanged and grace period expired', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const content = 'stable content'

    // First call
    const captures1 = new Map([['s1', { content, width: 80, height: 24 }]])
    enrichSessionsWithStatus(sessions, captures1, 1000, 4000)

    // Second call — content changed to establish hasEverChanged
    const captures2 = new Map([['s1', { content: 'changed!', width: 80, height: 24 }]])
    enrichSessionsWithStatus(sessions, captures2, 2000, 4000)

    // Third call — content stable, but within grace period
    const captures3 = new Map([['s1', { content: 'changed!', width: 80, height: 24 }]])
    enrichSessionsWithStatus(sessions, captures3, 3000, 4000)
    expect(sessions[0].status).toBe('working') // still within 4s grace

    // Fourth call — content stable, grace period expired
    const captures4 = new Map([['s1', { content: 'changed!', width: 80, height: 24 }]])
    enrichSessionsWithStatus(sessions, captures4, 7000, 4000)
    expect(sessions[0].status).toBe('waiting')
  })

  test('sets status to permission when prompt detected', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const content = '❯ 1. Yes\n2. No\nEsc to cancel'

    // First call — establishes cache
    const captures1 = new Map([
      ['s1', { content: 'initial', width: 80, height: 24 }],
    ])
    enrichSessionsWithStatus(sessions, captures1, 1000, 4000)

    // Second call — permission prompt, content unchanged (grace expired)
    const captures2 = new Map([
      ['s1', { content, width: 80, height: 24 }],
    ])
    enrichSessionsWithStatus(sessions, captures2, 10000, 4000)

    // The content changed from 'initial' to the prompt, so this is 'working'
    expect(sessions[0].status).toBe('working')

    // Third call — same permission prompt, unchanged, grace expired
    const captures3 = new Map([
      ['s1', { content, width: 80, height: 24 }],
    ])
    enrichSessionsWithStatus(sessions, captures3, 20000, 4000)

    expect(sessions[0].status).toBe('permission')
  })

  test('skips sessions without captures', () => {
    const sessions = [
      makeSession({ id: 's1', tmuxWindow: 'main:0' }),
      makeSession({ id: 's2', tmuxWindow: 'dev:1' }),
    ]
    // Only s1 has a capture
    const captures = new Map([
      ['s1', { content: 'content', width: 80, height: 24 }],
    ])

    enrichSessionsWithStatus(sessions, captures, 1000, 4000)

    expect(sessions[0].status).toBe('waiting')
    expect(sessions[1].status).toBe('unknown') // unchanged
  })

  test('updates remoteContentCache', () => {
    const sessions = [makeSession({ id: 's1', tmuxWindow: 'main:0' })]
    const captures = new Map([
      ['s1', { content: 'cached content', width: 100, height: 50 }],
    ])

    enrichSessionsWithStatus(sessions, captures, 5000, 4000)

    const cached = remoteContentCache.get('s1')!
    expect(cached.content).toBe('cached content')
    expect(cached.width).toBe(100)
    expect(cached.height).toBe(50)
    expect(cached.lastChanged).toBe(5000)
  })
})

describe('cleanupRemoteContentCache', () => {
  beforeEach(() => {
    remoteContentCache.clear()
  })

  test('removes entries not in active sessions', () => {
    remoteContentCache.set('s1', {
      content: 'a', width: 80, height: 24, lastChanged: 0, hasEverChanged: false,
    })
    remoteContentCache.set('s2', {
      content: 'b', width: 80, height: 24, lastChanged: 0, hasEverChanged: false,
    })
    remoteContentCache.set('s3', {
      content: 'c', width: 80, height: 24, lastChanged: 0, hasEverChanged: false,
    })

    const activeSessions = [
      makeSession({ id: 's1', tmuxWindow: 'main:0' }),
      makeSession({ id: 's3', tmuxWindow: 'dev:2' }),
    ]

    cleanupRemoteContentCache(activeSessions)

    expect(remoteContentCache.has('s1')).toBe(true)
    expect(remoteContentCache.has('s2')).toBe(false)
    expect(remoteContentCache.has('s3')).toBe(true)
  })

  test('clears all entries when no active sessions', () => {
    remoteContentCache.set('s1', {
      content: 'a', width: 80, height: 24, lastChanged: 0, hasEverChanged: false,
    })

    cleanupRemoteContentCache([])

    expect(remoteContentCache.size).toBe(0)
  })

  test('handles empty cache gracefully', () => {
    cleanupRemoteContentCache([
      makeSession({ id: 's1', tmuxWindow: 'main:0' }),
    ])

    expect(remoteContentCache.size).toBe(0)
  })
})
