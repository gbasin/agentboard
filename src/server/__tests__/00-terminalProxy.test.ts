import { describe, expect, test } from 'bun:test'
import { TerminalProxy } from '../TerminalProxy'

function createSpawnStub() {
  const calls: Array<{ args: string[]; options: Parameters<typeof Bun.spawn>[1] }> =
    []
  let killed = false
  let exitResolver: (() => void) | null = null
  const exited = new Promise<void>((resolve) => {
    exitResolver = resolve
  })

  // Create a mock ReadableStream
  const createMockStream = () => {
    const chunks: Uint8Array[] = []
    let reading = false

    return {
      stream: {
        getReader: () => ({
          read: async () => {
            if (!reading) {
              reading = true
              return { done: false, value: new TextEncoder().encode('hello') }
            }
            return new Promise<{ done: boolean; value?: Uint8Array }>(() => {}) // Never resolve
          },
          releaseLock: () => {},
        }),
      } as ReadableStream<Uint8Array>,
      pushChunk: (data: string) => {
        chunks.push(new TextEncoder().encode(data))
      },
    }
  }

  const mockStream = createMockStream()

  const spawn = (args: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    calls.push({ args, options })
    return {
      stdout: mockStream.stream,
      exited,
      kill: () => {
        killed = true
      },
    } as unknown as ReturnType<typeof Bun.spawn>
  }

  return {
    spawn,
    calls,
    exited,
    resolveExit: () => exitResolver?.(),
    wasKilled: () => killed,
  }
}

// Mock Bun.spawnSync for tmux commands
const originalSpawnSync = Bun.spawnSync
const syncCalls: Array<{ args: string[] }> = []

function mockSpawnSync(args: string[], _options?: any) {
  syncCalls.push({ args })

  // Mock successful responses for tmux commands
  if (args[0] === 'tmux') {
    if (args[1] === 'pipe-pane' || args[1] === 'send-keys' || args[1] === 'resize-pane') {
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }
    if (args[1] === 'capture-pane') {
      return { exitCode: 0, stdout: Buffer.from('initial content\n'), stderr: Buffer.from('') }
    }
    if (args[1] === 'list-panes') {
      return { exitCode: 0, stdout: Buffer.from('%0'), stderr: Buffer.from('') }
    }
  }

  return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
}

describe('TerminalProxy', () => {
  test('spawns tail once and forwards data', async () => {
    syncCalls.length = 0
    Bun.spawnSync = mockSpawnSync as any

    const spawnStub = createSpawnStub()
    const received: string[] = []
    const proxy = new TerminalProxy(
      'agentboard:1',
      {
        onData: (data) => received.push(data),
      },
      { spawn: spawnStub.spawn }
    )

    proxy.start()
    proxy.start() // Should not spawn twice

    expect(spawnStub.calls).toHaveLength(1)
    expect(spawnStub.calls[0]?.args[0]).toBe('tail')
    expect(spawnStub.calls[0]?.args[1]).toBe('-f')

    // Check that pipe-pane was set up
    const pipePaneCall = syncCalls.find(c => c.args[1] === 'pipe-pane' && c.args[4] === '-o')
    expect(pipePaneCall).toBeDefined()

    // Wait for data to be received
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(received.length).toBeGreaterThan(0)

    Bun.spawnSync = originalSpawnSync
  })

  test('write uses tmux send-keys', () => {
    syncCalls.length = 0
    Bun.spawnSync = mockSpawnSync as any

    const spawnStub = createSpawnStub()
    const proxy = new TerminalProxy(
      'agentboard:2',
      { onData: () => {} },
      { spawn: spawnStub.spawn }
    )

    proxy.start()
    proxy.write('ls')

    // Check that send-keys was called
    const sendKeysCall = syncCalls.find(c =>
      c.args[0] === 'tmux' &&
      c.args[1] === 'send-keys' &&
      c.args[5] === 'ls'
    )
    expect(sendKeysCall).toBeDefined()

    Bun.spawnSync = originalSpawnSync
  })

  test('resize uses tmux resize-pane', () => {
    syncCalls.length = 0
    Bun.spawnSync = mockSpawnSync as any

    const spawnStub = createSpawnStub()
    const proxy = new TerminalProxy(
      'agentboard:3',
      { onData: () => {} },
      { spawn: spawnStub.spawn }
    )

    proxy.start()
    proxy.resize(120, 40)

    // Check that resize-pane was called with correct dimensions
    const resizeCall = syncCalls.find(c =>
      c.args[0] === 'tmux' &&
      c.args[1] === 'resize-pane' &&
      c.args[5] === '120' &&
      c.args[7] === '40'
    )
    expect(resizeCall).toBeDefined()

    Bun.spawnSync = originalSpawnSync
  })

  test('dispose kills process and cleans up', async () => {
    syncCalls.length = 0
    Bun.spawnSync = mockSpawnSync as any

    const spawnStub = createSpawnStub()
    let exitCount = 0
    const proxy = new TerminalProxy(
      'agentboard:4',
      {
        onData: () => {},
        onExit: () => {
          exitCount += 1
        },
      },
      { spawn: spawnStub.spawn }
    )

    proxy.start()
    proxy.dispose()

    expect(spawnStub.wasKilled()).toBe(true)

    // Check that pipe-pane was cleared (empty string argument)
    const clearPipeCall = syncCalls.find(c =>
      c.args[0] === 'tmux' &&
      c.args[1] === 'pipe-pane' &&
      c.args[4] === ''
    )
    expect(clearPipeCall).toBeDefined()

    spawnStub.resolveExit()
    await spawnStub.exited
    await Promise.resolve()

    expect(exitCount).toBe(1)

    Bun.spawnSync = originalSpawnSync
  })

  test('resize ignores errors', () => {
    const failingSpawnSync = (args: string[], _options?: any) => {
      if (args[1] === 'resize-pane') {
        throw new Error('resize-failed')
      }
      return mockSpawnSync(args, _options)
    }

    syncCalls.length = 0
    Bun.spawnSync = failingSpawnSync as any

    const spawnStub = createSpawnStub()
    const proxy = new TerminalProxy(
      'agentboard:5',
      { onData: () => {} },
      { spawn: spawnStub.spawn }
    )

    proxy.start()
    expect(() => proxy.resize(80, 24)).not.toThrow()

    Bun.spawnSync = originalSpawnSync
  })
})
