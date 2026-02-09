import { describe, expect, test } from 'bun:test'
import { shellQuote, SshTerminalProxy } from '../terminal/SshTerminalProxy'
import type { SpawnSyncFn, TerminalProxyOptions } from '../terminal/types'

// Subclass to expose protected runTmux for testing
class TestableSshProxy extends SshTerminalProxy {
  testRunTmux(args: string[]): string {
    return this.runTmux(args)
  }
}

function createOptions(
  overrides: Partial<TerminalProxyOptions> = {}
): TerminalProxyOptions {
  return {
    connectionId: 'conn-1',
    sessionName: 'agentboard-ws-conn-1',
    baseSession: '',
    host: 'remote-host',
    onData: () => {},
    ...overrides,
  }
}

function createMockSpawnSync(
  exitCode = 0,
  stdout = '',
  stderr = ''
): SpawnSyncFn & { calls: Array<{ args: string[]; options: unknown }> } {
  const calls: Array<{ args: string[]; options: unknown }> = []
  const fn = ((args: string[], options: unknown) => {
    calls.push({ args: [...args], options })
    return {
      exitCode,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
    } as ReturnType<typeof Bun.spawnSync>
  }) as SpawnSyncFn & { calls: Array<{ args: string[]; options: unknown }> }
  fn.calls = calls
  return fn
}

describe('shellQuote', () => {
  test('passes through safe strings without quoting', () => {
    expect(shellQuote('hello')).toBe('hello')
    expect(shellQuote('file.txt')).toBe('file.txt')
    expect(shellQuote('my-file_name')).toBe('my-file_name')
    expect(shellQuote('/path/to/file')).toBe('/path/to/file')
    expect(shellQuote('user@host')).toBe('user@host')
    expect(shellQuote('key=value')).toBe('key=value')
    expect(shellQuote('a+b')).toBe('a+b')
    expect(shellQuote('host:port')).toBe('host:port')
  })

  test('quotes strings containing spaces', () => {
    expect(shellQuote('hello world')).toBe("'hello world'")
    expect(shellQuote('path with spaces')).toBe("'path with spaces'")
  })

  test('quotes strings with shell metacharacters', () => {
    expect(shellQuote('echo;rm -rf')).toBe("'echo;rm -rf'")
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'")
    expect(shellQuote('`command`')).toBe("'`command`'")
    expect(shellQuote('a&b')).toBe("'a&b'")
    expect(shellQuote('a|b')).toBe("'a|b'")
    expect(shellQuote('a>b')).toBe("'a>b'")
    expect(shellQuote('a<b')).toBe("'a<b'")
  })

  test('escapes single quotes within strings', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote("can't stop")).toBe("'can'\\''t stop'")
  })

  test('handles empty string', () => {
    expect(shellQuote('')).toBe("''")
  })

  test('handles strings with only single quotes', () => {
    expect(shellQuote("'")).toBe("''\\'''")
  })

  test('quotes strings with newlines', () => {
    expect(shellQuote('line1\nline2')).toBe("'line1\nline2'")
  })

  test('quotes strings with tabs', () => {
    expect(shellQuote('col1\tcol2')).toBe("'col1\tcol2'")
  })

  test('handles tmux format strings', () => {
    expect(shellQuote('#{window_index}')).toBe("'#{window_index}'")
    expect(shellQuote('#{pane_width} #{pane_height}')).toBe(
      "'#{pane_width} #{pane_height}'"
    )
  })
})

describe('SshTerminalProxy', () => {
  describe('runTmux', () => {
    test('constructs SSH command with tmux args', () => {
      const mock = createMockSpawnSync(0, 'output\n')
      const proxy = new TestableSshProxy(
        createOptions({
          sshOptions: ['-o', 'BatchMode=yes'],
          spawnSync: mock,
        })
      )

      const result = proxy.testRunTmux(['list-windows', '-t', 'agentboard'])

      expect(result).toBe('output\n')
      expect(mock.calls).toHaveLength(1)
      const args = mock.calls[0].args
      expect(args[0]).toBe('ssh')
      expect(args).toContain('BatchMode=yes')
      expect(args).toContain('ControlMaster=no')
      expect(args).toContain('remote-host')
      // Last arg is the remote tmux command
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toBe('tmux list-windows -t agentboard')
    })

    test('shell-quotes tmux args with special characters', () => {
      const mock = createMockSpawnSync(0, '')
      const proxy = new TestableSshProxy(createOptions({ spawnSync: mock }))

      proxy.testRunTmux([
        'send-keys',
        '-t',
        'my session:0',
        'echo hello world',
      ])

      const remoteCmd =
        mock.calls[0].args[mock.calls[0].args.length - 1]
      expect(remoteCmd).toContain("'my session:0'")
      expect(remoteCmd).toContain("'echo hello world'")
    })

    test('throws on non-zero exit code', () => {
      const mock = createMockSpawnSync(1, '', 'connection refused')
      const proxy = new TestableSshProxy(createOptions({ spawnSync: mock }))

      expect(() => proxy.testRunTmux(['list-windows'])).toThrow(
        'connection refused'
      )
    })

    test('includes ControlMaster=no to prevent SSH multiplexing issues', () => {
      const mock = createMockSpawnSync(0, '')
      const proxy = new TestableSshProxy(
        createOptions({
          sshOptions: ['-o', 'ProxyJump=bastion'],
          spawnSync: mock,
        })
      )

      proxy.testRunTmux(['has-session', '-t', 'test'])

      const args = mock.calls[0].args
      const controlIdx = args.indexOf('ControlMaster=no')
      expect(controlIdx).toBeGreaterThan(0)
      expect(args[controlIdx - 1]).toBe('-o')
    })

    test('works with no SSH options', () => {
      const mock = createMockSpawnSync(0, 'ok')
      const proxy = new TestableSshProxy(
        createOptions({
          sshOptions: undefined,
          spawnSync: mock,
        })
      )

      proxy.testRunTmux(['has-session', '-t', 'agentboard'])

      const args = mock.calls[0].args
      expect(args[0]).toBe('ssh')
      expect(args).toContain('remote-host')
      expect(args).toContain('ControlMaster=no')
    })

    test('passes default timeout to spawnSync', () => {
      const mock = createMockSpawnSync(0, '')
      const proxy = new TestableSshProxy(createOptions({ spawnSync: mock }))

      proxy.testRunTmux(['list-windows'])

      const options = mock.calls[0].options as Record<string, unknown>
      expect(options.timeout).toBe(10_000)
    })

    test('passes custom commandTimeoutMs to spawnSync', () => {
      const mock = createMockSpawnSync(0, '')
      const proxy = new TestableSshProxy(createOptions({ spawnSync: mock, commandTimeoutMs: 5000 }))

      proxy.testRunTmux(['list-windows'])

      const options = mock.calls[0].options as Record<string, unknown>
      expect(options.timeout).toBe(5000)
    })
  })

  describe('getMode', () => {
    test('returns ssh', () => {
      const proxy = new TestableSshProxy(
        createOptions({ spawnSync: createMockSpawnSync(0, '') })
      )
      expect(proxy.getMode()).toBe('ssh')
    })
  })
})
